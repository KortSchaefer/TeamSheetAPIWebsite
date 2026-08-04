import csv
import hashlib
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from difflib import SequenceMatcher
from io import StringIO
from typing import Any

from sqlalchemy.orm import Session

from app.models import InventoryItem, InventoryItemAlias, VendorItem
from app.services.ingredient_catalog import normalize_name


MAX_ROWS = 5_000

HEADER_ALIASES = {
    "item_name": {"item", "item name", "product", "product name", "description", "product description"},
    "vendor_sku": {"sku", "vendor sku", "item number", "item no", "item #", "product code", "code"},
    "quantity": {"quantity", "qty", "order qty", "ordered quantity", "cases", "case quantity"},
    "unit_price": {"unit price", "price", "cost", "unit cost", "price each", "each price"},
    "line_total": {"total", "line total", "extended price", "extended cost", "amount"},
    "external_reference": {"po number", "po #", "purchase order", "purchase order number", "order number", "reference"},
}


class PurchaseOrderCSVError(ValueError):
    pass


def _header_key(value: str) -> str:
    value = value.replace("\ufeff", "").strip().casefold()
    value = re.sub(r"\([^)]*\)", " ", value)
    return " ".join(re.sub(r"[^a-z0-9#]+", " ", value).split())


def _sku_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").casefold())


def _source_hash(vendor_id: int, csv_text: str) -> str:
    normalized = csv_text.replace("\r\n", "\n").replace("\r", "\n").strip().lstrip("\ufeff")
    return hashlib.sha256(f"{vendor_id}\n{normalized}".encode("utf-8")).hexdigest()


def _decimal(raw: str, label: str, row_number: int) -> Decimal:
    value = (raw or "").strip().replace("$", "").replace(",", "")
    if not value:
        raise PurchaseOrderCSVError(f"Row {row_number}: {label} is required.")
    if value.startswith("(") and value.endswith(")"):
        value = f"-{value[1:-1]}"
    try:
        return Decimal(value)
    except InvalidOperation as exc:
        raise PurchaseOrderCSVError(f"Row {row_number}: {label} '{raw}' is not a number.") from exc


