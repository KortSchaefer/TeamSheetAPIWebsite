import re
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session, joinedload, selectinload

from app.models import (
    MenuCategory,
    MenuItem,
    POSBehaviorRule,
    POSButton,
    POSButtonModifierGroup,
    POSButtonPrompt,
    POSButtonTag,
    POSConfigAudit,
    POSModifier,
    POSModifierGroup,
    POSPage,
    POSPrompt,
    POSTag,
    POSTagModifierGroup,
    POSTagPrompt,
    RecipeItem,
    User,
)


POS_PERMISSIONS = (
    "pos.view",
    "pos.edit",
    "pos.create_button",
    "pos.delete_button",
    "pos.edit_layout",
    "pos.manage_modifiers",
    "pos.manage_tags",
    "pos.import_export",
    "pos.view_audit",
)


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "item"


def permissions_for(user: User) -> dict[str, bool]:
    allowed = user.role.value in {"ADMIN", "MANAGER"}
    return {permission: allowed for permission in POS_PERMISSIONS}


def audit(
    db: Session,
    user: User,
    action: str,
    entity_type: str,
    entity_id: int | None,
    before: dict | None,
    after: dict | None,
) -> None:
    db.add(
        POSConfigAudit(
            actor_user_id=user.id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before_value=before,
            after_value=after,
        )
    )


