import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload, selectinload

from app.config import settings
from app.core.security import get_password_hash, verify_password
from app.database import get_db
from app.models import (
    Employee,
    MenuCategory,
    POSAccessRole,
    POSCheckProgress,
    POSCredential,
    POSOrder,
    POSOrderItem,
    POSOrderStatus,
    POSTable,
    POSTableEvent,
    POSTableStatus,
    POSTerminalSession,
)


POS_COOKIE_NAME = "tss_pos_session"
POS_CATEGORIES = (
    "Drinks",
    "Apps",
    "Apps as Meal",
    "Salads",
    "Steaks",
    "Chicken",
    "Ribs",
    "Combos",
    "Prime",
    "Special",
    "Seafood",
)


@dataclass
class POSPrincipal:
    session: POSTerminalSession
    credential: POSCredential
    employee: Employee

    @property
    def is_manager(self) -> bool:
        return self.credential.access_role == POSAccessRole.MANAGER


def employee_display_name(employee: Employee) -> str:
    return employee.nickname or f"{employee.first_name} {employee.last_name}".strip()


def pin_lookup_digest(employee_number: str) -> str:
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        employee_number.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def terminal_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def ensure_pos_categories(db: Session) -> list[MenuCategory]:
    existing = {
        category.name: category
        for category in db.query(MenuCategory)
        .filter(MenuCategory.name.in_(POS_CATEGORIES))
        .all()
    }
    changed = False
    for display_order, name in enumerate(POS_CATEGORIES, start=1):
        category = existing.get(name)
        if category is None:
            category = MenuCategory(
                name=name,
                description="POS V1 category",
                active=True,
                display_order=display_order,
            )
            db.add(category)
            existing[name] = category
            changed = True
        else:
            if category.display_order != display_order:
                category.display_order = display_order
                changed = True
            if not category.active:
                category.active = True
                changed = True
    if changed:
        db.commit()
    return sorted(existing.values(), key=lambda row: row.display_order)


def serialize_access(employee: Employee, credential: POSCredential | None) -> dict:
    return {
        "employee_id": employee.id,
        "employee_name": employee_display_name(employee),
        "employee_role": employee.role.value,
        "access_role": credential.access_role if credential else None,
        "pos_active": bool(credential and credential.active),
        "has_employee_number": credential is not None,
        "last_used_at": credential.last_used_at if credential else None,
        "locked_until": credential.locked_until if credential else None,
    }


def upsert_pos_access(
    db: Session,
    employee: Employee,
    *,
    employee_number: str | None,
    access_role: POSAccessRole,
    active: bool,
) -> POSCredential:
    credential = (
        db.query(POSCredential)
        .filter(POSCredential.employee_id == employee.id)
        .first()
    )
    if credential is None and employee_number is None:
        raise HTTPException(
            status_code=422,
            detail="An employee number is required when enabling POS access",
        )

    if employee_number is not None:
        lookup = pin_lookup_digest(employee_number)
        duplicate = (
            db.query(POSCredential)
            .filter(
                POSCredential.pin_lookup_digest == lookup,
                POSCredential.employee_id != employee.id,
            )
            .first()
        )
        if duplicate:
            raise HTTPException(
                status_code=409,
                detail="That employee number is already assigned",
            )

    if credential is None:
        credential = POSCredential(
            employee_id=employee.id,
            pin_lookup_digest=lookup,
            pin_hash=get_password_hash(employee_number),
        )
        db.add(credential)
    elif employee_number is not None:
        credential.pin_lookup_digest = lookup
        credential.pin_hash = get_password_hash(employee_number)

    credential.access_role = access_role
    credential.active = active
    credential.failed_attempts = 0
    credential.locked_until = None
    for session in credential.sessions:
        if session.revoked_at is None:
            session.revoked_at = datetime.utcnow()
    db.commit()
    db.refresh(credential)
    return credential


