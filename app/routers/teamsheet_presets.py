from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import TeamSheetPreset, User

router = APIRouter(prefix="/teamsheet-presets", tags=["teamsheet-presets"])


@router.get("", response_model=list[schemas.TeamSheetPresetRead])
def list_presets(
    store_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(TeamSheetPreset)
    if store_id is not None:
        query = query.filter(TeamSheetPreset.store_id == store_id)
    return query.order_by(TeamSheetPreset.name).all()


@router.post("", response_model=schemas.TeamSheetPresetRead, status_code=status.HTTP_201_CREATED)
def upsert_preset(
    payload: schemas.TeamSheetPresetCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    preset = (
        db.query(TeamSheetPreset)
        .filter(TeamSheetPreset.name == payload.name, TeamSheetPreset.store_id == payload.store_id)
        .first()
    )
    if preset:
        preset.data_json = payload.data_json
        db.commit()
        db.refresh(preset)
        return preset

    preset = TeamSheetPreset(**payload.dict())
    db.add(preset)
    db.commit()
    db.refresh(preset)
    return preset
