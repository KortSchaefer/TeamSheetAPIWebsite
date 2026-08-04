from __future__ import annotations

from decimal import Decimal
from typing import Any

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from app.models import (
    InventoryBalance,
    InventoryCount,
    InventoryCountLine,
    InventoryCountStatus,
    InventoryCountTemplate,
    InventoryCountTemplateLine,
    InventoryItem,
)


COUNT_LINE_SOURCES = {"MANUAL", "VOICE", "IMPORT"}
COUNT_LINE_REVIEW_STATUSES = {
    "PENDING",
    "READY",
    "NEEDS_REVIEW",
    "APPROVED",
}


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value or 0))


def items_for_count_sheet(
    db: Session,
    location_id: int,
    template_id: int | None = None,
) -> list[tuple[InventoryItem, int, str | None]]:
    if template_id:
        template = (
            db.query(InventoryCountTemplate)
            .filter(
                InventoryCountTemplate.id == template_id,
                InventoryCountTemplate.active.is_(True),
            )
            .first()
        )
        if not template:
            raise HTTPException(status_code=404, detail="Count template not found")
        rows = (
            db.query(InventoryCountTemplateLine)
            .options(joinedload(InventoryCountTemplateLine.item))
            .join(InventoryItem)
            .filter(
                InventoryCountTemplateLine.template_id == template_id,
                InventoryCountTemplateLine.location_id == location_id,
                InventoryItem.active.is_(True),
            )
            .order_by(
                InventoryCountTemplateLine.display_order,
                InventoryItem.name,
            )
            .all()
        )
        if rows:
            return [
                (row.item, row.display_order, row.preferred_unit) for row in rows
            ]

    location_item_ids = select(InventoryBalance.inventory_item_id).where(
        InventoryBalance.location_id == location_id
    )
    items = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.active.is_(True),
            or_(
                InventoryItem.default_location_id == location_id,
                InventoryItem.id.in_(location_item_ids),
            ),
        )
        .order_by(InventoryItem.category, InventoryItem.name)
        .all()
    )
    if not items:
        items = (
            db.query(InventoryItem)
            .filter(InventoryItem.active.is_(True))
            .order_by(InventoryItem.category, InventoryItem.name)
            .all()
        )
    return [(item, index, None) for index, item in enumerate(items)]


def populate_count_sheet(
    db: Session,
    count: InventoryCount,
    *,
    template_id: int | None = None,
) -> None:
    if count.lines:
        return
    balances = {
        row.inventory_item_id: row
        for row in db.query(InventoryBalance)
        .filter(InventoryBalance.location_id == count.location_id)
        .all()
    }
    for item, display_order, _preferred_unit in items_for_count_sheet(
        db, count.location_id, template_id
    ):
        balance = balances.get(item.id)
        count.lines.append(
            InventoryCountLine(
                inventory_item_id=item.id,
                counted_quantity=Decimal("0"),
                expected_quantity=(
                    _decimal(balance.quantity_on_hand)
                    if balance
                    else Decimal("0")
                ),
                display_order=display_order,
                is_counted=False,
                review_status="PENDING",
                revision=1,
            )
        )
    db.flush()


def derive_review_status(
    *,
    quantity: Decimal,
    expected_quantity: Decimal,
    par_quantity: Decimal,
    confidence: float | None,
) -> str:
    if confidence is not None and confidence < 0.85:
        return "NEEDS_REVIEW"
    reference = max(abs(expected_quantity), abs(par_quantity))
    if quantity == 0 and reference > 0:
        return "NEEDS_REVIEW"
    if reference > 0:
        variance = abs(quantity - expected_quantity)
        if variance >= Decimal("5") and variance > reference * Decimal("2"):
            return "NEEDS_REVIEW"
    return "READY"


