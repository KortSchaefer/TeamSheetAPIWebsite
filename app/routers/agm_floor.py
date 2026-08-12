from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from jose import JWTError, jwt
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import get_current_manager_or_admin, require_manager_or_admin
from app.database import SessionLocal, get_db
from app.models import Employee, Shift, TeamSheet, TeamSheetAssignment, User, UserRole
from app.models.agm_floor import (
    AGMEvent,
    AGMLayout,
    AGMParty,
    AGMServerRotation,
    AGMService,
    AGMSmsOutbox,
    AGMStore,
    AGMStoreMembership,
    AGMTableDefinition,
    AGMTableState,
)
from app.schemas.agm_floor import (
    AGMCommand,
    AGMLayoutCreate,
    AGMLayoutUpdate,
    AGMPartyCreate,
    AGMPartyUpdate,
    AGMRotationInput,
    AGMServiceCreate,
    AGMStoreCreate,
    AGMStoreMembershipCreate,
)

router = APIRouter(prefix="/agm", tags=["agm-floor"])


@router.websocket("/services/{service_id}/events")
async def service_events(websocket: WebSocket, service_id: int):
    token = websocket.cookies.get("tss_access_token")
    if not token:
        await websocket.close(code=4401)
        return
    db = SessionLocal()
    try:
        try:
            payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
            user = db.query(User).filter(User.id == int(payload.get("sub", 0))).first()
            if user is None:
                raise ValueError("Unknown user")
            require_manager_or_admin(user)
        except (JWTError, ValueError, HTTPException):
            await websocket.close(code=4403)
            return
        service = db.query(AGMService).filter(AGMService.id == service_id).first()
        if service is None:
            await websocket.close(code=4404)
            return
        try:
            _store_access(db, user, service.store_id)
        except HTTPException:
            await websocket.close(code=4403)
            return
        await websocket.accept()
        await websocket.send_json({"type": "connected", "revision": service.revision})
        while True:
            message = await websocket.receive_text()
            if message == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        pass
    finally:
        db.close()


def _store_access(db: Session, user: User, store_id: int) -> AGMStore:
    store = db.query(AGMStore).filter(AGMStore.id == store_id, AGMStore.active.is_(True)).first()
    if store is None:
        raise HTTPException(status_code=404, detail="Store not found")
    membership = db.query(AGMStoreMembership).filter(
        AGMStoreMembership.store_id == store_id,
        AGMStoreMembership.user_id == user.id,
        AGMStoreMembership.active.is_(True),
    ).first()
    if membership is None and user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="You do not have access to this store")
    return store


def _table_dict(row: AGMTableDefinition) -> dict[str, Any]:
    return {
        "id": row.id,
        "table_number": row.table_number,
        "label": row.label,
        "capacity": row.capacity,
        "shape": row.shape,
        "x": row.x,
        "y": row.y,
        "width": row.width,
        "height": row.height,
        "rotation": row.rotation,
        "area_name": row.area_name,
        "section_name": row.section_name,
        "combinable_with": row.combinable_with or [],
    }


def _layout_dict(db: Session, row: AGMLayout, include_tables: bool = True) -> dict[str, Any]:
    result = {
        "id": row.id,
        "store_id": row.store_id,
        "name": row.name,
        "version": row.version,
        "status": row.status,
        "revision": row.revision,
        "canvas_width": row.canvas_width,
        "canvas_height": row.canvas_height,
        "areas": row.areas or [],
        "fixtures": row.fixtures or [],
        "published_at": row.published_at,
        "created_at": row.created_at,
    }
    if include_tables:
        rows = db.query(AGMTableDefinition).filter(
            AGMTableDefinition.layout_id == row.id
        ).order_by(AGMTableDefinition.table_number).all()
        result["tables"] = [_table_dict(item) for item in rows]
    return result


def _party_dict(row: AGMParty) -> dict[str, Any]:
    return {
        "id": row.id,
        "store_id": row.store_id,
        "service_id": row.service_id,
        "source": row.source,
        "status": row.status,
        "guest_name": row.guest_name,
        "phone": row.phone,
        "party_size": row.party_size,
        "reservation_at": row.reservation_at,
        "quoted_minutes": row.quoted_minutes,
        "notes": row.notes,
        "sms_consent": row.sms_consent,
        "table_numbers": row.table_numbers or [],
        "server_employee_id": row.server_employee_id,
        "dining_stage": row.dining_stage,
        "seated_at": row.seated_at,
        "cleared_at": row.cleared_at,
        "revision": row.revision,
        "created_at": row.created_at,
    }


