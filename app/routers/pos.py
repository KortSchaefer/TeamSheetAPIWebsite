from datetime import datetime
from html import escape

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session, selectinload

from app import schemas
from app.config import settings
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Employee, MenuCategory, MenuItem, POSCredential, POSOrder, POSOrderItem, POSOrderStatus, POSPayment, POSTerminalSession, RecipeItem, StockMovement, User
from app.services.inventory_events import record_recipe_sale
from app.services.pos_terminal import (
    POS_COOKIE_NAME,
    POSPrincipal,
    accessible_tables,
    authenticate_employee_number,
    close_empty_check,
    create_pos_table,
    current_check,
    employee_display_name,
    ensure_pos_categories,
    get_accessible_table,
    get_current_pos_principal,
    manager_transfer_candidates,
    serialize_access,
    serialize_table,
    session_payload,
    start_check_print,
    terminal_token_hash,
    transfer_pos_table,
    upsert_pos_access,
)
from app.services.pos_configuration import configuration_bundle

router = APIRouter(prefix="/pos", tags=["pos"])


def _request_uses_https(request: Request) -> bool:
    forwarded_proto = request.headers.get("x-forwarded-proto")
    scheme = forwarded_proto.split(",", 1)[0].strip() if forwarded_proto else request.url.scheme
    return scheme == "https"


