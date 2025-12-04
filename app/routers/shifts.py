from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Shift, ShiftPeriod, User

router = APIRouter(prefix="/shifts", tags=["shifts"])


@router.get("", response_model=list[schemas.ShiftRead])
def list_shifts(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    time_period: ShiftPeriod | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Shift)
    if start_date:
        query = query.filter(Shift.date >= start_date)
    if end_date:
        query = query.filter(Shift.date <= end_date)
    if time_period:
        query = query.filter(Shift.time_period == time_period)
    query = query.order_by(Shift.date.desc())
    return query.all()


@router.post("", response_model=schemas.ShiftRead, status_code=status.HTTP_201_CREATED)
def create_shift(
    payload: schemas.ShiftCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    shift = Shift(**payload.dict(), created_by_user_id=current_user.id)
    db.add(shift)
    db.commit()
    db.refresh(shift)
    return shift


@router.get("/{shift_id}", response_model=schemas.ShiftRead)
def get_shift(shift_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    shift = db.query(Shift).filter(Shift.id == shift_id).first()
    if not shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    return shift