def authenticate_employee_number(
    db: Session, employee_number: str
) -> tuple[str, POSTerminalSession, POSCredential]:
    now = datetime.utcnow()
    credential = (
        db.query(POSCredential)
        .options(joinedload(POSCredential.employee))
        .filter(POSCredential.pin_lookup_digest == pin_lookup_digest(employee_number))
        .first()
    )
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Employee number was not recognized",
    )
    if credential is None or not credential.active or not credential.employee.active:
        raise invalid
    if credential.locked_until and credential.locked_until > now:
        raise invalid
    if not verify_password(employee_number, credential.pin_hash):
        credential.failed_attempts += 1
        if credential.failed_attempts >= settings.pos_login_max_attempts:
            credential.locked_until = now + timedelta(
                minutes=settings.pos_login_lock_minutes
            )
            credential.failed_attempts = 0
        db.commit()
        raise invalid

    credential.failed_attempts = 0
    credential.locked_until = None
    credential.last_used_at = now
    token = secrets.token_urlsafe(40)
    terminal_session = POSTerminalSession(
        credential_id=credential.id,
        token_hash=terminal_token_hash(token),
        issued_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(hours=settings.pos_session_expire_hours),
    )
    db.add(terminal_session)
    db.commit()
    db.refresh(terminal_session)
    return token, terminal_session, credential


def get_current_pos_principal(
    request: Request,
    db: Session = Depends(get_db),
) -> POSPrincipal:
    token = request.cookies.get(POS_COOKIE_NAME)
    unauthorized = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="POS session is locked",
    )
    if not token:
        raise unauthorized
    terminal_session = (
        db.query(POSTerminalSession)
        .options(
            joinedload(POSTerminalSession.credential).joinedload(
                POSCredential.employee
            )
        )
        .filter(POSTerminalSession.token_hash == terminal_token_hash(token))
        .first()
    )
    if terminal_session is None:
        raise unauthorized

    now = datetime.utcnow()
    idle_deadline = terminal_session.last_seen_at + timedelta(
        seconds=settings.pos_idle_timeout_seconds
    )
    credential = terminal_session.credential
    if (
        terminal_session.revoked_at is not None
        or terminal_session.expires_at <= now
        or idle_deadline <= now
        or not credential.active
        or not credential.employee.active
    ):
        if terminal_session.revoked_at is None:
            terminal_session.revoked_at = now
            db.commit()
        raise unauthorized

    terminal_session.last_seen_at = now
    db.commit()
    return POSPrincipal(
        session=terminal_session,
        credential=credential,
        employee=credential.employee,
    )


def require_pos_manager(
    principal: POSPrincipal = Depends(get_current_pos_principal),
) -> POSPrincipal:
    if not principal.is_manager:
        raise HTTPException(status_code=403, detail="Manager POS access is required")
    return principal


def session_payload(principal: POSPrincipal) -> dict:
    return {
        "employee": {
            "employee_id": principal.employee.id,
            "employee_name": employee_display_name(principal.employee),
            "access_role": principal.credential.access_role,
        },
        "idle_timeout_seconds": settings.pos_idle_timeout_seconds,
        "expires_at": principal.session.expires_at,
    }


def _table_query(db: Session):
    return db.query(POSTable).options(
        joinedload(POSTable.owner),
        selectinload(POSTable.checks).selectinload(POSOrder.items).joinedload(POSOrderItem.menu_item),
    )


def serialize_check(check: POSOrder) -> dict:
    return {
        "id": check.id,
        "check_number": check.check_number,
        "status": check.status,
        "progress": check.progress,
        "subtotal_cents": check.subtotal_cents,
        "tax_cents": check.tax_cents,
        "tip_cents": check.tip_cents,
        "total_cents": check.total_cents,
        "print_count": check.print_count,
        "printed_at": check.printed_at,
        "closed_at": check.closed_at,
        "item_count": sum(item.quantity for item in check.items),
        "items": [
            {
                "id": item.id,
                "menu_item_id": item.menu_item_id,
                "display_name": item.display_name_snapshot or item.menu_item.name,
                "quantity": item.quantity,
                "price_cents": item.price_cents,
                "modifier_total_cents": item.modifier_total_cents,
                "configuration": item.configuration_snapshot or {},
            }
            for item in check.items
        ],
    }


