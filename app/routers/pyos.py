from datetime import datetime, date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Employee, PyosCredit, PyosRequest, PyosAudit, PyosStatus, PyosShift, Section, User, UserRole

router = APIRouter(prefix="/pyos", tags=["pyos"])


def normalize_name(value: str) -> str:
    return " ".join(value.strip().lower().split())


def find_employee_for_user(db: Session, user: User) -> Employee | None:
    if user.employee_id:
        return db.query(Employee).filter(Employee.id == user.employee_id).first()
    full_name = normalize_name(user.full_name or "")
    if not full_name:
        return None
    parts = full_name.split(" ", 1)
    query = db.query(Employee)
    if len(parts) == 2:
        first, last = parts
        query = query.filter(
            func.lower(Employee.first_name) == first,
            func.lower(Employee.last_name) == last,
        )
        match = query.first()
        if match:
            return match
    return (
        db.query(Employee)
        .filter(func.lower(Employee.nickname) == full_name)
        .first()
    )


def get_or_create_credit(db: Session, employee_id: int) -> PyosCredit:
    credit = db.query(PyosCredit).filter(PyosCredit.employee_id == employee_id).first()
    if not credit:
        credit = PyosCredit(employee_id=employee_id, balance=0)
        db.add(credit)
        db.commit()
        db.refresh(credit)
    return credit


def log_audit(db: Session, actor_id: int, employee_id: int | None, action: str, delta: int | None, details: dict):
    audit = PyosAudit(
        actor_user_id=actor_id,
        employee_id=employee_id,
        action=action,
        delta=delta,
        details_json=details or None,
    )
    db.add(audit)
    db.commit()


def serialize_request(item: PyosRequest, employee_name: str | None, section_label: str | None) -> dict:
    return {
        "id": item.id,
        "employee_id": item.employee_id,
        "section_id": item.section_id,
        "date": item.date,
        "shift": item.shift,
        "status": item.status,
        "notes": item.notes,
        "created_by_user_id": item.created_by_user_id,
        "approved_by_user_id": item.approved_by_user_id,
        "denied_by_user_id": item.denied_by_user_id,
        "revoked_by_user_id": item.revoked_by_user_id,
        "approved_at": item.approved_at,
        "denied_at": item.denied_at,
        "revoked_at": item.revoked_at,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
        "employee_name": employee_name,
        "section_label": section_label,
    }