@router.get("/menu-categories", response_model=list[schemas.MenuCategoryRead])
def list_menu_categories(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(MenuCategory).order_by(MenuCategory.display_order, MenuCategory.name).all()


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
        record_recipe_sale(db, item.id, item.menu_item_id, item.quantity)

    order.status = POSOrderStatus.CLOSED
    db.commit()
    db.refresh(order)
    return order


@router.get("/admin/access", response_model=list[schemas.POSAccessRead])
def list_pos_access(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    credentials = {
        credential.employee_id: credential
        for credential in db.query(POSCredential).all()
    }
    employees = db.query(Employee).order_by(Employee.first_name, Employee.last_name).all()
    return [
        serialize_access(employee, credentials.get(employee.id))
        for employee in employees
    ]


@router.put("/admin/access/{employee_id}", response_model=schemas.POSAccessRead)
def configure_pos_access(
    employee_id: int,
    payload: schemas.POSAccessUpsert,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if employee is None:
        raise HTTPException(status_code=404, detail="Employee not found")
    credential = upsert_pos_access(
        db,
        employee,
        employee_number=payload.employee_number,
        access_role=payload.access_role,
        active=payload.active,
    )
    return serialize_access(employee, credential)


@router.post("/pin/login", response_model=schemas.POSTerminalSessionRead)
def pos_pin_login(
    payload: schemas.POSPinLogin,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    token, terminal_session, credential = authenticate_employee_number(
        db, payload.employee_number
    )
    response.set_cookie(
        POS_COOKIE_NAME,
        token,
        max_age=settings.pos_session_expire_hours * 60 * 60,
        httponly=True,
        samesite="strict",
        secure=_request_uses_https(request),
        path="/",
    )
    principal = POSPrincipal(
        session=terminal_session,
        credential=credential,
        employee=credential.employee,
    )
    return session_payload(principal)


@router.post("/pin/logout", status_code=status.HTTP_204_NO_CONTENT)
def pos_pin_logout(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    token = request.cookies.get(POS_COOKIE_NAME)
    if token:
        terminal_session = (
            db.query(POSTerminalSession)
            .filter(
                POSTerminalSession.token_hash == terminal_token_hash(token)
            )
            .first()
        )
        if terminal_session and terminal_session.revoked_at is None:
            terminal_session.revoked_at = datetime.utcnow()
            db.commit()
    response.delete_cookie(
        POS_COOKIE_NAME,
        path="/",
        samesite="strict",
        secure=_request_uses_https(request),
    )
    return None


@router.get("/pin/session", response_model=schemas.POSTerminalSessionRead)
def pos_pin_session(
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    return session_payload(principal)


@router.get("/terminal/bootstrap", response_model=schemas.POSTerminalBootstrapRead)
def terminal_bootstrap(
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    categories = ensure_pos_categories(db)
    resolved_config = configuration_bundle(db, include_deleted=False, resolve=True)
    menu_config = {
        "schema_version": resolved_config["schema_version"],
        "pages": [page for page in resolved_config["pages"] if page["active"]],
        "buttons": resolved_config["buttons"],
    }
    tables = [
        serialize_table(table) for table in accessible_tables(db, principal)
    ]
    transfer_candidates = []
    if principal.is_manager:
        transfer_candidates = [
            {
                "employee_id": credential.employee.id,
                "employee_name": employee_display_name(credential.employee),
                "access_role": credential.access_role,
            }
            for credential in manager_transfer_candidates(db)
        ]
    return {
        **session_payload(principal),
        "permissions": {
            "view_all_tables": principal.is_manager,
            "transfer_tables": principal.is_manager,
        },
        "features": {
            "menu_items": True,
            "payments": False,
            "tips": False,
            "promos": False,
            "comps": False,
            "checkout": False,
        },
        "categories": categories,
        "tables": tables,
        "transfer_candidates": transfer_candidates,
        "menu_config": menu_config,
    }


@router.get("/terminal/tables", response_model=list[schemas.POSTableRead])
def terminal_tables(
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    return [
        serialize_table(table) for table in accessible_tables(db, principal)
    ]


@router.post(
    "/terminal/tables",
    response_model=schemas.POSTableRead,
    status_code=status.HTTP_201_CREATED,
)
def terminal_create_table(
    payload: schemas.POSTableCreate,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    return serialize_table(
        create_pos_table(
            db,
            principal,
            table_number=payload.table_number,
            client_request_id=payload.client_request_id,
        )
    )


@router.get("/terminal/tables/{table_id}", response_model=schemas.POSTableRead)
def terminal_table(
    table_id: int,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    return serialize_table(get_accessible_table(db, principal, table_id))


@router.post(
    "/terminal/tables/{table_id}/transfer",
    response_model=schemas.POSTableRead,
)
def terminal_transfer_table(
    table_id: int,
    payload: schemas.POSTableTransfer,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    table = get_accessible_table(db, principal, table_id)
    return serialize_table(
        transfer_pos_table(
            db,
            principal,
            table,
            owner_employee_id=payload.owner_employee_id,
            revision=payload.revision,
        )
    )


def _table_for_check(
    db: Session,
    principal: POSPrincipal,
    check_id: int,
    *,
    include_closed: bool = False,
):
    check = db.query(POSOrder).filter(POSOrder.id == check_id).first()
    if check is None or check.table_id is None:
        raise HTTPException(status_code=404, detail="POS check not found")
    table = get_accessible_table(
        db, principal, check.table_id, include_closed=include_closed
    )
    if current_check(table).id != check_id:
        raise HTTPException(status_code=404, detail="POS check not found")
    return table, check


@router.post(
    "/terminal/checks/{check_id}/print",
    response_model=schemas.POSPrintStartRead,
)
def terminal_print_check(
    check_id: int,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    table, _ = _table_for_check(db, principal, check_id)
    check = start_check_print(db, principal, table)
    return {
        "print_url": f"/pos/terminal/checks/{check.id}/print-view",
        "print_count": check.print_count,
        "printed_at": check.printed_at,
    }


@router.get(
    "/terminal/checks/{check_id}/print-view",
    response_class=HTMLResponse,
)
def terminal_print_view(
    check_id: int,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    table, check = _table_for_check(
        db, principal, check_id, include_closed=True
    )
    opened = table.opened_at.strftime("%m/%d/%Y %I:%M %p")
    closed = (
        table.closed_at.strftime("%m/%d/%Y %I:%M %p")
        if table.closed_at
        else "Open"
    )
    owner = escape(employee_display_name(table.owner))
    item_rows = "".join(
        f'<div class="row"><span>{item.quantity} x {escape(item.display_name_snapshot or item.menu_item.name)}</span>'
        f'<span>${((item.price_cents + item.modifier_total_cents) * item.quantity) / 100:.2f}</span></div>'
        for item in check.items
    ) or '<p class="center">No menu items</p>'
    return HTMLResponse(
        f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Table {table.table_number} Check</title>
<style>
body{{font:14px/1.35 ui-monospace,Consolas,monospace;margin:0;color:#111}}
.receipt{{width:72mm;margin:0 auto;padding:8mm 4mm}}h1{{font-size:22px;text-align:center;margin:0}}
.center{{text-align:center}}.rule{{border-top:1px dashed #111;margin:12px 0}}
.row{{display:flex;justify-content:space-between;gap:10px}}.total{{font-size:18px;font-weight:800}}
@media print{{@page{{size:80mm auto;margin:0}}button{{display:none}}}}
</style></head><body><main class="receipt">
<h1>Team Sheet POS</h1><p class="center">Training Check — No Menu Items</p>
<div class="rule"></div>
<div class="row"><span>Table</span><strong>{table.table_number}</strong></div>
<div class="row"><span>Check</span><span>{check.check_number}</span></div>
<div class="row"><span>Server</span><span>{owner}</span></div>
<div class="row"><span>Opened</span><span>{opened}</span></div>
<div class="row"><span>Closed</span><span>{closed}</span></div>
<div class="rule"></div>
{item_rows}
<div class="rule"></div>
<div class="row total"><span>Total</span><span>${check.total_cents / 100:.2f}</span></div>
<p class="center"><button onclick="window.print()">Print Check</button></p>
<script>window.addEventListener('load',()=>window.print())</script>
</main></body></html>"""
    )


@router.post(
    "/terminal/checks/{check_id}/close-empty",
    response_model=schemas.POSTableRead,
)
def terminal_close_empty_check(
    check_id: int,
    payload: schemas.POSCloseEmptyRequest,
    db: Session = Depends(get_db),
    principal: POSPrincipal = Depends(get_current_pos_principal),
):
    table, _ = _table_for_check(db, principal, check_id)
    return serialize_table(
        close_empty_check(
            db,
            principal,
            table,
            revision=payload.revision,
        )
    )