def ensure_legacy_pos_buttons(db: Session) -> None:
    categories = db.query(MenuCategory).order_by(MenuCategory.display_order, MenuCategory.id).all()
    pages_by_slug = {page.slug: page for page in db.query(POSPage).all()}
    changed = False
    for category in categories:
        slug = slugify(category.name)
        if slug not in pages_by_slug:
            page = POSPage(
                slug=slug,
                name=category.name,
                description=category.description,
                active=category.active,
                display_order=category.display_order,
                metadata_json={"legacy_category_id": category.id},
            )
            db.add(page)
            db.flush()
            pages_by_slug[slug] = page
            changed = True

    default_page = next(iter(pages_by_slug.values()), None)
    if default_page is None:
        default_page = POSPage(slug="menu", name="Menu", active=True, display_order=1)
        db.add(default_page)
        db.flush()
        pages_by_slug["menu"] = default_page
        changed = True

    configured_menu_item_ids = {
        value for (value,) in db.query(POSButton.menu_item_id).all()
    }
    items = db.query(MenuItem).filter(MenuItem.active.is_(True)).order_by(MenuItem.id).all()
    for item in items:
        if item.id in configured_menu_item_ids:
            continue
        page = default_page
        if item.category is not None:
            page = pages_by_slug.get(slugify(item.category.name), default_page)
        key = slugify(item.name)
        if db.query(POSButton.id).filter(POSButton.internal_key == key).first() is not None:
            key = f"{key}-{item.id}"
        count_on_page = db.query(POSButton.id).filter(POSButton.page_id == page.id).count()
        db.add(
            POSButton(
                internal_key=key,
                menu_item_id=item.id,
                page_id=page.id,
                display_name=item.name,
                active=item.active,
                display_order=count_on_page,
                grid_row=(count_on_page // 4) + 1,
                grid_column=(count_on_page % 4) + 1,
                visual={"type": "text", "background_color": "#dedede", "text_color": "#111111"},
            )
        )
        changed = True
    if changed:
        db.commit()


def _group_dict(group: POSModifierGroup, overrides: dict | None = None) -> dict:
    config = {
        "id": group.id,
        "slug": group.slug,
        "name": group.name,
        "prompt": group.prompt,
        "required": group.required,
        "minimum_selections": group.minimum_selections,
        "maximum_selections": group.maximum_selections,
        "allow_quantities": group.allow_quantities,
        "active": group.active,
        "conditional_visibility": group.conditional_visibility or {},
        "metadata": group.metadata_json or {},
        "modifiers": [
            {
                "id": option.id,
                "internal_key": option.internal_key,
                "name": option.name,
                "price_delta_cents": option.price_delta_cents,
                "default_selected": option.default_selected,
                "active": option.active,
                "display_order": option.display_order,
                "opens_modifier_group_id": option.opens_modifier_group_id,
                "conditional_visibility": option.conditional_visibility or {},
                "metadata": option.metadata_json or {},
            }
            for option in sorted(group.modifiers, key=lambda row: (row.display_order, row.id))
        ],
    }
    if overrides:
        for key in (
            "prompt",
            "required",
            "minimum_selections",
            "maximum_selections",
            "allow_quantities",
            "conditional_visibility",
        ):
            if key in overrides:
                config[key] = overrides[key]
    return config


def _prompt_dict(prompt: POSPrompt, overrides: dict | None = None) -> dict:
    result = {
        "id": prompt.id,
        "slug": prompt.slug,
        "name": prompt.name,
        "message": prompt.message,
        "modifier_group_id": prompt.modifier_group_id,
        "required": prompt.required,
        "active": prompt.active,
        "config": prompt.config or {},
    }
    if overrides:
        result.update({key: value for key, value in overrides.items() if key in {"message", "required", "config"}})
    return result


def _button_base(button: POSButton) -> dict:
    return {
        "id": button.id,
        "internal_key": button.internal_key,
        "menu_item_id": button.menu_item_id,
        "name": button.menu_item.name,
        "display_name": button.display_name,
        "description": button.description,
        "category_id": button.menu_item.category_id,
        "category": button.menu_item.category.name if button.menu_item.category else None,
        "page_id": button.page_id,
        "page": button.page.slug,
        "price_cents": button.menu_item.price_cents,
        "alternate_price_cents": button.alternate_price_cents,
        "weight_value": button.weight_value,
        "weight_unit": button.weight_unit,
        "button_type": button.button_type,
        "active": button.active,
        "deleted_at": button.deleted_at,
        "availability": button.availability or {},
        "visual": button.visual or {},
        "routing": button.routing or {},
        "metadata": button.metadata_json or {},
        "layout": {
            "row": button.grid_row,
            "column": button.grid_column,
            "width": button.grid_width,
            "height": button.grid_height,
            "display_order": button.display_order,
        },
        "revision": button.revision,
        "tag_ids": [link.tag_id for link in button.tag_links],
        "tags": [link.tag.slug for link in button.tag_links],
        "modifier_assignments": [
            {
                "id": link.modifier_group_id,
                "display_order": link.display_order,
                "disabled": link.disabled,
                "overrides": link.override_config or {},
            }
            for link in button.modifier_links
        ],
        "prompt_assignments": [
            {
                "id": link.prompt_id,
                "display_order": link.display_order,
                "disabled": link.disabled,
                "overrides": link.override_config or {},
            }
            for link in button.prompt_links
        ],
        "ingredients": [
            {
                "ingredient_id": recipe.ingredient_id,
                "name": recipe.ingredient.name,
                "quantity": recipe.quantity,
                "selection_type": recipe.selection_type,
                "display_order": recipe.display_order,
            }
            for recipe in sorted(button.menu_item.recipe_items, key=lambda row: (row.display_order, row.id))
        ],
    }


def resolved_button(
    button: POSButton,
    groups: dict[int, POSModifierGroup],
    prompts: dict[int, POSPrompt],
    rules: list[POSBehaviorRule],
) -> dict:
    result = _button_base(button)
    group_assignments: dict[int, dict[str, Any]] = {}
    prompt_assignments: dict[int, dict[str, Any]] = {}
    tag_ids = {link.tag_id for link in button.tag_links}

    for tag_link in button.tag_links:
        for link in tag_link.tag.modifier_links:
            group_assignments.setdefault(
                link.modifier_group_id,
                {"order": link.display_order, "overrides": link.override_config or {}, "source": f"tag:{tag_link.tag.slug}"},
            )
        for link in tag_link.tag.prompt_links:
            prompt_assignments.setdefault(
                link.prompt_id,
                {"order": link.display_order, "overrides": link.override_config or {}, "source": f"tag:{tag_link.tag.slug}"},
            )

    for link in button.modifier_links:
        if link.disabled:
            group_assignments.pop(link.modifier_group_id, None)
        else:
            group_assignments[link.modifier_group_id] = {
                "order": link.display_order,
                "overrides": link.override_config or {},
                "source": "button",
            }
    for link in button.prompt_links:
        if link.disabled:
            prompt_assignments.pop(link.prompt_id, None)
        else:
            prompt_assignments[link.prompt_id] = {
                "order": link.display_order,
                "overrides": link.override_config or {},
                "source": "button",
            }

    result["modifier_groups"] = []
    for group_id, assignment in sorted(group_assignments.items(), key=lambda item: (item[1]["order"], item[0])):
        group = groups.get(group_id)
        if group and group.active:
            value = _group_dict(group, assignment["overrides"])
            value["source"] = assignment["source"]
            result["modifier_groups"].append(value)

    result["prompts"] = []
    for prompt_id, assignment in sorted(prompt_assignments.items(), key=lambda item: (item[1]["order"], item[0])):
        prompt = prompts.get(prompt_id)
        if prompt and prompt.active:
            value = _prompt_dict(prompt, assignment["overrides"])
            value["source"] = assignment["source"]
            result["prompts"].append(value)

    result["rules"] = [
        {
            "id": rule.id,
            "name": rule.name,
            "condition": rule.condition,
            "action": rule.action,
            "priority": rule.priority,
        }
        for rule in rules
        if rule.active
        and (
            rule.scope_type == "GLOBAL"
            or (rule.scope_type == "BUTTON" and rule.scope_id == button.id)
            or (rule.scope_type == "TAG" and rule.scope_id in tag_ids)
        )
    ]
    return result


def configuration_bundle(db: Session, *, include_deleted: bool = True, resolve: bool = False) -> dict:
    ensure_legacy_pos_buttons(db)
    button_query = db.query(POSButton).options(
        joinedload(POSButton.menu_item).joinedload(MenuItem.category),
        joinedload(POSButton.page),
        joinedload(POSButton.menu_item).selectinload(MenuItem.recipe_items).joinedload(RecipeItem.ingredient),
        selectinload(POSButton.tag_links).joinedload(POSButtonTag.tag).selectinload(POSTag.modifier_links),
        selectinload(POSButton.tag_links).joinedload(POSButtonTag.tag).selectinload(POSTag.prompt_links),
        selectinload(POSButton.modifier_links),
        selectinload(POSButton.prompt_links),
    )
    if not include_deleted:
        button_query = button_query.filter(POSButton.deleted_at.is_(None), POSButton.active.is_(True))
    buttons = button_query.order_by(POSButton.page_id, POSButton.display_order, POSButton.id).all()
    groups_list = db.query(POSModifierGroup).options(selectinload(POSModifierGroup.modifiers)).order_by(POSModifierGroup.name).all()
    prompts_list = db.query(POSPrompt).order_by(POSPrompt.name).all()
    rules = db.query(POSBehaviorRule).order_by(POSBehaviorRule.priority, POSBehaviorRule.id).all()
    groups = {group.id: group for group in groups_list}
    prompts = {prompt.id: prompt for prompt in prompts_list}
    serialized_buttons = [
        resolved_button(button, groups, prompts, rules) if resolve else _button_base(button)
        for button in buttons
    ]
    pages = db.query(POSPage).order_by(POSPage.display_order, POSPage.name).all()
    tags = db.query(POSTag).options(selectinload(POSTag.modifier_links), selectinload(POSTag.prompt_links)).order_by(POSTag.name).all()
    return {
        "schema_version": 1,
        "pages": [
            {
                "id": page.id,
                "slug": page.slug,
                "name": page.name,
                "description": page.description,
                "active": page.active,
                "display_order": page.display_order,
                "metadata": page.metadata_json or {},
            }
            for page in pages
        ],
        "buttons": serialized_buttons,
        "tags": [
            {
                "id": tag.id,
                "slug": tag.slug,
                "name": tag.name,
                "description": tag.description,
                "color": tag.color,
                "active": tag.active,
                "behavior": tag.behavior or {},
                "modifier_groups": [
                    {"id": link.modifier_group_id, "display_order": link.display_order, "overrides": link.override_config or {}}
                    for link in tag.modifier_links
                ],
                "prompts": [
                    {"id": link.prompt_id, "display_order": link.display_order, "overrides": link.override_config or {}}
                    for link in tag.prompt_links
                ],
            }
            for tag in tags
        ],
        "modifier_groups": [_group_dict(group) for group in groups_list],
        "prompts": [_prompt_dict(prompt) for prompt in prompts_list],
        "rules": [
            {
                "id": rule.id,
                "name": rule.name,
                "scope_type": rule.scope_type,
                "scope_id": rule.scope_id,
                "condition": rule.condition,
                "action": rule.action,
                "priority": rule.priority,
                "active": rule.active,
            }
            for rule in rules
        ],
    }


def validate_modifier_selections(button_config: dict, selections: list[dict]) -> tuple[int, list[dict]]:
    quantities = {row["modifier_id"]: row["quantity"] for row in selections}
    selected_ids = set(quantities)
    total = 0
    snapshot: list[dict] = []
    allowed_ids: set[int] = set()
    for group in button_config["modifier_groups"]:
        options = {option["id"]: option for option in group["modifiers"] if option["active"]}
        allowed_ids.update(options)
        group_selected = selected_ids.intersection(options)
        count = sum(quantities[option_id] if group["allow_quantities"] else 1 for option_id in group_selected)
        minimum = max(1 if group["required"] else 0, group["minimum_selections"])
        if count < minimum or count > group["maximum_selections"]:
            raise HTTPException(
                status_code=422,
                detail=f"{group['name']} requires {minimum} to {group['maximum_selections']} selections",
            )
        for option_id in group_selected:
            option = options[option_id]
            quantity = quantities[option_id]
            if quantity > 1 and not group["allow_quantities"]:
                raise HTTPException(status_code=422, detail=f"{group['name']} does not allow modifier quantities")
            total += option["price_delta_cents"] * quantity
            snapshot.append(
                {
                    "modifier_id": option_id,
                    "group_id": group["id"],
                    "group_name": group["name"],
                    "name": option["name"],
                    "quantity": quantity,
                    "price_delta_cents": option["price_delta_cents"],
                }
            )
    unknown = selected_ids - allowed_ids
    if unknown:
        raise HTTPException(status_code=422, detail=f"Invalid modifier selection: {min(unknown)}")
    return total, snapshot


def find_resolved_button(db: Session, button_id: int) -> dict:
    bundle = configuration_bundle(db, include_deleted=False, resolve=True)
    button = next((row for row in bundle["buttons"] if row["id"] == button_id), None)
    if button is None:
        raise HTTPException(status_code=404, detail="POS button not found")
    return button


def recent_audit(db: Session, limit: int = 100) -> list[dict]:
    rows = db.query(POSConfigAudit).options(joinedload(POSConfigAudit.actor)).order_by(POSConfigAudit.created_at.desc()).limit(limit).all()
    return [
        {
            "id": row.id,
            "actor_user_id": row.actor_user_id,
            "actor_name": row.actor.full_name,
            "action": row.action,
            "entity_type": row.entity_type,
            "entity_id": row.entity_id,
            "before": row.before_value,
            "after": row.after_value,
            "created_at": row.created_at,
        }
        for row in rows
    ]
