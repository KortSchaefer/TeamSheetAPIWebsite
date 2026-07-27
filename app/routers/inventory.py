from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import (
    InventoryBalance,
    InventoryCount,
    InventoryCountLine,
    InventoryCountStatus,
    InventoryVoiceEntry,
    InventoryVoiceReviewStatus,
    InventoryVoiceSessionCount,
    InventoryVoiceSessionStatus,
    InventoryItem,
    InventoryLocation,
    InventoryReceiving,
    InventoryReceivingLine,
    Ingredient,
    PurchaseOrder,
    PurchaseOrderLine,
    PurchaseOrderStatus,
    StockMovement,
    User,
    Vendor,
    VendorItem,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])


def get_location(db: Session, location_id: int) -> InventoryLocation:
    location = db.query(InventoryLocation).filter(InventoryLocation.id == location_id).first()
    if not location:
        raise HTTPException(status_code=404, detail="Inventory location not found")
    return location


def get_item(db: Session, item_id: int) -> InventoryItem:
    item = db.query(InventoryItem).filter(InventoryItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    return item


def get_or_create_balance(db: Session, item_id: int, location_id: int) -> InventoryBalance:
    balance = (
        db.query(InventoryBalance)
        .filter(InventoryBalance.inventory_item_id == item_id, InventoryBalance.location_id == location_id)
        .first()
    )
    if balance:
        return balance
    balance = InventoryBalance(inventory_item_id=item_id, location_id=location_id)
    db.add(balance)
    db.flush()
    return balance


def movement_response(movement: StockMovement) -> schemas.InventoryMovementRead:
    return schemas.InventoryMovementRead(
        id=movement.id,
        inventory_item_id=movement.inventory_item_id,
        location_id=movement.location_id,
        quantity_change=Decimal(str(movement.quantity_change)),
        reason=movement.reason,
        notes=movement.notes,
        source_event_key=movement.source_event_key,
        lot_number=movement.lot_number,
        expiration_date=movement.expiration_date,
        created_by_user_id=movement.created_by_user_id,
        created_at=movement.created_at,
        updated_at=movement.updated_at,
    )


def ensure_voice_count_ready(db: Session, count_id: int) -> None:
    link = (
        db.query(InventoryVoiceSessionCount)
        .filter(InventoryVoiceSessionCount.inventory_count_id == count_id)
        .first()
    )
    if not link:
        return
    blocking = (
        db.query(InventoryVoiceEntry)
        .filter(
            InventoryVoiceEntry.session_id == link.session_id,
            InventoryVoiceEntry.review_status
            == InventoryVoiceReviewStatus.NEEDS_REVIEW,
        )
        .count()
    )
    if blocking or link.session.status != InventoryVoiceSessionStatus.FINISHED:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Voice inventory session #{link.session_id} has "
                f"{blocking} unresolved entr{'y' if blocking == 1 else 'ies'}"
            ),
        )