def apply_line_changes(
    db: Session,
    count: InventoryCount,
    line: InventoryCountLine,
    changes: dict[str, Any],
    *,
    user_id: int,
    balance: InventoryBalance | None = None,
) -> None:
    if count.status != InventoryCountStatus.DRAFT:
        raise HTTPException(
            status_code=409,
            detail="Only draft count sheets can be edited",
        )
    client_revision = changes.pop("client_revision", None)
    if client_revision is not None and client_revision != line.revision:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "This row changed on another device",
                "current_revision": line.revision,
            },
        )

    if "counted_quantity" in changes:
        quantity = changes["counted_quantity"]
        line.counted_quantity = _decimal(quantity)
        line.is_counted = quantity is not None
    if "is_counted" in changes:
        line.is_counted = bool(changes["is_counted"])
        if not line.is_counted:
            line.counted_quantity = Decimal("0")
    if "notes" in changes:
        line.notes = changes["notes"]
    if "source" in changes:
        source = changes["source"]
        if source is not None and source not in COUNT_LINE_SOURCES:
            raise HTTPException(status_code=422, detail="Invalid count-line source")
        line.source = source
    if "confidence" in changes:
        line.confidence = changes["confidence"]
    if "evidence" in changes:
        line.evidence = changes["evidence"]

    if not line.is_counted:
        line.review_status = "PENDING"
    else:
        if balance is None:
            balance = (
                db.query(InventoryBalance)
                .filter(
                    InventoryBalance.inventory_item_id == line.inventory_item_id,
                    InventoryBalance.location_id == count.location_id,
                )
                .first()
            )
        suggested_status = derive_review_status(
            quantity=_decimal(line.counted_quantity),
            expected_quantity=_decimal(line.expected_quantity),
            par_quantity=_decimal(balance.par_quantity if balance else 0),
            confidence=line.confidence,
        )
        requested_status = changes.get("review_status")
        if requested_status is not None:
            if requested_status not in COUNT_LINE_REVIEW_STATUSES:
                raise HTTPException(
                    status_code=422, detail="Invalid count-line review status"
                )
            suggested_status = requested_status
        line.review_status = suggested_status

    line.updated_by_user_id = user_id
    line.revision = (line.revision or 0) + 1
    count.revision = (count.revision or 0) + 1
    db.flush()


def serialize_count_sheet(db: Session, count: InventoryCount) -> dict[str, Any]:
    balances = {
        row.inventory_item_id: row
        for row in db.query(InventoryBalance)
        .filter(InventoryBalance.location_id == count.location_id)
        .all()
    }
    lines = []
    for line in sorted(
        count.lines,
        key=lambda row: (
            row.display_order,
            (row.item.category or "").casefold(),
            row.item.name.casefold(),
        ),
    ):
        balance = balances.get(line.inventory_item_id)
        expected = _decimal(line.expected_quantity)
        quantity = _decimal(line.counted_quantity)
        lines.append(
            {
                "id": line.id,
                "inventory_item_id": line.inventory_item_id,
                "item_name": line.item.name,
                "category": line.item.category,
                "base_unit": line.item.base_unit,
                "purchase_unit": line.item.purchase_unit,
                "display_order": line.display_order,
                "expected_quantity": expected,
                "par_quantity": _decimal(balance.par_quantity if balance else 0),
                "counted_quantity": quantity if line.is_counted else None,
                "delta": quantity - expected if line.is_counted else None,
                "is_counted": line.is_counted,
                "source": line.source,
                "confidence": line.confidence,
                "review_status": line.review_status,
                "evidence": line.evidence,
                "notes": line.notes,
                "revision": line.revision,
            }
        )
    counted = sum(1 for line in lines if line["is_counted"])
    exceptions = sum(
        1 for line in lines if line["review_status"] == "NEEDS_REVIEW"
    )
    return {
        "id": count.id,
        "location_id": count.location_id,
        "location_name": count.location.name,
        "template_id": count.template_id,
        "template_name": count.template.name if count.template else None,
        "status": count.status.value,
        "revision": count.revision,
        "counted_by_user_id": count.counted_by_user_id,
        "reviewed_by_user_id": count.reviewed_by_user_id,
        "approved_at": count.approved_at,
        "notes": count.notes,
        "created_at": count.created_at,
        "updated_at": count.updated_at,
        "line_count": len(lines),
        "counted_line_count": counted,
        "uncounted_line_count": len(lines) - counted,
        "exception_count": exceptions,
        "completion_percent": (
            round((counted / len(lines)) * 100, 1) if lines else 100.0
        ),
        "lines": lines,
    }


def serialize_template(template: InventoryCountTemplate) -> dict[str, Any]:
    return {
        "id": template.id,
        "name": template.name,
        "description": template.description,
        "active": template.active,
        "created_by_user_id": template.created_by_user_id,
        "lines": [
            {
                "id": line.id,
                "inventory_item_id": line.inventory_item_id,
                "item_name": line.item.name,
                "location_id": line.location_id,
                "location_name": line.location.name,
                "display_order": line.display_order,
                "preferred_unit": line.preferred_unit or line.item.base_unit,
            }
            for line in template.lines
        ],
    }