def current_check(table: POSTable) -> POSOrder:
    if not table.checks:
        raise HTTPException(status_code=409, detail="Table does not have a check")
    open_checks = [
        check for check in table.checks if check.status == POSOrderStatus.OPEN
    ]
    return sorted(
        open_checks or table.checks,
        key=lambda row: (row.check_number, row.id),
    )[-1]


def serialize_table(table: POSTable) -> dict:
    return {
        "id": table.id,
        "table_number": table.table_number,
        "owner_employee_id": table.owner_employee_id,
        "owner_name": employee_display_name(table.owner),
        "status": table.status,
        "progress": table.progress,
        "revision": table.revision,
        "opened_at": table.opened_at,
        "closed_at": table.closed_at,
        "check": serialize_check(current_check(table)),
    }


def accessible_tables(db: Session, principal: POSPrincipal) -> list[POSTable]:
    query = _table_query(db).filter(POSTable.status == POSTableStatus.OPEN)
    if not principal.is_manager:
        query = query.filter(
            POSTable.owner_employee_id == principal.employee.id
        )
    return query.order_by(POSTable.table_number).all()


def get_accessible_table(
    db: Session,
    principal: POSPrincipal,
    table_id: int,
    *,
    include_closed: bool = False,
) -> POSTable:
    table = _table_query(db).filter(POSTable.id == table_id).first()
    if table is None or (not include_closed and table.status != POSTableStatus.OPEN):
        raise HTTPException(status_code=404, detail="POS table not found")
    if not principal.is_manager and table.owner_employee_id != principal.employee.id:
        raise HTTPException(status_code=403, detail="This table belongs to another server")
    return table


def record_table_event(
    db: Session,
    table: POSTable,
    employee_id: int,
    event_type: str,
    *,
    order: POSOrder | None = None,
    details: dict | None = None,
) -> POSTableEvent:
    event = POSTableEvent(
        table_id=table.id,
        order_id=order.id if order else None,
        employee_id=employee_id,
        event_type=event_type,
        details=details,
    )
    db.add(event)
    return event


def create_pos_table(
    db: Session,
    principal: POSPrincipal,
    *,
    table_number: int,
    client_request_id: str,
) -> POSTable:
    repeated = (
        _table_query(db)
        .filter(POSTable.client_request_id == client_request_id)
        .first()
    )
    if repeated:
        if repeated.owner_employee_id != principal.employee.id and not principal.is_manager:
            raise HTTPException(status_code=403, detail="Request belongs to another server")
        return repeated
    active_key = str(table_number)
    if (
        db.query(POSTable)
        .filter(POSTable.active_number_key == active_key)
        .first()
    ):
        raise HTTPException(status_code=409, detail="That table is already open")

    table = POSTable(
        table_number=table_number,
        client_request_id=client_request_id,
        active_number_key=active_key,
        owner_employee_id=principal.employee.id,
        status=POSTableStatus.OPEN,
        progress=POSCheckProgress.FOOD_UNORDERED,
    )
    try:
        db.add(table)
        db.flush()
        check = POSOrder(
            table_id=table.id,
            check_number=1,
            server_id=principal.employee.id,
            table_label=str(table_number),
            status=POSOrderStatus.OPEN,
            progress=POSCheckProgress.FOOD_UNORDERED,
        )
        db.add(check)
        db.flush()
        record_table_event(
            db,
            table,
            principal.employee.id,
            "TABLE_OPENED",
            order=check,
            details={"table_number": table_number},
        )
        db.commit()
    except IntegrityError:
        db.rollback()
        repeated = (
            _table_query(db)
            .filter(POSTable.client_request_id == client_request_id)
            .first()
        )
        if repeated:
            if (
                repeated.owner_employee_id != principal.employee.id
                and not principal.is_manager
            ):
                raise HTTPException(
                    status_code=403,
                    detail="Request belongs to another server",
                )
            return repeated
        if (
            db.query(POSTable)
            .filter(POSTable.active_number_key == active_key)
            .first()
        ):
            raise HTTPException(
                status_code=409,
                detail="That table is already open",
            )
        raise
    return _table_query(db).filter(POSTable.id == table.id).one()


