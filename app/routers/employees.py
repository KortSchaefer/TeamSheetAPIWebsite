from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Employee, EmployeeRole, User

router = APIRouter(prefix="/employees", tags=["employees"])


@router.get("", response_model=list[schemas.EmployeeRead])
def list_employees(
    role: EmployeeRole | None = Query(default=None),
    active: bool | None = Query(default=None),
    search: str | None = Query(default=None),
    sort_by: str | None = Query(default=None, description="upsell_score or employment_days"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Employee)
    if role:
        query = query.filter(Employee.role == role)
    if active is not None:
        query = query.filter(Employee.active == active)
    if search:
        pattern = f"%{search.lower()}%"
        query = query.filter(
            (Employee.first_name.ilike(pattern))
            | (Employee.last_name.ilike(pattern))
            | (Employee.nickname.ilike(pattern))
        )
    if sort_by == "upsell_score":
        query = query.order_by(Employee.upsell_score.desc().nullslast())
    elif sort_by == "employment_days":
        query = query.order_by(Employee.employment_days.desc().nullslast())
    else:
        query = query.order_by(Employee.first_name.asc())
    return query.all()


@router.post("", response_model=schemas.EmployeeRead, status_code=status.HTTP_201_CREATED)
def create_employee(
    payload: schemas.EmployeeCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    employee = Employee(**payload.dict())
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return employee


@router.get("/{employee_id}", response_model=schemas.EmployeeRead)
def get_employee(employee_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    return employee


@router.put("/{employee_id}", response_model=schemas.EmployeeRead)
def update_employee(
    employee_id: int,
    payload: schemas.EmployeeUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    for field, value in payload.dict(exclude_unset=True).items():
        setattr(employee, field, value)
    db.commit()
    db.refresh(employee)
    return employee


@router.delete("/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_employee(
    employee_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    employee = db.query(Employee).filter(Employee.id == employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    employee.active = False
    db.commit()
    return None
