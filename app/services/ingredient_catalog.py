import hashlib
import json
import unicodedata
from copy import deepcopy
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    Ingredient,
    IngredientCatalogImport,
    IngredientLineage,
    InventoryAliasSource,
    InventoryBalance,
    InventoryItem,
    InventoryItemAlias,
    InventoryLocation,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG_PATH = PROJECT_ROOT / "data" / "ingredient_catalog.json"
BAR_CATALOG_PATH = PROJECT_ROOT / "data" / "bar_inventory_catalog.json"
ITEM_FIELDS = {
    "id",
    "name",
    "category",
    "stage",
    "parent_ids",
    "process",
    "added_to_complete_lineage",
    "source_correction",
    "resolution_needed",
}


class CatalogValidationError(ValueError):
    pass


def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    return " ".join(normalized.casefold().split())


def load_catalog_file(path: Path = DEFAULT_CATALOG_PATH) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CatalogValidationError(f"Catalog file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CatalogValidationError(f"Catalog JSON is invalid: {exc}") from exc


def load_default_catalog() -> dict[str, Any]:
    """Load the core catalog plus bundled domain extensions as one validated graph."""
    payload = deepcopy(load_catalog_file(DEFAULT_CATALOG_PATH))
    model = payload["inventory_process_model"]
    extension = load_catalog_file(BAR_CATALOG_PATH)["inventory_process_model"]

    model["schema_version"] = extension.get(
        "schema_version", model["schema_version"]
    )
    model["items"].extend(extension.get("items", []))
    for field in ("important_parent_chains", "items_requiring_store_confirmation"):
        model.setdefault(field, [])
        model[field].extend(extension.get(field, []))
    return payload


def validate_catalog(payload: dict[str, Any]) -> dict[str, Any]:
    model = payload.get("inventory_process_model")
    if not isinstance(model, dict):
        raise CatalogValidationError("JSON must contain an inventory_process_model object")

    schema_version = model.get("schema_version")
    stage_definitions = model.get("stage_definitions")
    items = model.get("items")
    if not isinstance(schema_version, str) or not schema_version.strip():
        raise CatalogValidationError("schema_version must be a non-empty string")
    if not isinstance(stage_definitions, dict) or not stage_definitions:
        raise CatalogValidationError("stage_definitions must be a non-empty object")
    if not isinstance(items, list):
        raise CatalogValidationError("items must be an array")

    item_ids: set[str] = set()
    item_names: set[str] = set()
    relationships = 0
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise CatalogValidationError(f"items[{index}] must be an object")
        external_id = item.get("id")
        name = item.get("name")
        stage = item.get("stage")
        parent_ids = item.get("parent_ids")
        if not isinstance(external_id, str) or not external_id.strip():
            raise CatalogValidationError(f"items[{index}].id must be a non-empty string")
        if external_id in item_ids:
            raise CatalogValidationError(f"Duplicate item id: {external_id}")
        item_ids.add(external_id)
        if not isinstance(name, str) or not name.strip():
            raise CatalogValidationError(f"items[{index}].name must be a non-empty string")
        normalized_name = normalize_name(name)
        if normalized_name in item_names:
            raise CatalogValidationError(f"Duplicate normalized item name: {name}")
        item_names.add(normalized_name)
        if stage not in stage_definitions:
            raise CatalogValidationError(f"Unknown stage '{stage}' for item '{external_id}'")
        if not isinstance(parent_ids, list) or not all(isinstance(value, str) for value in parent_ids):
            raise CatalogValidationError(f"parent_ids for '{external_id}' must be an array of strings")
        if external_id in parent_ids:
            raise CatalogValidationError(f"Item '{external_id}' cannot be its own parent")
        relationships += len(parent_ids)

    missing_parents = sorted(
        {
            parent_id
            for item in items
            for parent_id in item["parent_ids"]
            if parent_id not in item_ids
        }
    )
    if missing_parents:
        raise CatalogValidationError(
            "Unknown parent ids: " + ", ".join(missing_parents)
        )

    graph = {item["id"]: item["parent_ids"] for item in items}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(external_id: str):
        if external_id in visiting:
            raise CatalogValidationError(
                f"Ingredient lineage contains a cycle at '{external_id}'"
            )
        if external_id in visited:
            return
        visiting.add(external_id)
        for parent_id in graph[external_id]:
            visit(parent_id)
        visiting.remove(external_id)
        visited.add(external_id)

    for external_id in graph:
        visit(external_id)

    return {
        "model": model,
        "schema_version": schema_version,
        "items": items,
        "item_count": len(items),
        "relationship_count": relationships,
    }


def catalog_checksum(payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _catalog_metadata(model: dict[str, Any]) -> dict[str, Any]:
    return {
        key: model[key]
        for key in (
            "stage_definitions",
            "relationship_rules",
            "important_parent_chains",
            "items_requiring_store_confirmation",
        )
        if key in model
    }


def import_catalog(
    db: Session,
    payload: dict[str, Any],
    *,
    source_name: str = "ingredient_catalog.json",
    dry_run: bool = False,
) -> dict[str, Any]:
    validated = validate_catalog(payload)
    checksum = catalog_checksum(payload)
    if dry_run:
        return {
            "schema_version": validated["schema_version"],
            "source_name": source_name,
            "source_sha256": checksum,
            "item_count": validated["item_count"],
            "relationship_count": validated["relationship_count"],
            "created": 0,
            "updated": 0,
            "unchanged": validated["item_count"],
            "dry_run": True,
        }

    items = validated["items"]
    external_ids = [item["id"] for item in items]
    existing_by_external_id = {
        ingredient.external_id: ingredient
        for ingredient in db.query(Ingredient)
        .filter(Ingredient.external_id.in_(external_ids))
        .all()
    }
    names = [item["name"] for item in items]
    existing_by_name = {
        ingredient.name: ingredient
        for ingredient in db.query(Ingredient).filter(Ingredient.name.in_(names)).all()
    }

    created = 0
    updated = 0
    unchanged = 0
    ingredients_by_external_id: dict[str, Ingredient] = {}
    for item in items:
        external_id = item["id"]
        ingredient = existing_by_external_id.get(external_id)
        name_match = existing_by_name.get(item["name"])
        if ingredient is None and name_match is not None:
            if name_match.external_id not in (None, external_id):
                raise CatalogValidationError(
                    f"Name '{item['name']}' is already assigned to catalog id "
                    f"'{name_match.external_id}'"
                )
            ingredient = name_match
        if ingredient is None:
            ingredient = Ingredient(name=item["name"], unit="unit")
            db.add(ingredient)
            created += 1

        values = {
            "external_id": external_id,
            "name": item["name"],
            "normalized_name": normalize_name(item["name"]),
            "category": item.get("category"),
            "stage": item["stage"],
            "process": item.get("process"),
            "added_to_complete_lineage": bool(item.get("added_to_complete_lineage", False)),
            "source_correction": item.get("source_correction"),
            "resolution_needed": item.get("resolution_needed"),
            "catalog_schema_version": validated["schema_version"],
            "catalog_metadata": {
                key: value
                for key, value in item.items()
                if key not in ITEM_FIELDS
            }
            or None,
            "active": True,
        }
        changed = False
        for field, value in values.items():
            if getattr(ingredient, field) != value:
                setattr(ingredient, field, value)
                changed = True
        if ingredient.id is not None:
            if changed:
                updated += 1
            else:
                unchanged += 1
        ingredients_by_external_id[external_id] = ingredient

    db.flush()
    imported_ids = [ingredient.id for ingredient in ingredients_by_external_id.values()]
    db.query(IngredientLineage).filter(
        IngredientLineage.child_ingredient_id.in_(imported_ids)
    ).delete(synchronize_session=False)
    for item in items:
        child = ingredients_by_external_id[item["id"]]
        for order_index, parent_external_id in enumerate(item["parent_ids"]):
            db.add(
                IngredientLineage(
                    child_ingredient_id=child.id,
                    parent_ingredient_id=ingredients_by_external_id[parent_external_id].id,
                    order_index=order_index,
                )
            )

    import_record = (
        db.query(IngredientCatalogImport)
        .filter(IngredientCatalogImport.source_sha256 == checksum)
        .first()
    )
    if import_record is None:
        import_record = IngredientCatalogImport(source_sha256=checksum)
        db.add(import_record)
    import_record.schema_version = validated["schema_version"]
    import_record.source_name = source_name
    import_record.item_count = validated["item_count"]
    import_record.relationship_count = validated["relationship_count"]
    import_record.catalog_metadata = _catalog_metadata(validated["model"])
    db.commit()
    db.refresh(import_record)

    return {
        "import_id": import_record.id,
        "schema_version": validated["schema_version"],
        "source_name": source_name,
        "source_sha256": checksum,
        "item_count": validated["item_count"],
        "relationship_count": validated["relationship_count"],
        "created": created,
        "updated": updated,
        "unchanged": unchanged,
        "dry_run": False,
    }


def import_default_catalog(db: Session, *, dry_run: bool = False) -> dict[str, Any]:
    return import_catalog(
        db,
        load_default_catalog(),
        source_name=f"{DEFAULT_CATALOG_PATH.name}+{BAR_CATALOG_PATH.name}",
        dry_run=dry_run,
    )


def activate_bar_inventory(
    db: Session,
    *,
    location_name: str = "Bar",
    dry_run: bool = False,
) -> dict[str, Any]:
    """Import the catalog and activate only physical bar products that are counted."""
    catalog_result = import_default_catalog(db, dry_run=dry_run)
    payload = load_default_catalog()
    bar_items = [
        item
        for item in payload["inventory_process_model"]["items"]
        if item.get("inventory_department") == "bar" and item.get("stockable") is True
    ]
    if dry_run:
        return {
            "location": location_name,
            "catalog": catalog_result,
            "stockable_item_count": len(bar_items),
            "created": 0,
            "updated": 0,
            "dry_run": True,
        }

    location = (
        db.query(InventoryLocation)
        .filter(InventoryLocation.name == location_name)
        .first()
    )
    if location is None:
        location = InventoryLocation(
            name=location_name,
            description="Bar bottles, kegs, mixers, and beverage supplies",
        )
        db.add(location)
        db.flush()
    else:
        location.active = True

    external_ids = [item["id"] for item in bar_items]
    ingredients = {
        ingredient.external_id: ingredient
        for ingredient in db.query(Ingredient)
        .filter(Ingredient.external_id.in_(external_ids))
        .all()
    }
    existing = {
        item.ingredient_id: item
        for item in db.query(InventoryItem)
        .filter(
            InventoryItem.ingredient_id.in_(
                [ingredient.id for ingredient in ingredients.values()]
            )
        )
        .all()
    }

    created = 0
    updated = 0
    for definition in bar_items:
        ingredient = ingredients[definition["id"]]
        inventory_item = existing.get(ingredient.id)
        base_unit = definition.get("inventory_base_unit", "unit")
        purchase_unit = definition.get("inventory_purchase_unit")
        purchase_to_base = definition.get("purchase_to_base")
        if purchase_to_base is None:
            # Never imply that one case equals one bottle when the pack size is unknown.
            if purchase_unit != base_unit:
                purchase_unit = base_unit
            purchase_to_base = 1
        values = {
            "name": ingredient.name,
            "category": ingredient.category,
            "base_unit": base_unit,
            "purchase_unit": purchase_unit,
            "purchase_to_base": purchase_to_base,
            "default_location_id": location.id,
            "active": True,
        }
        if inventory_item is None:
            inventory_item = InventoryItem(ingredient_id=ingredient.id, **values)
            db.add(inventory_item)
            db.flush()
            existing[ingredient.id] = inventory_item
            created += 1
        else:
            changed = False
            for key, value in values.items():
                if getattr(inventory_item, key) != value:
                    setattr(inventory_item, key, value)
                    changed = True
            updated += int(changed)

        for spoken_alias in definition.get("spoken_aliases", []):
            normalized_alias = normalize_name(spoken_alias)
            alias = (
                db.query(InventoryItemAlias)
                .filter(
                    InventoryItemAlias.inventory_item_id == inventory_item.id,
                    InventoryItemAlias.normalized_alias == normalized_alias,
                )
                .first()
            )
            if alias is None:
                db.add(
                    InventoryItemAlias(
                        inventory_item_id=inventory_item.id,
                        normalized_alias=normalized_alias,
                        source=InventoryAliasSource.CATALOG,
                    )
                )
            else:
                alias.active = True
                alias.source = InventoryAliasSource.CATALOG

        balance = (
            db.query(InventoryBalance)
            .filter(
                InventoryBalance.inventory_item_id == inventory_item.id,
                InventoryBalance.location_id == location.id,
            )
            .first()
        )
        if balance is None:
            db.add(
                InventoryBalance(
                    inventory_item_id=inventory_item.id,
                    location_id=location.id,
                )
            )

    db.commit()
    return {
        "location": location.name,
        "location_id": location.id,
        "catalog": catalog_result,
        "stockable_item_count": len(bar_items),
        "created": created,
        "updated": updated,
        "dry_run": False,
    }
