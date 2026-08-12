from copy import deepcopy
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin
from app.database import get_db
from app.models import (
    MenuCategory,
    MenuItem,
    POSBehaviorRule,
    POSButton,
    POSButtonModifierGroup,
    POSButtonPrompt,
    POSButtonTag,
    POSCheckProgress,
    POSModifier,
    POSModifierGroup,
    POSOrder,
    POSOrderItem,
    POSPage,
    POSPrompt,
    POSTag,
    POSTagModifierGroup,
    POSTagPrompt,
    RecipeItem,
    User,
)
from app.services.pos_configuration import (
    audit,
    configuration_bundle,
    find_resolved_button,
    permissions_for,
    recent_audit,
    validate_modifier_selections,
)
from app.services.pos_terminal import (
    POSPrincipal,
    current_check,
    get_accessible_table,
    get_current_pos_principal,
    serialize_table,
)


router = APIRouter(prefix="/pos", tags=["pos-configuration"])


def _integrity_error(exc: IntegrityError) -> HTTPException:
    detail = "POS configuration conflicts with an existing record"
    if "UNIQUE constraint failed" in str(exc.orig):
        detail = "A POS record with that key already exists"
    return HTTPException(status_code=409, detail=detail)


def _commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise _integrity_error(exc) from exc


def _page_snapshot(row: POSPage) -> dict:
    return {
        "id": row.id,
        "slug": row.slug,
        "name": row.name,
        "description": row.description,
        "active": row.active,
        "display_order": row.display_order,
        "metadata": row.metadata_json or {},
    }


def _rule_snapshot(row: POSBehaviorRule) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "scope_type": row.scope_type,
        "scope_id": row.scope_id,
        "condition": row.condition,
        "action": row.action,
        "priority": row.priority,
        "active": row.active,
    }


def _get_or_404(db: Session, model, row_id: int, label: str):
    row = db.query(model).filter(model.id == row_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"{label} not found")
    return row


def _validate_ids(db: Session, model, values: set[int], label: str) -> None:
    if not values:
        return
    found = {value for (value,) in db.query(model.id).filter(model.id.in_(values)).all()}
    missing = values - found
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown {label}: {min(missing)}")


def _replace_button_assignments(db: Session, button: POSButton, payload: schemas.POSButtonUpsert) -> None:
    tag_ids = set(payload.tag_ids)
    group_ids = {row.id for row in payload.modifier_groups}
    prompt_ids = {row.id for row in payload.prompts}
    ingredient_ids = {row.ingredient_id for row in payload.ingredients}
    _validate_ids(db, POSTag, tag_ids, "tag")
    _validate_ids(db, POSModifierGroup, group_ids, "modifier group")
    _validate_ids(db, POSPrompt, prompt_ids, "prompt")
    from app.models import Ingredient
    _validate_ids(db, Ingredient, ingredient_ids, "ingredient")

    db.query(POSButtonTag).filter(POSButtonTag.button_id == button.id).delete(synchronize_session=False)
    db.query(POSButtonModifierGroup).filter(POSButtonModifierGroup.button_id == button.id).delete(synchronize_session=False)
    db.query(POSButtonPrompt).filter(POSButtonPrompt.button_id == button.id).delete(synchronize_session=False)
    db.query(RecipeItem).filter(RecipeItem.menu_item_id == button.menu_item_id).delete(synchronize_session=False)
    db.flush()
    for tag_id in tag_ids:
        db.add(POSButtonTag(button_id=button.id, tag_id=tag_id))
    for row in payload.modifier_groups:
        db.add(POSButtonModifierGroup(button_id=button.id, modifier_group_id=row.id, display_order=row.display_order, disabled=row.disabled, override_config=row.overrides))
    for row in payload.prompts:
        db.add(POSButtonPrompt(button_id=button.id, prompt_id=row.id, display_order=row.display_order, disabled=row.disabled, override_config=row.overrides))
    for row in payload.ingredients:
        db.add(RecipeItem(menu_item_id=button.menu_item_id, ingredient_id=row.ingredient_id, quantity=row.quantity, selection_type=row.selection_type, display_order=row.display_order))


