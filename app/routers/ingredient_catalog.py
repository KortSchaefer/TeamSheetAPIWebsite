from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import (
    Ingredient,
    IngredientCatalogImport,
    IngredientLineage,
    InventoryItem,
    User,
)
from app.services.ingredient_catalog import (
    CatalogValidationError,
    import_default_catalog,
    normalize_name,
)


router = APIRouter(prefix="/ingredient-catalog", tags=["ingredient catalog"])


def _serialize_items(
    db: Session, ingredients: list[Ingredient]
) -> list[schemas.IngredientCatalogItemRead]:
    ingredient_ids = [ingredient.id for ingredient in ingredients]
    parent_ids: dict[int, list[str]] = {ingredient_id: [] for ingredient_id in ingredient_ids}
    child_ids: dict[int, list[str]] = {ingredient_id: [] for ingredient_id in ingredient_ids}
    if ingredient_ids:
        parent_rows = (
            db.query(IngredientLineage, Ingredient.external_id)
            .join(Ingredient, Ingredient.id == IngredientLineage.parent_ingredient_id)
            .filter(IngredientLineage.child_ingredient_id.in_(ingredient_ids))
            .order_by(IngredientLineage.child_ingredient_id, IngredientLineage.order_index)
            .all()
        )
        for link, external_id in parent_rows:
            if external_id:
                parent_ids[link.child_ingredient_id].append(external_id)

        child_rows = (
            db.query(IngredientLineage, Ingredient.external_id)
            .join(Ingredient, Ingredient.id == IngredientLineage.child_ingredient_id)
            .filter(IngredientLineage.parent_ingredient_id.in_(ingredient_ids))
            .order_by(IngredientLineage.parent_ingredient_id, Ingredient.name)
            .all()
        )
        for link, external_id in child_rows:
            if external_id:
                child_ids[link.parent_ingredient_id].append(external_id)

    activated = {
        ingredient_id: inventory_item_id
        for ingredient_id, inventory_item_id in db.query(
            InventoryItem.ingredient_id, InventoryItem.id
        )
        .filter(InventoryItem.ingredient_id.in_(ingredient_ids))
        .all()
    }
    return [
        schemas.IngredientCatalogItemRead(
            id=ingredient.id,
            external_id=ingredient.external_id,
            name=ingredient.name,
            normalized_name=ingredient.normalized_name or normalize_name(ingredient.name),
            category=ingredient.category,
            stage=ingredient.stage,
            process=ingredient.process,
            added_to_complete_lineage=ingredient.added_to_complete_lineage,
            source_correction=ingredient.source_correction,
            resolution_needed=ingredient.resolution_needed,
            catalog_schema_version=ingredient.catalog_schema_version,
            parent_ids=parent_ids[ingredient.id],
            child_ids=child_ids[ingredient.id],
            activated_inventory_item_id=activated.get(ingredient.id),
        )
        for ingredient in ingredients
    ]


@router.get("", response_model=schemas.IngredientCatalogListRead)
def list_catalog(
    search: str | None = Query(default=None, min_length=1, max_length=150),
    category: str | None = Query(default=None),
    stage: str | None = Query(default=None),
    requires_confirmation: bool | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Ingredient).filter(
        Ingredient.external_id.is_not(None),
        Ingredient.active.is_(True),
    )
    if search:
        normalized_search = normalize_name(search)
        query = query.filter(
            or_(
                Ingredient.normalized_name.contains(normalized_search),
                Ingredient.external_id.contains(normalized_search.replace(" ", "_")),
            )
        )
    if category:
        query = query.filter(Ingredient.category == category)
    if stage:
        query = query.filter(Ingredient.stage == stage)
    if requires_confirmation is not None:
        confirmation_filter = or_(
            Ingredient.resolution_needed.is_not(None),
            Ingredient.stage == "unresolved",
        )
        query = query.filter(
            confirmation_filter if requires_confirmation else ~confirmation_filter
        )

    total = query.count()
    ingredients = (
        query.order_by(Ingredient.category, Ingredient.name)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return {
        "items": _serialize_items(db, ingredients),
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/metadata")
def catalog_metadata(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    latest_import = (
        db.query(IngredientCatalogImport)
        .order_by(IngredientCatalogImport.created_at.desc())
        .first()
    )
    if latest_import is None:
        raise HTTPException(status_code=404, detail="Ingredient catalog has not been imported")
    categories = [
        value
        for (value,) in db.query(Ingredient.category)
        .filter(Ingredient.external_id.is_not(None), Ingredient.category.is_not(None))
        .distinct()
        .order_by(Ingredient.category)
        .all()
    ]
    stages = [
        value
        for (value,) in db.query(Ingredient.stage)
        .filter(Ingredient.external_id.is_not(None), Ingredient.stage.is_not(None))
        .distinct()
        .order_by(Ingredient.stage)
        .all()
    ]
    return {
        "schema_version": latest_import.schema_version,
        "source_name": latest_import.source_name,
        "source_sha256": latest_import.source_sha256,
        "item_count": latest_import.item_count,
        "relationship_count": latest_import.relationship_count,
        "categories": categories,
        "stages": stages,
        **(latest_import.catalog_metadata or {}),
    }


@router.post("/import-default", response_model=schemas.IngredientCatalogImportRead)
def import_bundled_catalog(
    dry_run: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    try:
        return import_default_catalog(db, dry_run=dry_run)
    except CatalogValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{external_id}", response_model=schemas.IngredientCatalogItemRead)
def catalog_item(
    external_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ingredient = (
        db.query(Ingredient)
        .filter(Ingredient.external_id == external_id, Ingredient.active.is_(True))
        .first()
    )
    if ingredient is None:
        raise HTTPException(status_code=404, detail="Catalog ingredient not found")
    return _serialize_items(db, [ingredient])[0]
