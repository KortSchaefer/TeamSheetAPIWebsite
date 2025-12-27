from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import GiftTrackerEntry, User

router = APIRouter(prefix="/gift-tracker", tags=["gift-tracker"])


@router.get("", response_model=list[schemas.GiftTrackerEntryRead])
def list_gift_tracker_entries(
    week_number: int | None = Query(default=None, ge=1),
    season_year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(GiftTrackerEntry)
    if week_number is not None:
        query = query.filter(GiftTrackerEntry.week_number == week_number)
    if season_year is not None:
        query = query.filter(GiftTrackerEntry.season_year == season_year)
    return query.order_by(GiftTrackerEntry.week_number.asc(), GiftTrackerEntry.employee_name.asc()).all()


@router.post("", response_model=list[schemas.GiftTrackerEntryRead], status_code=status.HTTP_201_CREATED)
def upsert_gift_tracker_entries(
    payload: schemas.GiftTrackerUpsertRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    week = payload.week_number
    if week < 1:
        raise HTTPException(status_code=400, detail="Week number must be at least 1")

    existing = {
        (entry.employee_name.lower(), entry.week_number): entry
        for entry in db.query(GiftTrackerEntry)
        .filter(GiftTrackerEntry.week_number == week, GiftTrackerEntry.season_year == payload.season_year)
        .all()
    }

    seen_keys: set[tuple[str, int]] = set()
    results: list[GiftTrackerEntry] = []
    for item in payload.entries:
        key = (item.employee_name.lower(), week)
        seen_keys.add(key)
        record = existing.get(key)
        if record:
            record.tuesday = item.tuesday
            record.wednesday = item.wednesday
            record.thursday = item.thursday
            record.friday = item.friday
            record.saturday = item.saturday
            record.sunday = item.sunday
            record.monday = item.monday
        else:
            record = GiftTrackerEntry(
                employee_name=item.employee_name.strip(),
                week_number=week,
                season_year=payload.season_year,
                tuesday=item.tuesday,
                wednesday=item.wednesday,
                thursday=item.thursday,
                friday=item.friday,
                saturday=item.saturday,
                sunday=item.sunday,
                monday=item.monday,
            )
            db.add(record)
        results.append(record)

    # Remove entries for this week that were not included in the payload
    to_delete = [entry for key, entry in existing.items() if key not in seen_keys]
    for entry in to_delete:
        db.delete(entry)

    db.commit()
    for record in results:
        db.refresh(record)
    return results