def _apply_button_payload(button: POSButton, menu_item: MenuItem, payload: schemas.POSButtonUpsert) -> None:
    menu_item.name = payload.name
    menu_item.category_id = payload.category_id
    menu_item.price_cents = payload.price_cents
    menu_item.active = payload.active
    button.internal_key = payload.internal_key
    button.page_id = payload.page_id
    button.display_name = payload.display_name
    button.description = payload.description
    button.button_type = payload.button_type
    button.alternate_price_cents = payload.alternate_price_cents
    button.weight_value = payload.weight_value
    button.weight_unit = payload.weight_unit
    button.active = payload.active
    button.availability = payload.availability
    button.visual = payload.visual
    button.routing = payload.routing
    button.metadata_json = payload.metadata
    button.grid_row = payload.grid_row
    button.grid_column = payload.grid_column
    button.grid_width = payload.grid_width
    button.grid_height = payload.grid_height
    button.display_order = payload.display_order


@router.get("/admin/config/bootstrap")
def admin_config_bootstrap(
    include_deleted: bool = Query(default=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    bundle = configuration_bundle(db, include_deleted=include_deleted, resolve=False)
    bundle["permissions"] = permissions_for(current_user)
    bundle["audit"] = recent_audit(db, 50)
    return bundle


@router.post("/admin/config/pages", status_code=status.HTTP_201_CREATED)
def create_page(payload: schemas.POSPageUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = POSPage(**payload.model_dump(exclude={"metadata"}), metadata_json=payload.metadata)
    db.add(row)
    db.flush()
    after = _page_snapshot(row)
    audit(db, current_user, "PAGE_CREATED", "PAGE", row.id, None, after)
    _commit(db)
    return after


@router.put("/admin/config/pages/{page_id}")
def update_page(page_id: int, payload: schemas.POSPageUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSPage, page_id, "POS page")
    before = _page_snapshot(row)
    for key, value in payload.model_dump(exclude={"metadata"}).items():
        setattr(row, key, value)
    row.metadata_json = payload.metadata
    after = _page_snapshot(row)
    audit(db, current_user, "PAGE_CHANGED", "PAGE", row.id, before, after)
    _commit(db)
    return after


@router.delete("/admin/config/pages/{page_id}")
def disable_page(page_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSPage, page_id, "POS page")
    if db.query(POSPage).filter(POSPage.active.is_(True), POSPage.id != page_id).count() == 0:
        raise HTTPException(status_code=409, detail="At least one active POS page is required")
    before = _page_snapshot(row)
    row.active = False
    audit(db, current_user, "PAGE_DISABLED", "PAGE", row.id, before, _page_snapshot(row))
    _commit(db)
    return _page_snapshot(row)


@router.post("/admin/config/buttons", status_code=status.HTTP_201_CREATED)
def create_button(payload: schemas.POSButtonUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    _get_or_404(db, POSPage, payload.page_id, "POS page")
    if payload.category_id is not None:
        _get_or_404(db, MenuCategory, payload.category_id, "Menu category")
    if payload.menu_item_id is None:
        menu_item = MenuItem(name=payload.name, category_id=payload.category_id, price_cents=payload.price_cents, active=payload.active)
        db.add(menu_item)
        db.flush()
    else:
        menu_item = _get_or_404(db, MenuItem, payload.menu_item_id, "Menu item")
        if db.query(POSButton.id).filter(POSButton.menu_item_id == menu_item.id).first() is not None:
            raise HTTPException(status_code=409, detail="That menu item already has a POS button")
    button = POSButton(internal_key=payload.internal_key, menu_item_id=menu_item.id, page_id=payload.page_id, display_name=payload.display_name)
    db.add(button)
    db.flush()
    _apply_button_payload(button, menu_item, payload)
    _replace_button_assignments(db, button, payload)
    db.flush()
    audit(db, current_user, "BUTTON_CREATED", "BUTTON", button.id, None, {"id": button.id, "internal_key": button.internal_key, "display_name": button.display_name})
    _commit(db)
    return find_resolved_button(db, button.id)


@router.put("/admin/config/buttons/{button_id}")
def update_button(button_id: int, payload: schemas.POSButtonUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    button = _get_or_404(db, POSButton, button_id, "POS button")
    before = find_resolved_button(db, button.id)
    _get_or_404(db, POSPage, payload.page_id, "POS page")
    if payload.category_id is not None:
        _get_or_404(db, MenuCategory, payload.category_id, "Menu category")
    _apply_button_payload(button, button.menu_item, payload)
    _replace_button_assignments(db, button, payload)
    button.revision += 1
    db.flush()
    after = {"id": button.id, "internal_key": button.internal_key, "display_name": button.display_name, "revision": button.revision}
    action = "BUTTON_MOVED" if before["page_id"] != button.page_id or before["layout"] != {"row": button.grid_row, "column": button.grid_column, "width": button.grid_width, "height": button.grid_height, "display_order": button.display_order} else "BUTTON_CHANGED"
    audit(db, current_user, action, "BUTTON", button.id, before, after)
    _commit(db)
    return find_resolved_button(db, button.id)


@router.post("/admin/config/buttons/{button_id}/duplicate", status_code=status.HTTP_201_CREATED)
def duplicate_button(button_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    source = find_resolved_button(db, button_id)
    key_root = f"{source['internal_key']}-copy"
    key = key_root
    index = 2
    while db.query(POSButton.id).filter(POSButton.internal_key == key).first() is not None:
        key = f"{key_root}-{index}"
        index += 1
    payload = schemas.POSButtonUpsert(
        internal_key=key,
        name=f"{source['name']} Copy",
        display_name=f"{source['display_name']} Copy"[:100],
        description=source["description"],
        category_id=source["category_id"],
        page_id=source["page_id"],
        price_cents=source["price_cents"],
        alternate_price_cents=source["alternate_price_cents"],
        weight_value=source["weight_value"],
        weight_unit=source["weight_unit"],
        button_type=source["button_type"],
        active=source["active"],
        availability=deepcopy(source["availability"]),
        visual=deepcopy(source["visual"]),
        routing=deepcopy(source["routing"]),
        metadata=deepcopy(source["metadata"]),
        grid_row=source["layout"]["row"],
        grid_column=source["layout"]["column"],
        grid_width=source["layout"]["width"],
        grid_height=source["layout"]["height"],
        display_order=source["layout"]["display_order"] + 1,
        tag_ids=source["tag_ids"],
        modifier_groups=source["modifier_assignments"],
        prompts=source["prompt_assignments"],
        ingredients=source["ingredients"],
    )
    return create_button(payload, db, current_user)


@router.delete("/admin/config/buttons/{button_id}")
def delete_button(button_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    button = _get_or_404(db, POSButton, button_id, "POS button")
    before = {"active": button.active, "deleted_at": button.deleted_at, "revision": button.revision}
    button.active = False
    button.deleted_at = datetime.utcnow()
    button.revision += 1
    after = {"active": False, "deleted_at": button.deleted_at, "revision": button.revision}
    audit(db, current_user, "BUTTON_DELETED", "BUTTON", button.id, before, after)
    _commit(db)
    return after


@router.post("/admin/config/buttons/{button_id}/restore")
def restore_button(button_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    button = _get_or_404(db, POSButton, button_id, "POS button")
    before = {"active": button.active, "deleted_at": button.deleted_at, "revision": button.revision}
    button.active = True
    button.menu_item.active = True
    button.deleted_at = None
    button.revision += 1
    after = {"active": True, "deleted_at": None, "revision": button.revision}
    audit(db, current_user, "BUTTON_RESTORED", "BUTTON", button.id, before, after)
    _commit(db)
    return find_resolved_button(db, button.id)


@router.put("/admin/config/layout")
def update_layout(payload: schemas.POSLayoutUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    _validate_ids(db, POSPage, {entry.page_id for entry in payload.entries}, "page")
    buttons = {button.id: button for button in db.query(POSButton).filter(POSButton.id.in_([entry.button_id for entry in payload.entries])).all()}
    if len(buttons) != len({entry.button_id for entry in payload.entries}):
        raise HTTPException(status_code=404, detail="One or more POS buttons were not found")
    for entry in payload.entries:
        button = buttons[entry.button_id]
        if button.revision != entry.revision:
            raise HTTPException(status_code=409, detail=f"Button {button.id} was changed by another editor")
        before = {"page_id": button.page_id, "row": button.grid_row, "column": button.grid_column, "width": button.grid_width, "height": button.grid_height}
        button.page_id = entry.page_id
        button.grid_row = entry.grid_row
        button.grid_column = entry.grid_column
        button.grid_width = entry.grid_width
        button.grid_height = entry.grid_height
        button.display_order = entry.display_order
        button.revision += 1
        after = {"page_id": button.page_id, "row": button.grid_row, "column": button.grid_column, "width": button.grid_width, "height": button.grid_height, "revision": button.revision}
        audit(db, current_user, "BUTTON_MOVED", "BUTTON", button.id, before, after)
    _commit(db)
    return {"updated": len(buttons), "revisions": {str(button.id): button.revision for button in buttons.values()}}


def _replace_tag_assignments(db: Session, tag: POSTag, payload: schemas.POSTagUpsert) -> None:
    _validate_ids(db, POSModifierGroup, {row.id for row in payload.modifier_groups}, "modifier group")
    _validate_ids(db, POSPrompt, {row.id for row in payload.prompts}, "prompt")
    db.query(POSTagModifierGroup).filter(POSTagModifierGroup.tag_id == tag.id).delete(synchronize_session=False)
    db.query(POSTagPrompt).filter(POSTagPrompt.tag_id == tag.id).delete(synchronize_session=False)
    db.flush()
    for row in payload.modifier_groups:
        db.add(POSTagModifierGroup(tag_id=tag.id, modifier_group_id=row.id, display_order=row.display_order, override_config=row.overrides))
    for row in payload.prompts:
        db.add(POSTagPrompt(tag_id=tag.id, prompt_id=row.id, display_order=row.display_order, override_config=row.overrides))


def _upsert_tag(row: POSTag, payload: schemas.POSTagUpsert) -> None:
    for key, value in payload.model_dump(exclude={"modifier_groups", "prompts", "behavior"}).items():
        setattr(row, key, value)
    row.behavior = payload.behavior


@router.post("/admin/config/tags", status_code=status.HTTP_201_CREATED)
def create_tag(payload: schemas.POSTagUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = POSTag(slug=payload.slug, name=payload.name)
    db.add(row); db.flush(); _upsert_tag(row, payload); _replace_tag_assignments(db, row, payload)
    audit(db, current_user, "TAG_CREATED", "TAG", row.id, None, {"slug": row.slug, "name": row.name})
    _commit(db)
    return configuration_bundle(db)["tags"]


@router.put("/admin/config/tags/{tag_id}")
def update_tag(tag_id: int, payload: schemas.POSTagUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSTag, tag_id, "POS tag")
    before = {"slug": row.slug, "name": row.name, "active": row.active, "behavior": row.behavior}
    _upsert_tag(row, payload); _replace_tag_assignments(db, row, payload)
    audit(db, current_user, "TAG_CHANGED", "TAG", row.id, before, {"slug": row.slug, "name": row.name, "active": row.active, "behavior": row.behavior})
    _commit(db)
    return configuration_bundle(db)["tags"]


@router.delete("/admin/config/tags/{tag_id}")
def disable_tag(tag_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSTag, tag_id, "POS tag"); row.active = False
    audit(db, current_user, "TAG_DISABLED", "TAG", row.id, {"active": True}, {"active": False}); _commit(db)
    return {"id": row.id, "active": False}


def _apply_group(row: POSModifierGroup, payload: schemas.POSModifierGroupUpsert) -> None:
    for key, value in payload.model_dump(exclude={"modifiers", "metadata"}).items(): setattr(row, key, value)
    row.metadata_json = payload.metadata


def _replace_modifiers(db: Session, group: POSModifierGroup, payload: schemas.POSModifierGroupUpsert) -> None:
    db.query(POSModifier).filter(POSModifier.group_id == group.id).delete(synchronize_session=False); db.flush()
    for option in payload.modifiers:
        db.add(POSModifier(group_id=group.id, **option.model_dump(exclude={"id", "metadata"}), metadata_json=option.metadata))


@router.post("/admin/config/modifier-groups", status_code=status.HTTP_201_CREATED)
def create_group(payload: schemas.POSModifierGroupUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = POSModifierGroup(slug=payload.slug, name=payload.name); db.add(row); db.flush(); _apply_group(row, payload); _replace_modifiers(db, row, payload)
    audit(db, current_user, "MODIFIER_GROUP_CREATED", "MODIFIER_GROUP", row.id, None, {"slug": row.slug, "name": row.name}); _commit(db)
    return next(group for group in configuration_bundle(db)["modifier_groups"] if group["id"] == row.id)


@router.put("/admin/config/modifier-groups/{group_id}")
def update_group(group_id: int, payload: schemas.POSModifierGroupUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSModifierGroup, group_id, "Modifier group"); before = {"slug": row.slug, "name": row.name, "active": row.active}
    _apply_group(row, payload); _replace_modifiers(db, row, payload)
    audit(db, current_user, "MODIFIER_GROUP_CHANGED", "MODIFIER_GROUP", row.id, before, {"slug": row.slug, "name": row.name, "active": row.active}); _commit(db)
    return next(group for group in configuration_bundle(db)["modifier_groups"] if group["id"] == row.id)


@router.delete("/admin/config/modifier-groups/{group_id}")
def disable_group(group_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSModifierGroup, group_id, "Modifier group"); row.active = False
    audit(db, current_user, "MODIFIER_GROUP_DISABLED", "MODIFIER_GROUP", row.id, {"active": True}, {"active": False}); _commit(db)
    return {"id": row.id, "active": False}


@router.post("/admin/config/prompts", status_code=status.HTTP_201_CREATED)
def create_prompt(payload: schemas.POSPromptUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    if payload.modifier_group_id: _get_or_404(db, POSModifierGroup, payload.modifier_group_id, "Modifier group")
    row = POSPrompt(**payload.model_dump()); db.add(row); db.flush(); audit(db, current_user, "PROMPT_CREATED", "PROMPT", row.id, None, {"slug": row.slug, "name": row.name}); _commit(db)
    return next(value for value in configuration_bundle(db)["prompts"] if value["id"] == row.id)


@router.put("/admin/config/prompts/{prompt_id}")
def update_prompt(prompt_id: int, payload: schemas.POSPromptUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSPrompt, prompt_id, "Prompt"); before = {"slug": row.slug, "name": row.name, "active": row.active}
    for key, value in payload.model_dump().items(): setattr(row, key, value)
    audit(db, current_user, "PROMPT_CHANGED", "PROMPT", row.id, before, {"slug": row.slug, "name": row.name, "active": row.active}); _commit(db)
    return next(value for value in configuration_bundle(db)["prompts"] if value["id"] == row.id)


@router.post("/admin/config/rules", status_code=status.HTTP_201_CREATED)
def create_rule(payload: schemas.POSBehaviorRuleUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = POSBehaviorRule(**payload.model_dump()); db.add(row); db.flush(); audit(db, current_user, "RULE_CREATED", "RULE", row.id, None, _rule_snapshot(row)); _commit(db); return _rule_snapshot(row)


@router.put("/admin/config/rules/{rule_id}")
def update_rule(rule_id: int, payload: schemas.POSBehaviorRuleUpsert, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSBehaviorRule, rule_id, "Behavior rule"); before = _rule_snapshot(row)
    for key, value in payload.model_dump().items(): setattr(row, key, value)
    audit(db, current_user, "RULE_CHANGED", "RULE", row.id, before, _rule_snapshot(row)); _commit(db); return _rule_snapshot(row)


@router.delete("/admin/config/rules/{rule_id}")
def disable_rule(rule_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    row = _get_or_404(db, POSBehaviorRule, rule_id, "Behavior rule"); before = _rule_snapshot(row); row.active = False
    audit(db, current_user, "RULE_DISABLED", "RULE", row.id, before, _rule_snapshot(row)); _commit(db); return _rule_snapshot(row)


@router.get("/admin/config/audit")
def list_audit(limit: int = Query(default=100, ge=1, le=500), db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    return recent_audit(db, limit)


@router.get("/admin/config/export")
def export_config(db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    payload = configuration_bundle(db, include_deleted=True, resolve=False)
    return JSONResponse(payload, headers={"Content-Disposition": "attachment; filename=pos-configuration.json"})


@router.post("/admin/config/import")
def import_config(payload: schemas.POSConfigImportRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    config = payload.config
    required = {"schema_version", "pages", "buttons", "tags", "modifier_groups", "prompts", "rules"}
    missing = required - config.keys()
    if missing:
        raise HTTPException(status_code=422, detail=f"Missing configuration section: {sorted(missing)[0]}")
    if config["schema_version"] != 1:
        raise HTTPException(status_code=422, detail="Unsupported POS configuration schema_version")
    if not all(isinstance(config[key], list) for key in required - {"schema_version"}):
        raise HTTPException(status_code=422, detail="POS configuration sections must be arrays")
    summary = {key: len(config[key]) for key in required - {"schema_version"}}
    if payload.preview:
        return {"valid": True, "preview": True, "summary": summary, "warnings": ["Apply merges stable keys; it does not delete records omitted from the import."]}

    page_id_map: dict[int, int] = {}
    for value in config["pages"]:
        parsed = schemas.POSPageUpsert(**value)
        row = db.query(POSPage).filter(POSPage.slug == parsed.slug).first() or POSPage(slug=parsed.slug, name=parsed.name)
        if row.id is None: db.add(row); db.flush()
        old_id = value.get("id")
        for key, item in parsed.model_dump(exclude={"metadata"}).items(): setattr(row, key, item)
        row.metadata_json = parsed.metadata
        if old_id is not None: page_id_map[int(old_id)] = row.id
    db.flush()

    group_id_map: dict[int, int] = {}
    groups_by_old_id: dict[int, tuple[POSModifierGroup, dict]] = {}
    for value in config["modifier_groups"]:
        old_id = int(value["id"])
        row = db.query(POSModifierGroup).filter(POSModifierGroup.slug == value["slug"]).first()
        if row is None:
            row = POSModifierGroup(slug=value["slug"], name=value["name"])
            db.add(row); db.flush()
        group_id_map[old_id] = row.id
        groups_by_old_id[old_id] = (row, value)
    for old_id, (row, value) in groups_by_old_id.items():
        remapped = deepcopy(value)
        for option in remapped.get("modifiers", []):
            target = option.get("opens_modifier_group_id")
            option["opens_modifier_group_id"] = group_id_map.get(target) if target else None
            option.pop("id", None)
        parsed = schemas.POSModifierGroupUpsert(**remapped)
        _apply_group(row, parsed); _replace_modifiers(db, row, parsed)
    db.flush()

    prompt_id_map: dict[int, int] = {}
    for value in config["prompts"]:
        remapped = deepcopy(value)
        old_id = int(remapped.pop("id"))
        group_id = remapped.get("modifier_group_id")
        remapped["modifier_group_id"] = group_id_map.get(group_id) if group_id else None
        parsed = schemas.POSPromptUpsert(**remapped)
        row = db.query(POSPrompt).filter(POSPrompt.slug == parsed.slug).first()
        if row is None:
            row = POSPrompt(slug=parsed.slug, name=parsed.name, message=parsed.message)
            db.add(row); db.flush()
        for key, item in parsed.model_dump().items(): setattr(row, key, item)
        prompt_id_map[old_id] = row.id
    db.flush()

    tag_id_map: dict[int, int] = {}
    tag_rows: list[tuple[POSTag, dict]] = []
    for value in config["tags"]:
        old_id = int(value["id"])
        row = db.query(POSTag).filter(POSTag.slug == value["slug"]).first()
        if row is None:
            row = POSTag(slug=value["slug"], name=value["name"])
            db.add(row); db.flush()
        tag_id_map[old_id] = row.id
        tag_rows.append((row, value))
    for row, value in tag_rows:
        remapped = deepcopy(value)
        remapped["modifier_groups"] = [
            {**assignment, "id": group_id_map[assignment["id"]]}
            for assignment in value.get("modifier_groups", [])
            if assignment.get("id") in group_id_map
        ]
        remapped["prompts"] = [
            {**assignment, "id": prompt_id_map[assignment["id"]]}
            for assignment in value.get("prompts", [])
            if assignment.get("id") in prompt_id_map
        ]
        parsed = schemas.POSTagUpsert(**remapped)
        _upsert_tag(row, parsed); _replace_tag_assignments(db, row, parsed)
    db.flush()

    button_id_map: dict[int, int] = {}
    for value in config["buttons"]:
        old_id = int(value["id"])
        page_id = page_id_map.get(value["page_id"])
        if page_id is None:
            raise HTTPException(status_code=422, detail=f"Button {value['internal_key']} references an unknown page")
        category_id = value.get("category_id")
        if category_id and db.query(MenuCategory.id).filter(MenuCategory.id == category_id).first() is None:
            category_name = value.get("category") or "Imported"
            category = db.query(MenuCategory).filter(MenuCategory.name == category_name).first()
            if category is None:
                category = MenuCategory(name=category_name, active=True, display_order=0)
                db.add(category); db.flush()
            category_id = category.id
        layout = value.get("layout") or {}
        parsed = schemas.POSButtonUpsert(
            internal_key=value["internal_key"],
            name=value["name"],
            display_name=value["display_name"],
            description=value.get("description"),
            category_id=category_id,
            page_id=page_id,
            price_cents=value.get("price_cents", 0),
            alternate_price_cents=value.get("alternate_price_cents"),
            weight_value=value.get("weight_value"),
            weight_unit=value.get("weight_unit"),
            button_type=value.get("button_type", "PRODUCT"),
            active=value.get("active", True),
            availability=value.get("availability") or {},
            visual=value.get("visual") or {},
            routing=value.get("routing") or {},
            metadata=value.get("metadata") or {},
            grid_row=layout.get("row", 1), grid_column=layout.get("column", 1),
            grid_width=layout.get("width", 1), grid_height=layout.get("height", 1),
            display_order=layout.get("display_order", 0),
            tag_ids=[tag_id_map[tag_id] for tag_id in value.get("tag_ids", []) if tag_id in tag_id_map],
            modifier_groups=[
                {**assignment, "id": group_id_map[assignment["id"]]}
                for assignment in value.get("modifier_assignments", [])
                if assignment.get("id") in group_id_map
            ],
            prompts=[
                {**assignment, "id": prompt_id_map[assignment["id"]]}
                for assignment in value.get("prompt_assignments", [])
                if assignment.get("id") in prompt_id_map
            ],
            ingredients=value.get("ingredients", []),
        )
        button = db.query(POSButton).filter(POSButton.internal_key == parsed.internal_key).first()
        if button is None:
            menu_item = MenuItem(name=parsed.name, category_id=parsed.category_id, price_cents=parsed.price_cents, active=parsed.active)
            db.add(menu_item); db.flush()
            button = POSButton(internal_key=parsed.internal_key, menu_item_id=menu_item.id, page_id=parsed.page_id, display_name=parsed.display_name)
            db.add(button); db.flush()
        _apply_button_payload(button, button.menu_item, parsed)
        _replace_button_assignments(db, button, parsed)
        button.revision += 1
        button_id_map[old_id] = button.id
    db.flush()

    applied_rules = 0
    for value in config["rules"]:
        remapped = deepcopy(value)
        remapped.pop("id", None)
        if remapped.get("scope_type") == "TAG": remapped["scope_id"] = tag_id_map.get(remapped.get("scope_id"))
        if remapped.get("scope_type") == "BUTTON": remapped["scope_id"] = button_id_map.get(remapped.get("scope_id"))
        parsed = schemas.POSBehaviorRuleUpsert(**remapped)
        row = db.query(POSBehaviorRule).filter(POSBehaviorRule.name == parsed.name, POSBehaviorRule.scope_type == parsed.scope_type, POSBehaviorRule.scope_id == parsed.scope_id).first()
        if row is None:
            row = POSBehaviorRule(**parsed.model_dump()); db.add(row)
        else:
            for key, item in parsed.model_dump().items(): setattr(row, key, item)
        applied_rules += 1
    audit(db, current_user, "CONFIG_IMPORTED", "CONFIG", None, None, {"summary": summary})
    _commit(db)
    return {
        "valid": True,
        "preview": False,
        "summary": summary,
        "applied": {
            "pages": len(page_id_map), "modifier_groups": len(group_id_map),
            "prompts": len(prompt_id_map), "tags": len(tag_id_map),
            "buttons": len(button_id_map), "rules": applied_rules,
        },
        "warnings": ["Import is a non-destructive merge; records omitted from the file remain unchanged."],
    }


@router.post("/terminal/checks/{check_id}/items", status_code=status.HTTP_201_CREATED)
def add_terminal_item(
    check_id: int,
    payload: schemas.POSTerminalItemCreate,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    order = db.query(POSOrder).filter(POSOrder.id == check_id).first()
    if order is None or order.table_id is None:
        raise HTTPException(status_code=404, detail="POS check not found")
    table = get_accessible_table(db, principal, order.table_id)
    if current_check(table).id != order.id:
        raise HTTPException(status_code=404, detail="POS check not found")
    button = find_resolved_button(db, payload.button_id)
    modifier_total, modifier_snapshot = validate_modifier_selections(button, [row.model_dump() for row in payload.modifiers])
    item = POSOrderItem(
        order_id=order.id,
        menu_item_id=button["menu_item_id"],
        quantity=payload.quantity,
        price_cents=button["price_cents"],
        modifier_total_cents=modifier_total,
        display_name_snapshot=button["display_name"],
        configuration_snapshot={"button_id": button["id"], "button_revision": button["revision"], "modifiers": modifier_snapshot, "notes": payload.notes},
    )
    db.add(item)
    order.subtotal_cents += (button["price_cents"] + modifier_total) * payload.quantity
    order.total_cents = order.subtotal_cents + order.tax_cents + order.tip_cents
    order.progress = POSCheckProgress.FOOD_ORDERED
    table.progress = POSCheckProgress.FOOD_ORDERED
    table.revision += 1
    db.commit(); db.refresh(item)
    return {
        "id": item.id,
        "display_name": item.display_name_snapshot,
        "quantity": item.quantity,
        "price_cents": item.price_cents,
        "modifier_total_cents": item.modifier_total_cents,
        "configuration": item.configuration_snapshot,
        "check": serialize_table(table)["check"],
        "table_revision": table.revision,
    }