def assert_section_available(db: Session, section_id: int, roster_date: date, shift: PyosShift):
    existing = (
        db.query(PyosRequest)
        .filter(
            PyosRequest.section_id == section_id,
            PyosRequest.date == roster_date,
            PyosRequest.shift == shift,
            PyosRequest.status.in_([PyosStatus.PENDING, PyosStatus.APPROVED]),
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Section already assigned for this shift.")


@router.get("/credits/me", response_model=schemas.PyosCreditRead)
def get_my_credit(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    employee = find_employee_for_user(db, current_user)
    if not employee:
        raise HTTPException(status_code=404, detail="Employee profile not found for this user.")
    credit = get_or_create_credit(db, employee.id)
    return credit


@router.get("/credits", response_model=list[schemas.PyosCreditRead])
def list_credits(
    employee_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    query = db.query(PyosCredit)
    if employee_id:
        query = query.filter(PyosCredit.employee_id == employee_id)
    return query.order_by(PyosCredit.employee_id.asc()).all()


@router.post("/credits/grant", response_model=schemas.PyosCreditRead)
def grant_credit(
    payload: schemas.PyosCreditGrant,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    employee = db.query(Employee).filter(Employee.id == payload.employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    credit = get_or_create_credit(db, employee.id)
    credit.balance += payload.delta
    db.commit()
    db.refresh(credit)
    log_audit(
        db,
        current_user.id,
        employee.id,
        "grant",
        payload.delta,
        {"note": payload.note or "", "balance": credit.balance},
    )
    return credit


@router.get("/requests", response_model=list[schemas.PyosRequestRead])
def list_requests(
    roster_date: date | None = Query(default=None, alias="date"),
    shift: PyosShift | None = Query(default=None),
    status_filter: PyosStatus | None = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(PyosRequest)
    if current_user.role == UserRole.SERVER:
        employee = find_employee_for_user(db, current_user)
        if not employee:
            raise HTTPException(status_code=404, detail="Employee profile not found for this user.")
        query = query.filter(PyosRequest.employee_id == employee.id)
    if roster_date:
        query = query.filter(PyosRequest.date == roster_date)
    if shift:
        query = query.filter(PyosRequest.shift == shift)
    if status_filter:
        query = query.filter(PyosRequest.status == status_filter)
    results = query.order_by(PyosRequest.date.desc(), PyosRequest.created_at.desc()).all()
    payloads = []
    for item in results:
        employee_name = None
        if item.employee:
            employee_name = f"{item.employee.first_name or ''} {item.employee.last_name or ''}".strip() or item.employee.nickname
        payloads.append(serialize_request(item, employee_name, item.section.label if item.section else None))
    return payloads


@router.get("/occupied", response_model=list[int])
def list_occupied_sections(
    roster_date: date = Query(alias="date"),
    shift: PyosShift = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        db.query(PyosRequest.section_id)
        .filter(
            PyosRequest.date == roster_date,
            PyosRequest.shift == shift,
            PyosRequest.status.in_([PyosStatus.PENDING, PyosStatus.APPROVED]),
        )
        .all()
    )
    return [row[0] for row in rows]


@router.post("/requests", response_model=schemas.PyosRequestRead, status_code=status.HTTP_201_CREATED)
def create_request(
    payload: schemas.PyosRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != UserRole.SERVER:
        raise HTTPException(status_code=403, detail="Only servers can submit PYOS requests.")
    employee = find_employee_for_user(db, current_user)
    if not employee:
        raise HTTPException(status_code=404, detail="Employee profile not found for this user.")
    if payload.date < date.today():
        raise HTTPException(status_code=400, detail="Cannot request past dates.")
    credit = get_or_create_credit(db, employee.id)
    if credit.balance < 1:
        raise HTTPException(status_code=400, detail="No PYOS credits available.")
    assert_section_available(db, payload.section_id, payload.date, payload.shift)
    credit.balance -= 1
    request = PyosRequest(
        employee_id=employee.id,
        section_id=payload.section_id,
        date=payload.date,
        shift=payload.shift,
        status=PyosStatus.PENDING,
        notes=payload.notes,
        created_by_user_id=current_user.id,
    )
    db.add(request)
    db.commit()
    db.refresh(request)
    log_audit(
        db,
        current_user.id,
        employee.id,
        "use",
        -1,
        {"request_id": request.id, "date": str(payload.date), "shift": payload.shift.value},
    )
    request.employee = employee
    request.section = db.query(Section).filter(Section.id == payload.section_id).first()
    return serialize_request(
        request,
        f"{employee.first_name} {employee.last_name}".strip(),
        request.section.label if request.section else None,
    )


@router.post("/requests/manual", response_model=schemas.PyosRequestRead, status_code=status.HTTP_201_CREATED)
def create_manual_request(
    payload: schemas.PyosRequestManualCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    employee = db.query(Employee).filter(Employee.id == payload.employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    assert_section_available(db, payload.section_id, payload.date, payload.shift)
    request = PyosRequest(
        employee_id=payload.employee_id,
        section_id=payload.section_id,
        date=payload.date,
        shift=payload.shift,
        status=PyosStatus.APPROVED,
        notes=payload.notes,
        created_by_user_id=current_user.id,
        approved_by_user_id=current_user.id,
        approved_at=datetime.utcnow(),
    )
    db.add(request)
    db.commit()
    db.refresh(request)
    log_audit(
        db,
        current_user.id,
        employee.id,
        "manual_assign",
        None,
        {"request_id": request.id, "date": str(payload.date), "shift": payload.shift.value},
    )
    request.employee = employee
    request.section = db.query(Section).filter(Section.id == payload.section_id).first()
    return serialize_request(
        request,
        f"{employee.first_name} {employee.last_name}".strip(),
        request.section.label if request.section else None,
    )


@router.post("/requests/{request_id}/approve", response_model=schemas.PyosRequestRead)
def approve_request(
    request_id: int,
    payload: schemas.PyosRequestAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    request = db.query(PyosRequest).filter(PyosRequest.id == request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    if request.status != PyosStatus.PENDING:
        raise HTTPException(status_code=400, detail="Only pending requests can be approved")
    request.status = PyosStatus.APPROVED
    request.approved_by_user_id = current_user.id
    request.approved_at = datetime.utcnow()
    if payload.notes:
        request.notes = payload.notes
    db.commit()
    db.refresh(request)
    log_audit(
        db,
        current_user.id,
        request.employee_id,
        "approve",
        None,
        {"request_id": request.id},
    )
    request.employee = db.query(Employee).filter(Employee.id == request.employee_id).first()
    request.section = db.query(Section).filter(Section.id == request.section_id).first()
    employee_name = None
    if request.employee:
        employee_name = f"{request.employee.first_name} {request.employee.last_name}".strip()
    return serialize_request(
        request,
        employee_name,
        request.section.label if request.section else None,
    )


@router.post("/requests/{request_id}/deny", response_model=schemas.PyosRequestRead)
def deny_request(
    request_id: int,
    payload: schemas.PyosRequestAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    request = db.query(PyosRequest).filter(PyosRequest.id == request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    if request.status != PyosStatus.PENDING:
        raise HTTPException(status_code=400, detail="Only pending requests can be denied")
    request.status = PyosStatus.DENIED
    request.denied_by_user_id = current_user.id
    request.denied_at = datetime.utcnow()
    if payload.notes:
        request.notes = payload.notes
    credit = get_or_create_credit(db, request.employee_id)
    credit.balance += 1
    db.commit()
    db.refresh(request)
    log_audit(
        db,
        current_user.id,
        request.employee_id,
        "deny",
        1,
        {"request_id": request.id, "reason": payload.notes or ""},
    )
    request.employee = db.query(Employee).filter(Employee.id == request.employee_id).first()
    request.section = db.query(Section).filter(Section.id == request.section_id).first()
    employee_name = None
    if request.employee:
        employee_name = f"{request.employee.first_name} {request.employee.last_name}".strip()
    return serialize_request(
        request,
        employee_name,
        request.section.label if request.section else None,
    )


@router.post("/requests/{request_id}/revoke", response_model=schemas.PyosRequestRead)
def revoke_request(
    request_id: int,
    payload: schemas.PyosRequestAction,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    request = db.query(PyosRequest).filter(PyosRequest.id == request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail="Request not found")
    if request.status != PyosStatus.APPROVED:
        raise HTTPException(status_code=400, detail="Only approved requests can be revoked")
    request.status = PyosStatus.REVOKED
    request.revoked_by_user_id = current_user.id
    request.revoked_at = datetime.utcnow()
    if payload.notes:
        request.notes = payload.notes
    credit = get_or_create_credit(db, request.employee_id)
    credit.balance += 1
    db.commit()
    db.refresh(request)
    log_audit(
        db,
        current_user.id,
        request.employee_id,
        "revoke",
        1,
        {"request_id": request.id, "reason": payload.notes or ""},
    )
    request.employee = db.query(Employee).filter(Employee.id == request.employee_id).first()
    request.section = db.query(Section).filter(Section.id == request.section_id).first()
    employee_name = None
    if request.employee:
        employee_name = f"{request.employee.first_name} {request.employee.last_name}".strip()
    return serialize_request(
        request,
        employee_name,
        request.section.label if request.section else None,
    )


@router.get("/audit", response_model=list[schemas.PyosAuditRead])
def list_audit(
    employee_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    query = db.query(PyosAudit)
    if employee_id:
        query = query.filter(PyosAudit.employee_id == employee_id)
    return query.order_by(PyosAudit.created_at.desc()).limit(200).all()