@router.get("/locations", response_model=list[schemas.InventoryLocationRead])
def list_locations(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(InventoryLocation).filter(InventoryLocation.active.is_(True)).order_by(InventoryLocation.name).all()


@router.post("/locations", response_model=schemas.InventoryLocationRead, status_code=status.HTTP_201_CREATED)
def create_location(
    payload: schemas.InventoryLocationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    location = InventoryLocation(**payload.model_dump())
    db.add(location)
    db.commit()
    db.refresh(location)
    return location


@router.get("/items", response_model=list[schemas.InventoryItemRead])
def list_items(
    active: bool | None = Query(default=None),
    search: str | None = Query(default=None),
    category: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(InventoryItem)
    if active is not None:
        query = query.filter(InventoryItem.active == active)
    if search:
        query = query.filter(InventoryItem.name.ilike(f"%{search}%"))
    if category:
        query = query.filter(InventoryItem.category == category)
    return query.order_by(InventoryItem.category, InventoryItem.name).all()


@router.post("/items", response_model=schemas.InventoryItemRead, status_code=status.HTTP_201_CREATED)
def create_item(
    payload: schemas.InventoryItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    if payload.default_location_id:
        get_location(db, payload.default_location_id)
    item = InventoryItem(**payload.model_dump())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.post(
    "/items/from-catalog",
    response_model=schemas.InventoryItemRead,
    status_code=status.HTTP_201_CREATED,
)
def activate_catalog_item(
    payload: schemas.InventoryCatalogActivationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    ingredient = (
        db.query(Ingredient)
        .filter(Ingredient.external_id == payload.catalog_id, Ingredient.active.is_(True))
        .first()
    )
    if ingredient is None:
        raise HTTPException(status_code=404, detail="Catalog ingredient not found")
    if payload.default_location_id:
        get_location(db, payload.default_location_id)

    item = (
        db.query(InventoryItem)
        .filter(InventoryItem.ingredient_id == ingredient.id)
        .first()
    )
    values = payload.model_dump(exclude={"catalog_id"})
    if item is None:
        item = InventoryItem(
            ingredient_id=ingredient.id,
            name=ingredient.name,
            category=ingredient.category,
            active=True,
            **values,
        )
        db.add(item)
    else:
        item.active = True
        for key, value in values.items():
            setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.put("/items/{item_id}", response_model=schemas.InventoryItemRead)
def update_item(
    item_id: int,
    payload: schemas.InventoryItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    item = get_item(db, item_id)
    if payload.default_location_id:
        get_location(db, payload.default_location_id)
    for key, value in payload.model_dump().items():
        setattr(item, key, value)
    db.commit()
    db.refresh(item)
    return item


@router.get("/items/{item_id}/balances", response_model=list[schemas.InventoryBalanceRead])
def item_balances(item_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_item(db, item_id)
    return db.query(InventoryBalance).filter(InventoryBalance.inventory_item_id == item_id).all()


@router.put("/items/{item_id}/balances", response_model=schemas.InventoryBalanceRead)
def upsert_balance(
    item_id: int,
    payload: schemas.InventoryBalanceUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    get_item(db, item_id)
    get_location(db, payload.location_id)
    balance = get_or_create_balance(db, item_id, payload.location_id)
    balance.minimum_quantity = payload.minimum_quantity
    balance.par_quantity = payload.par_quantity
    balance.maximum_quantity = payload.maximum_quantity
    db.commit()
    db.refresh(balance)
    return balance


@router.get("/stock", response_model=list[schemas.InventoryStockRead])
def stock(
    location_id: int | None = Query(default=None),
    status_filter: str | None = Query(default=None, alias="status"),
    expiring_days: int | None = Query(default=None, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = (
        db.query(InventoryBalance, InventoryItem, InventoryLocation)
        .join(InventoryItem, InventoryItem.id == InventoryBalance.inventory_item_id)
        .join(InventoryLocation, InventoryLocation.id == InventoryBalance.location_id)
        .filter(InventoryItem.active.is_(True), InventoryLocation.active.is_(True))
    )
    if location_id:
        query = query.filter(InventoryBalance.location_id == location_id)
    rows = query.order_by(InventoryItem.category, InventoryItem.name).all()
    results = []
    for balance, item, location in rows:
        status_value = "OUT" if balance.quantity_on_hand <= 0 else "LOW" if balance.quantity_on_hand <= balance.minimum_quantity else "HEALTHY"
        if status_filter and status_value != status_filter.upper():
            continue
        results.append(schemas.InventoryStockRead(
            inventory_item_id=item.id,
            item_name=item.name,
            category=item.category,
            location_id=location.id,
            location_name=location.name,
            base_unit=item.base_unit,
            quantity_on_hand=balance.quantity_on_hand,
            minimum_quantity=balance.minimum_quantity,
            par_quantity=balance.par_quantity,
            status=status_value,
        ))
    return results


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    stock_rows = stock(db=db, current_user=current_user)
    return {
        "item_count": db.query(InventoryItem).filter(InventoryItem.active.is_(True)).count(),
        "location_count": db.query(InventoryLocation).filter(InventoryLocation.active.is_(True)).count(),
        "low_stock_count": sum(row.status in {"LOW", "OUT"} for row in stock_rows),
        "open_count_sessions": db.query(InventoryCount).filter(InventoryCount.status.in_([InventoryCountStatus.DRAFT, InventoryCountStatus.SUBMITTED])).count(),
        "pending_purchase_orders": db.query(PurchaseOrder).filter(PurchaseOrder.status.in_([PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.SUBMITTED, PurchaseOrderStatus.PARTIALLY_RECEIVED])).count(),
        "recent_movements": db.query(StockMovement).filter(StockMovement.inventory_item_id.is_not(None)).order_by(StockMovement.created_at.desc()).limit(10).count(),
    }


@router.get("/vendors", response_model=list[schemas.VendorRead])
def list_vendors(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(Vendor).filter(Vendor.active.is_(True)).order_by(Vendor.name).all()


@router.post("/vendors", response_model=schemas.VendorRead, status_code=status.HTTP_201_CREATED)
def create_vendor(payload: schemas.VendorCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    vendor = Vendor(**payload.model_dump())
    db.add(vendor)
    db.commit()
    db.refresh(vendor)
    return vendor


@router.post("/vendor-items", response_model=schemas.VendorItemRead, status_code=status.HTTP_201_CREATED)
def create_vendor_item(payload: schemas.VendorItemCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    get_item(db, payload.inventory_item_id)
    if not db.query(Vendor).filter(Vendor.id == payload.vendor_id).first():
        raise HTTPException(status_code=404, detail="Vendor not found")
    vendor_item = VendorItem(**payload.model_dump())
    db.add(vendor_item)
    db.commit()
    db.refresh(vendor_item)
    return vendor_item


def post_movement(db: Session, payload: schemas.InventoryMovementCreate, actor_user_id: int | None = None) -> StockMovement:
    item = get_item(db, payload.inventory_item_id)
    get_location(db, payload.location_id)
    if payload.source_event_key:
        existing = db.query(StockMovement).filter(StockMovement.source_event_key == payload.source_event_key).first()
        if existing:
            return existing
    balance = get_or_create_balance(db, payload.inventory_item_id, payload.location_id)
    balance.quantity_on_hand += payload.quantity_change
    legacy_ingredient = db.query(Ingredient).filter(Ingredient.name == item.name).first()
    if not legacy_ingredient:
        legacy_ingredient = Ingredient(name=item.name, unit=item.base_unit, active=True)
        db.add(legacy_ingredient)
        db.flush()
    movement = StockMovement(
        ingredient_id=legacy_ingredient.id,
        inventory_item_id=payload.inventory_item_id,
        location_id=payload.location_id,
        quantity_change=float(payload.quantity_change),
        reason=payload.reason,
        notes=payload.notes,
        source_event_key=payload.source_event_key,
        created_by_user_id=actor_user_id,
        lot_number=payload.lot_number,
        expiration_date=payload.expiration_date,
    )
    db.add(movement)
    db.flush()
    return movement


@router.post("/movements", response_model=schemas.InventoryMovementRead, status_code=status.HTTP_201_CREATED)
def create_movement(payload: schemas.InventoryMovementCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    movement = post_movement(db, payload, current_user.id)
    db.commit()
    db.refresh(movement)
    return movement_response(movement)


@router.post("/waste", response_model=schemas.InventoryMovementRead, status_code=status.HTTP_201_CREATED)
def record_waste(payload: schemas.InventoryMovementCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    payload.reason = payload.reason or "WASTE"
    movement = post_movement(db, payload, current_user.id)
    db.commit()
    db.refresh(movement)
    return movement_response(movement)


@router.post("/adjustments", response_model=schemas.InventoryMovementRead, status_code=status.HTTP_201_CREATED)
def record_adjustment(payload: schemas.InventoryMovementCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    movement = post_movement(db, payload, current_user.id)
    db.commit()
    db.refresh(movement)
    return movement_response(movement)


@router.post("/transfers", response_model=list[schemas.InventoryMovementRead], status_code=status.HTTP_201_CREATED)
def transfer_stock(payload: schemas.InventoryTransferCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    if payload.from_location_id == payload.to_location_id:
        raise HTTPException(status_code=400, detail="Transfer locations must be different")
    transfer_key = f"transfer:{current_user.id}:{payload.inventory_item_id}:{payload.from_location_id}:{payload.to_location_id}:{payload.quantity}:{date.today().isoformat()}"
    outbound = post_movement(db, schemas.InventoryMovementCreate(inventory_item_id=payload.inventory_item_id, location_id=payload.from_location_id, quantity_change=-payload.quantity, reason="TRANSFER_OUT", source_event_key=f"{transfer_key}:out", notes=payload.notes), current_user.id)
    inbound = post_movement(db, schemas.InventoryMovementCreate(inventory_item_id=payload.inventory_item_id, location_id=payload.to_location_id, quantity_change=payload.quantity, reason="TRANSFER_IN", source_event_key=f"{transfer_key}:in", notes=payload.notes), current_user.id)
    db.commit()
    db.refresh(outbound)
    db.refresh(inbound)
    return [movement_response(outbound), movement_response(inbound)]


@router.get("/movements", response_model=list[schemas.InventoryMovementRead])
def list_movements(limit: int = Query(default=100, ge=1, le=500), db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    movements = db.query(StockMovement).filter(StockMovement.inventory_item_id.is_not(None)).order_by(StockMovement.created_at.desc()).limit(limit).all()
    return [movement_response(movement) for movement in movements]


@router.get("/counts", response_model=list[schemas.InventoryCountRead])
def list_counts(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    counts = db.query(InventoryCount).order_by(InventoryCount.created_at.desc()).all()
    return [{"id": count.id, "location_id": count.location_id, "status": count.status, "counted_by_user_id": count.counted_by_user_id, "reviewed_by_user_id": count.reviewed_by_user_id, "notes": count.notes, "lines": [{"inventory_item_id": line.inventory_item_id, "counted_quantity": line.counted_quantity, "expected_quantity": line.expected_quantity, "notes": line.notes} for line in count.lines]} for count in counts]


@router.post("/counts", response_model=schemas.InventoryCountRead, status_code=status.HTTP_201_CREATED)
def create_count(payload: schemas.InventoryCountCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    get_location(db, payload.location_id)
    count = InventoryCount(location_id=payload.location_id, counted_by_user_id=current_user.id, notes=payload.notes)
    db.add(count)
    db.flush()
    for line in payload.lines:
        get_item(db, line.inventory_item_id)
        balance = get_or_create_balance(db, line.inventory_item_id, payload.location_id)
        db.add(InventoryCountLine(count_id=count.id, inventory_item_id=line.inventory_item_id, counted_quantity=line.counted_quantity, expected_quantity=balance.quantity_on_hand, notes=line.notes))
    db.commit()
    db.refresh(count)
    return {"id": count.id, "location_id": count.location_id, "status": count.status, "counted_by_user_id": count.counted_by_user_id, "reviewed_by_user_id": count.reviewed_by_user_id, "notes": count.notes, "lines": [{"inventory_item_id": line.inventory_item_id, "counted_quantity": line.counted_quantity, "expected_quantity": line.expected_quantity, "notes": line.notes} for line in count.lines]}


@router.post("/counts/{count_id}/submit", response_model=schemas.InventoryCountRead)
def submit_count(count_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    count = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not count:
        raise HTTPException(status_code=404, detail="Count session not found")
    if count.status != InventoryCountStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Only draft counts can be submitted")
    ensure_voice_count_ready(db, count.id)
    count.status = InventoryCountStatus.SUBMITTED
    db.commit()
    return {"id": count.id, "location_id": count.location_id, "status": count.status, "counted_by_user_id": count.counted_by_user_id, "reviewed_by_user_id": count.reviewed_by_user_id, "notes": count.notes, "lines": []}


@router.post("/counts/{count_id}/post", response_model=schemas.InventoryCountRead)
def post_count(count_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    count = db.query(InventoryCount).filter(InventoryCount.id == count_id).first()
    if not count:
        raise HTTPException(status_code=404, detail="Count session not found")
    if count.status not in {InventoryCountStatus.SUBMITTED, InventoryCountStatus.APPROVED}:
        raise HTTPException(status_code=400, detail="Count must be submitted before posting")
    ensure_voice_count_ready(db, count.id)
    for line in count.lines:
        balance = get_or_create_balance(db, line.inventory_item_id, count.location_id)
        difference = line.counted_quantity - balance.quantity_on_hand
        if difference:
            post_movement(db, schemas.InventoryMovementCreate(inventory_item_id=line.inventory_item_id, location_id=count.location_id, quantity_change=difference, reason="COUNT", source_event_key=f"count:{count.id}:item:{line.inventory_item_id}"), current_user.id)
    count.status = InventoryCountStatus.POSTED
    count.reviewed_by_user_id = current_user.id
    db.commit()
    return {"id": count.id, "location_id": count.location_id, "status": count.status, "counted_by_user_id": count.counted_by_user_id, "reviewed_by_user_id": count.reviewed_by_user_id, "notes": count.notes, "lines": []}


@router.post("/purchase-orders", response_model=schemas.PurchaseOrderRead, status_code=status.HTTP_201_CREATED)
def create_purchase_order(payload: schemas.PurchaseOrderCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    if not db.query(Vendor).filter(Vendor.id == payload.vendor_id).first():
        raise HTTPException(status_code=404, detail="Vendor not found")
    purchase_order = PurchaseOrder(vendor_id=payload.vendor_id, expected_date=payload.expected_date, notes=payload.notes, created_by_user_id=current_user.id)
    db.add(purchase_order)
    db.flush()
    for line in payload.lines:
        get_item(db, line.inventory_item_id)
        purchase_order.lines.append(PurchaseOrderLine(inventory_item_id=line.inventory_item_id, ordered_quantity=line.ordered_quantity, unit_price_cents=line.unit_price_cents))
    db.commit()
    db.refresh(purchase_order)
    return {"id": purchase_order.id, "vendor_id": purchase_order.vendor_id, "status": purchase_order.status, "expected_date": purchase_order.expected_date, "notes": purchase_order.notes, "created_by_user_id": purchase_order.created_by_user_id, "lines": [{"inventory_item_id": line.inventory_item_id, "ordered_quantity": line.ordered_quantity, "received_quantity": line.received_quantity, "unit_price_cents": line.unit_price_cents} for line in purchase_order.lines]}


@router.get("/purchase-orders", response_model=list[schemas.PurchaseOrderRead])
def list_purchase_orders(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    orders = db.query(PurchaseOrder).order_by(PurchaseOrder.created_at.desc()).all()
    return [{"id": order.id, "vendor_id": order.vendor_id, "status": order.status, "expected_date": order.expected_date, "notes": order.notes, "created_by_user_id": order.created_by_user_id, "lines": [{"inventory_item_id": line.inventory_item_id, "ordered_quantity": line.ordered_quantity, "received_quantity": line.received_quantity, "unit_price_cents": line.unit_price_cents} for line in order.lines]} for order in orders]


@router.post("/purchase-orders/{order_id}/submit", response_model=dict)
def submit_purchase_order(order_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    order = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if not order.lines:
        raise HTTPException(status_code=400, detail="Purchase order needs at least one line")
    if order.status != PurchaseOrderStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Only draft orders can be submitted")
    order.status = PurchaseOrderStatus.SUBMITTED
    db.commit()
    return {"id": order.id, "status": order.status}


@router.post("/purchase-orders/{order_id}/cancel", response_model=dict)
def cancel_purchase_order(order_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    order = db.query(PurchaseOrder).filter(PurchaseOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    if order.status in {PurchaseOrderStatus.RECEIVED, PurchaseOrderStatus.CANCELLED}:
        raise HTTPException(status_code=400, detail="This order cannot be cancelled")
    order.status = PurchaseOrderStatus.CANCELLED
    db.commit()
    return {"id": order.id, "status": order.status}


@router.post("/receiving", response_model=dict, status_code=status.HTTP_201_CREATED)
def receive_purchase_order(payload: schemas.ReceivingCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_manager_or_admin)):
    order = db.query(PurchaseOrder).filter(PurchaseOrder.id == payload.purchase_order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Purchase order not found")
    receiving = InventoryReceiving(purchase_order_id=order.id, received_by_user_id=current_user.id, invoice_number=payload.invoice_number, notes=payload.notes)
    db.add(receiving)
    db.flush()
    for line in payload.lines:
        get_item(db, line.inventory_item_id)
        get_location(db, line.location_id)
        receiving.lines.append(InventoryReceivingLine(**line.model_dump()))
        post_movement(db, schemas.InventoryMovementCreate(inventory_item_id=line.inventory_item_id, location_id=line.location_id, quantity_change=line.received_quantity, reason="RECEIVE", source_event_key=f"receiving:{receiving.id}:item:{line.inventory_item_id}", lot_number=line.lot_number, expiration_date=line.expiration_date, notes=line.notes), current_user.id)
        matching_line = next((order_line for order_line in order.lines if order_line.inventory_item_id == line.inventory_item_id), None)
        if matching_line:
            matching_line.received_quantity += line.received_quantity
    order.status = PurchaseOrderStatus.RECEIVED if all(line.received_quantity >= line.ordered_quantity for line in order.lines) else PurchaseOrderStatus.PARTIALLY_RECEIVED
    db.commit()
    return {"id": receiving.id, "purchase_order_id": order.id, "status": order.status}
