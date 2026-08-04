from collections import defaultdict
from datetime import date
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    InventoryBalance,
    InventoryCount,
    InventoryCountLine,
    InventoryCountStatus,
    InventoryItem,
    InventoryLocation,
    InventoryWeekdayTarget,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    Vendor,
    VendorItem,
)


DEFAULT_TOLERANCE_PERCENT = Decimal("10")


def _preferred_vendor_items(db: Session) -> dict[int, VendorItem]:
    rows = (
        db.query(VendorItem)
        .join(Vendor, Vendor.id == VendorItem.vendor_id)
        .filter(VendorItem.preferred.is_(True), Vendor.active.is_(True))
        .order_by(VendorItem.inventory_item_id, VendorItem.id)
        .all()
    )
    return {row.inventory_item_id: row for row in rows}


def _target_map(db: Session, location_id: int) -> dict[tuple[int, int], Decimal]:
    rows = (
        db.query(InventoryWeekdayTarget)
        .filter(InventoryWeekdayTarget.location_id == location_id)
        .all()
    )
    return {
        (row.inventory_item_id, row.weekday): Decimal(row.target_quantity)
        for row in rows
    }


def inventory_settings_rows(db: Session, location_id: int) -> list[dict[str, Any]]:
    location = (
        db.query(InventoryLocation)
        .filter(InventoryLocation.id == location_id, InventoryLocation.active.is_(True))
        .first()
    )
    if location is None:
        raise ValueError("Inventory location not found")
    items = (
        db.query(InventoryItem)
        .filter(InventoryItem.active.is_(True))
        .order_by(InventoryItem.category, InventoryItem.name)
        .all()
    )
    balances = {
        row.inventory_item_id: row
        for row in db.query(InventoryBalance)
        .filter(InventoryBalance.location_id == location_id)
        .all()
    }
    targets = _target_map(db, location_id)
    vendor_items = _preferred_vendor_items(db)
    results = []
    for item in items:
        balance = balances.get(item.id)
        vendor_item = vendor_items.get(item.id)
        results.append(
            {
                "inventory_item_id": item.id,
                "item_name": item.name,
                "category": item.category,
                "base_unit": item.base_unit,
                "planning_active": bool(balance and balance.planning_active),
                "weekday_targets": {
                    str(weekday): targets.get((item.id, weekday)) for weekday in range(7)
                },
                "lower_tolerance_percent": (
                    balance.lower_tolerance_percent if balance else None
                ),
                "upper_tolerance_percent": (
                    balance.upper_tolerance_percent if balance else None
                ),
                "effective_lower_tolerance_percent": (
                    balance.lower_tolerance_percent
                    if balance and balance.lower_tolerance_percent is not None
                    else DEFAULT_TOLERANCE_PERCENT
                ),
                "effective_upper_tolerance_percent": (
                    balance.upper_tolerance_percent
                    if balance and balance.upper_tolerance_percent is not None
                    else DEFAULT_TOLERANCE_PERCENT
                ),
                "preferred_vendor_id": vendor_item.vendor_id if vendor_item else None,
                "preferred_vendor_name": vendor_item.vendor.name if vendor_item else None,
                "vendor_sku": vendor_item.vendor_sku if vendor_item else None,
                "purchase_unit": item.purchase_unit or item.base_unit,
                "pack_quantity": vendor_item.pack_quantity if vendor_item else item.purchase_to_base,
                "unit_price_cents": vendor_item.unit_price_cents if vendor_item else 0,
            }
        )
    return results


def _latest_counted(
    db: Session, location_id: int
) -> dict[int, tuple[Decimal, Any, int]]:
    rows = (
        db.query(InventoryCountLine, InventoryCount)
        .join(InventoryCount, InventoryCount.id == InventoryCountLine.count_id)
        .filter(
            InventoryCount.location_id == location_id,
            InventoryCount.status == InventoryCountStatus.POSTED,
            InventoryCountLine.is_counted.is_(True),
        )
        .order_by(InventoryCount.updated_at.desc(), InventoryCount.id.desc())
        .all()
    )
    result = {}
    for line, count in rows:
        result.setdefault(
            line.inventory_item_id,
            (Decimal(line.counted_quantity), count.updated_at, count.id),
        )
    return result


def _incoming_quantities(db: Session, location_id: int) -> dict[int, Decimal]:
    rows = (
        db.query(PurchaseOrderLine)
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.purchase_order_id)
        .filter(
            PurchaseOrderLine.location_id == location_id,
            PurchaseOrder.status.in_(
                [PurchaseOrderStatus.SUBMITTED, PurchaseOrderStatus.PARTIALLY_RECEIVED]
            ),
        )
        .all()
    )
    incoming: dict[int, Decimal] = defaultdict(lambda: Decimal("0"))
    for line in rows:
        outstanding = max(
            Decimal(line.ordered_quantity or 0) - Decimal(line.received_quantity or 0),
            Decimal("0"),
        )
        incoming[line.inventory_item_id] += outstanding * Decimal(
            line.quantity_per_purchase_unit or 1
        )
    return incoming


