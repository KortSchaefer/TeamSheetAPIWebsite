from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import DailyRoster, User

router = APIRouter(prefix="/daily-rosters", tags=["daily-rosters"])


@router.get("", response_model=list[schemas.DailyRosterRead])
def list_daily_rosters(
    roster_date: date | None = Query(default=None, alias="date"),
    store_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(DailyRoster)
    if roster_date:
        query = query.filter(DailyRoster.date == roster_date)
    if store_id is not None:
        query = query.filter(DailyRoster.store_id == store_id)
    return query.order_by(DailyRoster.date.desc()).all()


@router.post("", response_model=schemas.DailyRosterRead, status_code=status.HTTP_201_CREATED)
def upsert_daily_roster(
    payload: schemas.DailyRosterCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    roster = (
        db.query(DailyRoster)
        .filter(DailyRoster.date == payload.date, DailyRoster.store_id == payload.store_id)
        .first()
    )
    data = payload.dict()
    if roster:
        for key, value in data.items():
            setattr(roster, key, value)
        db.commit()
        db.refresh(roster)
        return roster

    roster = DailyRoster(**data)
    db.add(roster)
    db.commit()
    db.refresh(roster)
    return roster