def _price_cents(raw: str, header: str, row_number: int) -> int:
    amount = _decimal(raw, "unit price", row_number)
    if amount < 0:
        raise PurchaseOrderCSVError(f"Row {row_number}: unit price cannot be negative.")
    is_cents = "cent" in header.casefold()
    multiplier = Decimal("1") if is_cents else Decimal("100")
    return int((amount * multiplier).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _detect_columns(fieldnames: list[str]) -> dict[str, str]:
    detected: dict[str, str] = {}
    for original in fieldnames:
        key = _header_key(original or "")
        for field, aliases in HEADER_ALIASES.items():
            if key in aliases or (field == "unit_price" and key in {"unit price cents", "unit cost cents"}):
                detected.setdefault(field, original)
    if "quantity" not in detected:
        raise PurchaseOrderCSVError("The CSV needs a quantity column (for example: Qty or Quantity).")
    if "item_name" not in detected and "vendor_sku" not in detected:
        raise PurchaseOrderCSVError("The CSV needs an item description or SKU column.")
    return detected


def _reader(csv_text: str) -> tuple[csv.DictReader, dict[str, str]]:
    text = csv_text.lstrip("\ufeff")
    if not text.strip():
        raise PurchaseOrderCSVError("The CSV file is empty.")
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise PurchaseOrderCSVError("The CSV needs a header row.")
    return reader, _detect_columns([name or "" for name in reader.fieldnames])


def _suggestions(items: list[InventoryItem], item_name: str, sku: str) -> list[dict[str, Any]]:
    needle = normalize_name(item_name) or _sku_key(sku)
    if not needle:
        return []
    scored = []
    for item in items:
        score = SequenceMatcher(None, needle, normalize_name(item.name)).ratio()
        if sku and item.sku:
            score = max(score, SequenceMatcher(None, _sku_key(sku), _sku_key(item.sku)).ratio())
        if score >= 0.42:
            scored.append((score, item))
    return [
        {"inventory_item_id": item.id, "name": item.name, "sku": item.sku, "score": round(score, 2)}
        for score, item in sorted(scored, key=lambda value: (-value[0], value[1].name))[:3]
    ]


def preview_purchase_order_csv(
    db: Session,
    *,
    vendor_id: int,
    csv_text: str,
    item_overrides: dict[int, int] | None = None,
) -> dict[str, Any]:
    reader, columns = _reader(csv_text)
    overrides = item_overrides or {}
    items = db.query(InventoryItem).filter(InventoryItem.active.is_(True)).all()
    items_by_id = {item.id: item for item in items}

    vendor_skus: dict[str, list[InventoryItem]] = defaultdict(list)
    for vendor_item in db.query(VendorItem).filter(VendorItem.vendor_id == vendor_id).all():
        if vendor_item.item and vendor_item.item.active and vendor_item.vendor_sku:
            vendor_skus[_sku_key(vendor_item.vendor_sku)].append(vendor_item.item)

    item_skus: dict[str, list[InventoryItem]] = defaultdict(list)
    item_names: dict[str, list[InventoryItem]] = defaultdict(list)
    aliases: dict[str, list[InventoryItem]] = defaultdict(list)
    for item in items:
        if item.sku:
            item_skus[_sku_key(item.sku)].append(item)
        item_names[normalize_name(item.name)].append(item)
    for alias in db.query(InventoryItemAlias).filter(InventoryItemAlias.active.is_(True)).all():
        if alias.item and alias.item.active:
            aliases[normalize_name(alias.normalized_alias)].append(alias.item)

    rows: list[dict[str, Any]] = []
    external_reference = None
    for index, raw_row in enumerate(reader, start=2):
        if len(rows) >= MAX_ROWS:
            raise PurchaseOrderCSVError(f"CSV files are limited to {MAX_ROWS:,} product rows.")
        values = {key: (raw_row.get(column) or "").strip() for key, column in columns.items()}
        if not any(values.values()):
            continue
        item_name = values.get("item_name", "")
        sku = values.get("vendor_sku", "")
        if normalize_name(item_name) in {"subtotal", "total", "grand total", "tax", "freight", "shipping"} and not sku:
            continue
        if values.get("external_reference") and not external_reference:
            external_reference = values["external_reference"][:100]

        row: dict[str, Any] = {
            "row_number": index,
            "item_name": item_name,
            "vendor_sku": sku,
            "quantity": None,
            "unit_price_cents": None,
            "status": "INVALID",
            "message": None,
            "inventory_item_id": None,
            "inventory_item_name": None,
            "match_method": None,
            "suggestions": [],
        }
        try:
            quantity = _decimal(values.get("quantity", ""), "quantity", index)
            if quantity <= 0:
                raise PurchaseOrderCSVError(f"Row {index}: quantity must be greater than zero.")
            row["quantity"] = str(quantity)
            if values.get("unit_price"):
                row["unit_price_cents"] = _price_cents(values["unit_price"], columns["unit_price"], index)
            elif values.get("line_total"):
                line_total = _decimal(values["line_total"], "line total", index)
                if line_total < 0:
                    raise PurchaseOrderCSVError(f"Row {index}: line total cannot be negative.")
                row["unit_price_cents"] = int(
                    ((line_total * Decimal("100")) / quantity).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                )
            else:
                row["unit_price_cents"] = 0
        except PurchaseOrderCSVError as exc:
            row["message"] = str(exc).split(": ", 1)[-1]
            rows.append(row)
            continue

        candidates: list[InventoryItem] = []
        match_method = None
        override_id = overrides.get(index)
        if override_id is not None:
            override_item = items_by_id.get(override_id)
            if not override_item:
                row["message"] = "Selected inventory item does not exist or is inactive."
                rows.append(row)
                continue
            candidates, match_method = [override_item], "manual override"
        elif sku and vendor_skus.get(_sku_key(sku)):
            candidates, match_method = vendor_skus[_sku_key(sku)], "vendor SKU"
        elif sku and item_skus.get(_sku_key(sku)):
            candidates, match_method = item_skus[_sku_key(sku)], "inventory SKU"
        elif item_name and item_names.get(normalize_name(item_name)):
            candidates, match_method = item_names[normalize_name(item_name)], "exact name"
        elif item_name and aliases.get(normalize_name(item_name)):
            candidates, match_method = aliases[normalize_name(item_name)], "item alias"

        unique_candidates = {item.id: item for item in candidates}
        if len(unique_candidates) == 1:
            item = next(iter(unique_candidates.values()))
            row.update(
                status="MATCHED",
                message=None,
                inventory_item_id=item.id,
                inventory_item_name=item.name,
                match_method=match_method,
            )
        elif len(unique_candidates) > 1:
            row["status"] = "AMBIGUOUS"
            row["message"] = "More than one inventory item matches this row."
            row["suggestions"] = [
                {"inventory_item_id": item.id, "name": item.name, "sku": item.sku, "score": 1}
                for item in sorted(unique_candidates.values(), key=lambda candidate: candidate.name)[:3]
            ]
        else:
            row["status"] = "UNMATCHED"
            row["message"] = "Choose the inventory item for this product."
            row["suggestions"] = _suggestions(items, item_name, sku)
        rows.append(row)

    if not rows:
        raise PurchaseOrderCSVError("No product rows were found in the CSV.")
    counts = {status: sum(row["status"] == status for row in rows) for status in ("MATCHED", "UNMATCHED", "AMBIGUOUS", "INVALID")}
    return {
        "source_hash": _source_hash(vendor_id, csv_text),
        "external_reference": external_reference,
        "detected_columns": sorted(columns),
        "row_count": len(rows),
        "matched_count": counts["MATCHED"],
        "unresolved_count": counts["UNMATCHED"] + counts["AMBIGUOUS"],
        "invalid_count": counts["INVALID"],
        "ready_to_import": counts["UNMATCHED"] + counts["AMBIGUOUS"] + counts["INVALID"] == 0,
        "rows": rows,
    }