def _stock_status(
    quantity: Decimal,
    target: Decimal | None,
    lower_tolerance: Decimal,
    upper_tolerance: Decimal,
) -> str:
    if target is None:
        return "NOT_CONFIGURED"
    if target > 0 and quantity <= 0:
        return "OUT"
    lower = target * (Decimal("1") - lower_tolerance / Decimal("100"))
    upper = target * (Decimal("1") + upper_tolerance / Decimal("100"))
    if quantity < lower:
        return "UNDER"
    if quantity > upper:
        return "OVER"
    return "ON_TARGET"


def purchase_order_planner_rows(
    db: Session, location_id: int, delivery_date: date
) -> list[dict[str, Any]]:
    location = (
        db.query(InventoryLocation)
        .filter(InventoryLocation.id == location_id, InventoryLocation.active.is_(True))
        .first()
    )
    if location is None:
        raise ValueError("Inventory location not found")
    weekday = delivery_date.weekday()
    balances = (
        db.query(InventoryBalance, InventoryItem)
        .join(InventoryItem, InventoryItem.id == InventoryBalance.inventory_item_id)
        .filter(
            InventoryBalance.location_id == location_id,
            InventoryBalance.planning_active.is_(True),
            InventoryItem.active.is_(True),
        )
        .order_by(InventoryItem.category, InventoryItem.name)
        .all()
    )
    targets = _target_map(db, location_id)
    counted = _latest_counted(db, location_id)
    incoming = _incoming_quantities(db, location_id)
    vendor_items = _preferred_vendor_items(db)
    results = []
    for balance, item in balances:
        target = targets.get((item.id, weekday))
        if target is None and Decimal(balance.par_quantity or 0) > 0:
            target = Decimal(balance.par_quantity)
        expected = Decimal(balance.quantity_on_hand or 0)
        incoming_quantity = incoming.get(item.id, Decimal("0"))
        projected = expected + incoming_quantity
        lower_tolerance = Decimal(
            balance.lower_tolerance_percent
            if balance.lower_tolerance_percent is not None
            else DEFAULT_TOLERANCE_PERCENT
        )
        upper_tolerance = Decimal(
            balance.upper_tolerance_percent
            if balance.upper_tolerance_percent is not None
            else DEFAULT_TOLERANCE_PERCENT
        )
        recommendation_base = max((target or Decimal("0")) - projected, Decimal("0"))
        vendor_item = vendor_items.get(item.id)
        pack_quantity = Decimal(
            (vendor_item.pack_quantity if vendor_item else item.purchase_to_base) or 1
        )
        recommended_purchase_quantity = (
            (recommendation_base / pack_quantity).to_integral_value(rounding=ROUND_CEILING)
            if recommendation_base > 0
            else Decimal("0")
        )
        unit_price_cents = (
            vendor_item.unit_price_cents
            if vendor_item and vendor_item.unit_price_cents
            else int(
                (Decimal(item.cost_cents or 0) * pack_quantity).quantize(
                    Decimal("1"), rounding=ROUND_HALF_UP
                )
            )
        )
        counted_value = counted.get(item.id)
        results.append(
            {
                "inventory_item_id": item.id,
                "item_name": item.name,
                "category": item.category,
                "location_id": location.id,
                "location_name": location.name,
                "base_unit": item.base_unit,
                "purchase_unit": item.purchase_unit or item.base_unit,
                "counted_quantity": counted_value[0] if counted_value else None,
                "counted_at": counted_value[1] if counted_value else None,
                "count_id": counted_value[2] if counted_value else None,
                "expected_quantity": expected,
                "incoming_quantity": incoming_quantity,
                "projected_quantity": projected,
                "target_quantity": target,
                "variance_quantity": projected - target if target is not None else None,
                "current_status": _stock_status(
                    expected, target, lower_tolerance, upper_tolerance
                ),
                "status": _stock_status(
                    projected, target, lower_tolerance, upper_tolerance
                ),
                "lower_tolerance_percent": lower_tolerance,
                "upper_tolerance_percent": upper_tolerance,
                "recommended_base_quantity": recommendation_base,
                "recommended_purchase_quantity": recommended_purchase_quantity,
                "pack_quantity": pack_quantity,
                "preferred_vendor_id": vendor_item.vendor_id if vendor_item else None,
                "preferred_vendor_name": vendor_item.vendor.name if vendor_item else None,
                "vendor_sku": vendor_item.vendor_sku if vendor_item else None,
                "unit_price_cents": unit_price_cents,
                "estimated_order_cost_cents": int(
                    recommended_purchase_quantity * Decimal(unit_price_cents)
                ),
            }
        )
    return results