def transfer_pos_table(
    db: Session,
    principal: POSPrincipal,
    table: POSTable,
    *,
    owner_employee_id: int,
    revision: int,
) -> POSTable:
    if not principal.is_manager:
        raise HTTPException(status_code=403, detail="Manager POS access is required")
    if table.revision != revision:
        raise HTTPException(status_code=409, detail="Table changed; refresh and try again")
    target_credential = (
        db.query(POSCredential)
        .options(joinedload(POSCredential.employee))
        .filter(
            POSCredential.employee_id == owner_employee_id,
            POSCredential.active.is_(True),
            POSCredential.access_role == POSAccessRole.SERVER,
        )
        .first()
    )
    if target_credential is None or not target_credential.employee.active:
        raise HTTPException(status_code=422, detail="Choose an active POS server")

    previous_owner_id = table.owner_employee_id
    table.owner_employee_id = owner_employee_id
    table.revision += 1
    check = current_check(table)
    check.server_id = owner_employee_id
    record_table_event(
        db,
        table,
        principal.employee.id,
        "TABLE_TRANSFERRED",
        order=check,
        details={
            "previous_owner_employee_id": previous_owner_id,
            "owner_employee_id": owner_employee_id,
        },
    )
    db.commit()
    return _table_query(db).filter(POSTable.id == table.id).one()


def start_check_print(
    db: Session,
    principal: POSPrincipal,
    table: POSTable,
) -> POSOrder:
    check = current_check(table)
    check.print_count += 1
    check.printed_at = datetime.utcnow()
    record_table_event(
        db,
        table,
        principal.employee.id,
        "CHECK_PRINTED",
        order=check,
        details={"print_count": check.print_count},
    )
    db.commit()
    db.refresh(check)
    return check


def close_empty_check(
    db: Session,
    principal: POSPrincipal,
    table: POSTable,
    *,
    revision: int,
) -> POSTable:
    if table.revision != revision:
        raise HTTPException(status_code=409, detail="Table changed; refresh and try again")
    check = current_check(table)
    if check.items or check.total_cents != 0:
        raise HTTPException(
            status_code=409,
            detail="Only an empty zero-dollar check can use this V1 close action",
        )
    now = datetime.utcnow()
    check.status = POSOrderStatus.CLOSED
    check.progress = POSCheckProgress.CHECK_PAID
    check.closed_at = now
    table.status = POSTableStatus.CLOSED
    table.progress = POSCheckProgress.CHECK_PAID
    table.closed_at = now
    table.active_number_key = None
    table.revision += 1
    record_table_event(
        db,
        table,
        principal.employee.id,
        "EMPTY_CHECK_CLOSED",
        order=check,
        details={"total_cents": 0},
    )
    db.commit()
    return _table_query(db).filter(POSTable.id == table.id).one()


def manager_transfer_candidates(db: Session) -> list[POSCredential]:
    return (
        db.query(POSCredential)
        .options(joinedload(POSCredential.employee))
        .filter(
            POSCredential.active.is_(True),
            POSCredential.access_role == POSAccessRole.SERVER,
        )
        .join(Employee, Employee.id == POSCredential.employee_id)
        .filter(Employee.active.is_(True))
        .order_by(Employee.first_name, Employee.last_name)
        .all()
    )
