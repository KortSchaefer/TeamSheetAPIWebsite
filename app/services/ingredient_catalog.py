import hashlib
import json
import unicodedata
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import Ingredient, IngredientCatalogImport, IngredientLineage


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG_PATH = PROJECT_ROOT / "data" / "ingredient_catalog.json"
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
        load_catalog_file(DEFAULT_CATALOG_PATH),
        source_name=DEFAULT_CATALOG_PATH.name,
        dry_run=dry_run,
    )
