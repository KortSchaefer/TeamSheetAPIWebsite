from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import StorePreference, User

router = APIRouter(prefix="/store-preferences", tags=["store-preferences"])


@router.get("", response_model=list[schemas.StorePreferenceRead])
def list_store_preferences(
    store_number: str | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(StorePreference)
    if store_number:
        query = query.filter(StorePreference.store_number == store_number)
    return query.order_by(StorePreference.store_number).all()


@router.post("", response_model=schemas.StorePreferenceRead)
def upsert_store_preferences(
    payload: schemas.StorePreferenceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    existing = (
        db.query(StorePreference)
        .filter(StorePreference.store_number == payload.store_number)
        .first()
    )
    data = payload.dict()
    if existing:
        for key, value in data.items():
            setattr(existing, key, value)
        db.commit()
        db.refresh(existing)
        return existing

    pref = StorePreference(**data)
    db.add(pref)
    db.commit()
    db.refresh(pref)
    return pref
