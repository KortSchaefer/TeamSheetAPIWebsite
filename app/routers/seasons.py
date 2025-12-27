from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Season, User

router = APIRouter(prefix="/seasons", tags=["seasons"])


@router.get("", response_model=list[schemas.SeasonRead])
def list_seasons(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(Season).order_by(Season.year.asc()).all()


@router.post("", response_model=schemas.SeasonRead, status_code=status.HTTP_201_CREATED)
def create_season(
    payload: schemas.SeasonCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    existing = db.query(Season).filter(Season.year == payload.year).first()
    if existing:
        existing.start_date = payload.start_date
        db.commit()
        db.refresh(existing)
        return existing
    season = Season(year=payload.year, start_date=payload.start_date)
    db.add(season)
    db.commit()
    db.refresh(season)
    return season


@router.delete("/{season_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_season(
    season_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    season = db.query(Season).filter(Season.id == season_id).first()
    if not season:
        raise HTTPException(status_code=404, detail="Season not found")
    db.delete(season)
    db.commit()
    return None
