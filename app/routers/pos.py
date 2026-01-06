from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session, selectinload

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import MenuCategory, MenuItem, POSOrder, POSOrderItem, POSOrderStatus, POSPayment, RecipeItem, StockMovement, User

router = APIRouter(prefix="/pos", tags=["pos"])


@router.get("/menu-categories", response_model=list[schemas.MenuCategoryRead])
def list_menu_categories(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(MenuCategory).order_by(MenuCategory.name).all()


@router.post("/menu-categories", response_model=schemas.MenuCategoryRead, status_code=status.HTTP_201_CREATED)
def create_menu_category(
    payload: schemas.MenuCategoryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    category = MenuCategory(**payload.dict())
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


@router.get("/menu-items", response_model=list[schemas.MenuItemRead])
def list_menu_items(
    active: bool | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(MenuItem)
    if active is not None:
        query = query.filter(MenuItem.active == active)
    return query.order_by(MenuItem.name).all()


@router.post("/menu-items", response_model=schemas.MenuItemRead, status_code=status.HTTP_201_CREATED)
def create_menu_item(
    payload: schemas.MenuItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    item = MenuItem(**payload.dict())
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.get("/orders", response_model=list[schemas.POSOrderRead])
def list_orders(
    status_filter: POSOrderStatus | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(POSOrder).options(selectinload(POSOrder.items))
    if status_filter:
        query = query.filter(POSOrder.status == status_filter)
    return query.order_by(POSOrder.created_at.desc()).all()


@router.post("/orders", response_model=schemas.POSOrderRead, status_code=status.HTTP_201_CREATED)
def create_order(
    payload: schemas.POSOrderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    order = POSOrder(**payload.dict())
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


@router.post("/orders/{order_id}/items", response_model=schemas.POSOrderItemRead, status_code=status.HTTP_201_CREATED)
def add_order_item(
    order_id: int,
    payload: schemas.POSOrderItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    order = db.query(POSOrder).filter(POSOrder.id == order_id).first()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.status != POSOrderStatus.OPEN:
        raise HTTPException(status_code=400, detail="Order is not open")

    menu_item = db.query(MenuItem).filter(MenuItem.id == payload.menu_item_id).first()
    if not menu_item:
        raise HTTPException(status_code=404, detail="Menu item not found")

    price_cents = payload.price_cents or menu_item.price_cents
    item = POSOrderItem(
        order_id=order_id,
        menu_item_id=menu_item.id,
        quantity=payload.quantity,
        price_cents=price_cents,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.post("/orders/{order_id}/close", response_model=schemas.POSOrderRead)
def close_order(
    order_id: int,
    payload: schemas.POSCloseRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    order = (
        db.query(POSOrder)
        .options(selectinload(POSOrder.items))
        .filter(POSOrder.id == order_id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    if order.status != POSOrderStatus.OPEN:
        raise HTTPException(status_code=400, detail="Order already closed")

    payment = POSPayment(order_id=order.id, amount_cents=payload.payment.amount_cents, method=payload.payment.method)
    db.add(payment)

    for item in order.items:
        recipes = db.query(RecipeItem).filter(RecipeItem.menu_item_id == item.menu_item_id).all()
        for recipe in recipes:
            movement = StockMovement(
                ingredient_id=recipe.ingredient_id,
                quantity_change=-recipe.quantity * item.quantity,
                reason="SALE",
                order_item_id=item.id,
            )
            db.add(movement)

    order.status = POSOrderStatus.CLOSED
    db.commit()
    db.refresh(order)
    return order