def _service_dict(row: AGMService) -> dict[str, Any]:
    return {
        "id": row.id,
        "store_id": row.store_id,
        "layout_id": row.layout_id,
        "service_date": row.service_date,
        "name": row.name,
        "status": row.status,
        "starts_at": row.starts_at,
        "ends_at": row.ends_at,
        "revision": row.revision,
        "closed_at": row.closed_at,
    }


def _ensure_default_membership(db: Session, user: User) -> None:
    if user.role not in {UserRole.MANAGER, UserRole.ADMIN}:
        return
    store = db.query(AGMStore).filter(AGMStore.store_number == "1").first()
    if store is None:
        store = AGMStore(store_number="1", name="Restaurant 1")
        db.add(store)
        db.flush()
    existing = db.query(AGMStoreMembership).filter(
        AGMStoreMembership.store_id == store.id,
        AGMStoreMembership.user_id == user.id,
    ).first()
    if existing is None:
        db.add(AGMStoreMembership(
            store_id=store.id,
            user_id=user.id,
            access_role="ADMIN" if user.role == UserRole.ADMIN else "AGM",
        ))
    db.commit()


@router.get("/bootstrap")
def bootstrap(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _ensure_default_membership(db, current_user)
    query = db.query(AGMStore)
    if current_user.role != UserRole.ADMIN:
        query = query.join(AGMStoreMembership).filter(
            AGMStoreMembership.user_id == current_user.id,
            AGMStoreMembership.active.is_(True),
        )
    stores = query.filter(AGMStore.active.is_(True)).order_by(AGMStore.store_number).all()
    return {
        "stores": [{"id": row.id, "store_number": row.store_number, "name": row.name, "timezone": row.timezone} for row in stores],
        "permissions": {"manage_memberships": current_user.role == UserRole.ADMIN, "publish_layouts": True},
        "sms_provider": {"configured": False, "name": None},
    }


@router.post("/stores", status_code=status.HTTP_201_CREATED)
def create_store(
    payload: AGMStoreCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can create stores")
    if db.query(AGMStore).filter(AGMStore.store_number == payload.store_number).first():
        raise HTTPException(status_code=409, detail="Store number already exists")
    row = AGMStore(**payload.model_dump())
    db.add(row)
    db.flush()
    db.add(AGMStoreMembership(store_id=row.id, user_id=current_user.id, access_role="ADMIN"))
    db.commit()
    db.refresh(row)
    return {"id": row.id, **payload.model_dump()}


@router.post("/stores/{store_id}/memberships", status_code=status.HTTP_201_CREATED)
def add_membership(
    store_id: int,
    payload: AGMStoreMembershipCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _store_access(db, current_user, store_id)
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can manage store access")
    row = db.query(AGMStoreMembership).filter(
        AGMStoreMembership.store_id == store_id,
        AGMStoreMembership.user_id == payload.user_id,
    ).first()
    if row:
        row.access_role = payload.access_role
        row.active = True
    else:
        row = AGMStoreMembership(store_id=store_id, **payload.model_dump())
        db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": row.id, "store_id": store_id, "user_id": row.user_id, "access_role": row.access_role, "active": row.active}


@router.get("/stores/{store_id}/layouts")
def list_layouts(
    store_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _store_access(db, current_user, store_id)
    rows = db.query(AGMLayout).filter(AGMLayout.store_id == store_id).order_by(AGMLayout.created_at.desc()).all()
    return [_layout_dict(db, row, include_tables=False) for row in rows]


def _replace_layout_tables(db: Session, layout: AGMLayout, tables) -> None:
    db.query(AGMTableDefinition).filter(AGMTableDefinition.layout_id == layout.id).delete()
    for item in tables:
        db.add(AGMTableDefinition(layout_id=layout.id, **item.model_dump()))


@router.post("/stores/{store_id}/layouts", status_code=status.HTTP_201_CREATED)
def create_layout(
    store_id: int,
    payload: AGMLayoutCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _store_access(db, current_user, store_id)
    version = (db.query(func.max(AGMLayout.version)).filter(
        AGMLayout.store_id == store_id, AGMLayout.name == payload.name
    ).scalar() or 0) + 1
    data = payload.model_dump(exclude={"tables"})
    row = AGMLayout(store_id=store_id, version=version, created_by_user_id=current_user.id, **data)
    db.add(row)
    db.flush()
    _replace_layout_tables(db, row, payload.tables)
    db.commit()
    db.refresh(row)
    return _layout_dict(db, row)


@router.get("/layouts/{layout_id}")
def get_layout(
    layout_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    row = db.query(AGMLayout).filter(AGMLayout.id == layout_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Layout not found")
    _store_access(db, current_user, row.store_id)
    return _layout_dict(db, row)


@router.put("/layouts/{layout_id}")
def update_layout(
    layout_id: int,
    payload: AGMLayoutUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    row = db.query(AGMLayout).filter(AGMLayout.id == layout_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Layout not found")
    _store_access(db, current_user, row.store_id)
    if row.status != "DRAFT":
        raise HTTPException(status_code=409, detail="Published layouts are immutable; create a new draft")
    if row.revision != payload.revision:
        raise HTTPException(status_code=409, detail="Layout revision is stale")
    for key, value in payload.model_dump(exclude={"tables", "revision"}).items():
        setattr(row, key, value)
    row.revision += 1
    _replace_layout_tables(db, row, payload.tables)
    db.commit()
    db.refresh(row)
    return _layout_dict(db, row)


@router.post("/layouts/{layout_id}/publish")
def publish_layout(
    layout_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    row = db.query(AGMLayout).filter(AGMLayout.id == layout_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Layout not found")
    _store_access(db, current_user, row.store_id)
    table_count = db.query(AGMTableDefinition).filter(AGMTableDefinition.layout_id == row.id).count()
    if table_count == 0:
        raise HTTPException(status_code=422, detail="Add at least one table before publishing")
    db.query(AGMLayout).filter(
        AGMLayout.store_id == row.store_id, AGMLayout.status == "PUBLISHED", AGMLayout.id != row.id
    ).update({AGMLayout.status: "ARCHIVED"})
    row.status = "PUBLISHED"
    row.published_at = datetime.utcnow()
    row.revision += 1
    db.commit()
    db.refresh(row)
    return _layout_dict(db, row)


@router.get("/stores/{store_id}/services")
def list_services(
    store_id: int,
    service_date: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _store_access(db, current_user, store_id)
    query = db.query(AGMService).filter(AGMService.store_id == store_id)
    if service_date:
        query = query.filter(AGMService.service_date == service_date)
    return [_service_dict(row) for row in query.order_by(AGMService.service_date.desc()).all()]


@router.post("/stores/{store_id}/services", status_code=status.HTTP_201_CREATED)
def create_service(
    store_id: int,
    payload: AGMServiceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _store_access(db, current_user, store_id)
    layout = db.query(AGMLayout).filter(
        AGMLayout.id == payload.layout_id,
        AGMLayout.store_id == store_id,
        AGMLayout.status == "PUBLISHED",
    ).first()
    if layout is None:
        raise HTTPException(status_code=422, detail="Choose a published layout for this store")
    existing = db.query(AGMService).filter(
        AGMService.store_id == store_id,
        AGMService.service_date == payload.service_date,
        AGMService.name == payload.name,
    ).first()
    if existing:
        return _service_dict(existing)
    row = AGMService(store_id=store_id, opened_by_user_id=current_user.id, **payload.model_dump())
    db.add(row)
    db.flush()
    tables = db.query(AGMTableDefinition).filter(AGMTableDefinition.layout_id == layout.id).all()
    db.add_all([AGMTableState(service_id=row.id, table_number=item.table_number) for item in tables])
    db.commit()
    db.refresh(row)
    return _service_dict(row)


def _recommendations(db: Session, service: AGMService) -> list[dict[str, Any]]:
    parties = db.query(AGMParty).filter(
        AGMParty.service_id == service.id,
        AGMParty.status.in_(["WAITING", "ARRIVED", "NOTIFIED"]),
    ).order_by(AGMParty.reservation_at.asc(), AGMParty.created_at.asc()).all()
    states = db.query(AGMTableState).filter(
        AGMTableState.service_id == service.id, AGMTableState.status == "AVAILABLE"
    ).all()
    definitions = {
        row.table_number: row for row in db.query(AGMTableDefinition).filter(
            AGMTableDefinition.layout_id == service.layout_id
        ).all()
    }
    servers = db.query(AGMServerRotation).filter(
        AGMServerRotation.service_id == service.id, AGMServerRotation.paused.is_(False)
    ).order_by(AGMServerRotation.covers, AGMServerRotation.turns, AGMServerRotation.rotation_index).all()
    result = []
    for party in parties[:8]:
        suitable = [state for state in states if definitions.get(state.table_number) and definitions[state.table_number].capacity >= party.party_size]
        suitable.sort(key=lambda state: (definitions[state.table_number].capacity - party.party_size, state.table_number))
        result.append({
            "party_id": party.id,
            "table_number": suitable[0].table_number if suitable else None,
            "server_employee_id": servers[0].employee_id if servers else None,
            "reason": "Best capacity fit with the lightest active server rotation" if suitable else "No single available table fits this party",
        })
    return result


@router.get("/services/{service_id}/bootstrap")
def service_bootstrap(
    service_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    service = db.query(AGMService).filter(AGMService.id == service_id).first()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    _store_access(db, current_user, service.store_id)
    states = db.query(AGMTableState).filter(AGMTableState.service_id == service.id).all()
    parties = db.query(AGMParty).filter(AGMParty.service_id == service.id).order_by(AGMParty.created_at).all()
    rotations = db.query(AGMServerRotation, Employee).join(Employee, Employee.id == AGMServerRotation.employee_id).filter(
        AGMServerRotation.service_id == service.id
    ).order_by(AGMServerRotation.rotation_index).all()
    return {
        "service": _service_dict(service),
        "layout": _layout_dict(db, db.query(AGMLayout).filter(AGMLayout.id == service.layout_id).one()),
        "table_states": [{"table_number": row.table_number, "status": row.status, "party_id": row.party_id, "revision": row.revision} for row in states],
        "parties": [_party_dict(row) for row in parties],
        "rotation": [{"employee_id": row.employee_id, "employee_name": employee.nickname or f"{employee.first_name} {employee.last_name}", "section_name": row.section_name, "paused": row.paused, "turns": row.turns, "covers": row.covers, "last_sat_at": row.last_sat_at} for row, employee in rotations],
        "recommendations": _recommendations(db, service),
        "sms_provider": {"configured": False},
    }


@router.get("/services/{service_id}/parties")
def list_parties(
    service_id: int,
    source: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    service = db.query(AGMService).filter(AGMService.id == service_id).first()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    _store_access(db, current_user, service.store_id)
    query = db.query(AGMParty).filter(AGMParty.service_id == service_id)
    if source:
        query = query.filter(AGMParty.source == source.upper())
    return [_party_dict(row) for row in query.order_by(AGMParty.reservation_at, AGMParty.created_at).all()]


@router.post("/services/{service_id}/parties", status_code=status.HTTP_201_CREATED)
def create_party(
    service_id: int,
    payload: AGMPartyCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    service = db.query(AGMService).filter(AGMService.id == service_id).first()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    _store_access(db, current_user, service.store_id)
    default_status = "BOOKED" if payload.source == "RESERVATION" else "WAITING"
    row = AGMParty(store_id=service.store_id, service_id=service.id, **payload.model_dump(exclude={"status"}), status=payload.status or default_status)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _party_dict(row)


@router.patch("/parties/{party_id}")
def update_party(
    party_id: int,
    payload: AGMPartyUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    row = db.query(AGMParty).filter(AGMParty.id == party_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Party not found")
    _store_access(db, current_user, row.store_id)
    if row.revision != payload.revision:
        raise HTTPException(status_code=409, detail="Party revision is stale")
    for key, value in payload.model_dump(exclude_unset=True, exclude={"revision"}).items():
        setattr(row, key, value)
    row.revision += 1
    db.commit()
    db.refresh(row)
    return _party_dict(row)


def _event_result(db: Session, service: AGMService, event: AGMEvent) -> dict[str, Any]:
    return {
        "service_revision": service.revision,
        "event": {"sequence": event.sequence, "command_id": event.command_id, "type": event.event_type, "payload": event.payload},
        "recommendations": _recommendations(db, service),
    }


@router.post("/services/{service_id}/commands")
def apply_command(
    service_id: int,
    payload: AGMCommand,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    service = db.query(AGMService).filter(AGMService.id == service_id).first()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    _store_access(db, current_user, service.store_id)
    previous = db.query(AGMEvent).filter(AGMEvent.service_id == service_id, AGMEvent.command_id == payload.command_id).first()
    if previous:
        return _event_result(db, service, previous)
    if service.status != "OPEN" and payload.type != "CLOSE_SERVICE":
        raise HTTPException(status_code=409, detail="Service is not open")
    if service.revision != payload.expected_revision:
        raise HTTPException(status_code=409, detail="Service revision is stale")

    party = db.query(AGMParty).filter(AGMParty.id == payload.party_id, AGMParty.service_id == service_id).first() if payload.party_id else None
    states = db.query(AGMTableState).filter(
        AGMTableState.service_id == service_id,
        AGMTableState.table_number.in_(payload.table_numbers or [""]),
    ).all()
    now = datetime.utcnow()

    if payload.type in {"SEAT", "MOVE", "COMBINE"}:
        if party is None:
            raise HTTPException(status_code=422, detail="Choose a party")
        if not payload.table_numbers or len(states) != len(set(payload.table_numbers)):
            raise HTTPException(status_code=422, detail="Choose valid tables")
        blocked = [row.table_number for row in states if row.status != "AVAILABLE" and row.party_id != party.id]
        if blocked:
            raise HTTPException(status_code=409, detail=f"Tables are unavailable: {', '.join(blocked)}")
        definitions = db.query(AGMTableDefinition).filter(
            AGMTableDefinition.layout_id == service.layout_id,
            AGMTableDefinition.table_number.in_(payload.table_numbers),
        ).all()
        if sum(row.capacity for row in definitions) < party.party_size:
            raise HTTPException(status_code=422, detail="Selected tables do not fit the party")
        db.query(AGMTableState).filter(
            AGMTableState.service_id == service_id, AGMTableState.party_id == party.id
        ).update({AGMTableState.status: "AVAILABLE", AGMTableState.party_id: None, AGMTableState.revision: AGMTableState.revision + 1})
        for row in states:
            row.status = "SEATED"
            row.party_id = party.id
            row.revision += 1
        party.status = "SEATED"
        party.table_numbers = payload.table_numbers
        party.server_employee_id = payload.server_employee_id
        party.dining_stage = "SEATED"
        party.seated_at = party.seated_at or now
        party.revision += 1
        if payload.type == "SEAT" and payload.server_employee_id:
            rotation = db.query(AGMServerRotation).filter(
                AGMServerRotation.service_id == service_id,
                AGMServerRotation.employee_id == payload.server_employee_id,
            ).first()
            if rotation:
                rotation.turns += 1
                rotation.covers += party.party_size
                rotation.last_sat_at = now
    elif payload.type == "CLEAR":
        if party is None:
            raise HTTPException(status_code=422, detail="Choose a seated party")
        db.query(AGMTableState).filter(
            AGMTableState.service_id == service_id, AGMTableState.party_id == party.id
        ).update({AGMTableState.status: "CLEANING", AGMTableState.party_id: None, AGMTableState.revision: AGMTableState.revision + 1})
        party.status = "COMPLETED"
        party.cleared_at = now
        party.revision += 1
    elif payload.type == "SET_TABLE_STATUS":
        if not states or payload.status not in {"AVAILABLE", "HELD", "CLEANING", "BLOCKED"}:
            raise HTTPException(status_code=422, detail="Choose tables and a valid status")
        for row in states:
            if row.party_id is not None:
                raise HTTPException(status_code=409, detail="Move or clear the seated party first")
            row.status = payload.status
            row.revision += 1
    elif payload.type == "ADVANCE_STAGE":
        if party is None or payload.dining_stage not in {"SEATED", "ORDERED", "ENTREES", "CHECK_DROPPED"}:
            raise HTTPException(status_code=422, detail="Choose a seated party and dining stage")
        party.dining_stage = payload.dining_stage
        party.revision += 1
    elif payload.type == "NOTIFY":
        if party is None:
            raise HTTPException(status_code=422, detail="Choose a party")
        if not party.phone or not party.sms_consent:
            raise HTTPException(status_code=422, detail="SMS consent and a phone number are required")
        party.status = "NOTIFIED"
        party.revision += 1
        db.add(AGMSmsOutbox(
            store_id=service.store_id,
            party_id=party.id,
            template_key="TABLE_READY",
            recipient_phone=party.phone,
            body=f"{party.guest_name}, your table is ready. Please return to the host stand.",
            status="PROVIDER_UNCONFIGURED",
        ))
    elif payload.type == "PAUSE_SERVER":
        rotation = db.query(AGMServerRotation).filter(
            AGMServerRotation.service_id == service_id,
            AGMServerRotation.employee_id == payload.server_employee_id,
        ).first()
        if rotation is None or payload.paused is None:
            raise HTTPException(status_code=422, detail="Choose a server and pause state")
        rotation.paused = payload.paused
    elif payload.type == "CLOSE_SERVICE":
        occupied = db.query(AGMTableState).filter(
            AGMTableState.service_id == service_id, AGMTableState.party_id.is_not(None)
        ).count()
        if occupied:
            raise HTTPException(status_code=409, detail="Clear all seated parties before closing service")
        service.status = "CLOSED"
        service.closed_at = now
    else:
        raise HTTPException(status_code=422, detail="Unsupported command")

    service.revision += 1
    event = AGMEvent(
        service_id=service.id,
        sequence=service.revision,
        command_id=payload.command_id,
        event_type=payload.type,
        payload=payload.model_dump(mode="json"),
        actor_user_id=current_user.id,
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return _event_result(db, service, event)


@router.get("/services/{service_id}/rotation")
def get_rotation_options(
    service_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    service = db.query(AGMService).filter(AGMService.id == service_id).first()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    _store_access(db, current_user, service.store_id)
    current = db.query(AGMServerRotation, Employee).join(
        Employee, Employee.id == AGMServerRotation.employee_id
    ).filter(AGMServerRotation.service_id == service_id).order_by(AGMServerRotation.rotation_index).all()
    assigned = db.query(TeamSheetAssignment, Employee).join(
        TeamSheet, TeamSheet.id == TeamSheetAssignment.team_sheet_id
    ).join(Shift, Shift.id == TeamSheet.shift_id).join(
        Employee, Employee.id == TeamSheetAssignment.employee_id
    ).filter(
        TeamSheet.status == "PUBLISHED",
        Shift.date == service.service_date,
        (Shift.store_id == service.store_id) | (Shift.store_id.is_(None)),
        Employee.active.is_(True),
        Employee.role == "SERVER",
    ).order_by(TeamSheetAssignment.order_index).all()
    candidates: list[dict[str, Any]] = []
    seen: set[int] = set()
    for assignment, employee in assigned:
        if employee.id in seen:
            continue
        seen.add(employee.id)
        candidates.append({
            "employee_id": employee.id,
            "employee_name": employee.nickname or f"{employee.first_name} {employee.last_name}",
            "section_name": assignment.section.label if assignment.section else None,
            "from_team_sheet": True,
        })
    for employee in db.query(Employee).filter(Employee.active.is_(True), Employee.role == "SERVER").order_by(Employee.first_name, Employee.last_name):
        if employee.id not in seen:
            candidates.append({
                "employee_id": employee.id,
                "employee_name": employee.nickname or f"{employee.first_name} {employee.last_name}",
                "section_name": None,
                "from_team_sheet": False,
            })
    return {
        "current": [{
            "employee_id": row.employee_id,
            "employee_name": employee.nickname or f"{employee.first_name} {employee.last_name}",
            "section_name": row.section_name,
            "paused": row.paused,
            "turns": row.turns,
            "covers": row.covers,
        } for row, employee in current],
        "candidates": candidates,
    }


@router.post("/services/{service_id}/rotation")
def set_rotation(
    service_id: int,
    rows: list[AGMRotationInput],
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    service = db.query(AGMService).filter(AGMService.id == service_id).first()
    if service is None:
        raise HTTPException(status_code=404, detail="Service not found")
    _store_access(db, current_user, service.store_id)
    db.query(AGMServerRotation).filter(AGMServerRotation.service_id == service_id).delete()
    employee_ids = [item.employee_id for item in rows]
    if len(employee_ids) != len(set(employee_ids)):
        raise HTTPException(status_code=422, detail="Rotation employees must be unique")
    for index, item in enumerate(rows):
        employee_id = item.employee_id
        if db.query(Employee).filter(Employee.id == employee_id).first() is None:
            raise HTTPException(status_code=422, detail=f"Employee {employee_id} not found")
        db.add(AGMServerRotation(service_id=service_id, employee_id=employee_id, section_name=item.section_name, rotation_index=index))
    db.commit()
    return {"updated": len(rows)}


@router.post("/maintenance/anonymize")
def anonymize_expired_guests(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(status_code=403, detail="Only admins can run retention maintenance")
    cutoff = datetime.utcnow() - timedelta(days=90)
    rows = db.query(AGMParty).filter(AGMParty.updated_at < cutoff, AGMParty.phone.is_not(None)).all()
    for row in rows:
        row.phone = None
        row.notes = None
        row.sms_consent = False
        row.guest_name = "Archived guest"
    db.commit()
    return {"anonymized": len(rows), "cutoff": cutoff}
