from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import Section, User

router = APIRouter(prefix="/sections", tags=["sections"])


@router.get("", response_model=list[schemas.SectionRead])
def list_sections(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    return db.query(Section).order_by(Section.name).all()


@router.post("", response_model=schemas.SectionRead, status_code=status.HTTP_201_CREATED)
def create_section(
    payload: schemas.SectionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    section = Section(**payload.dict())
    db.add(section)
    db.commit()
    db.refresh(section)
    return section


@router.put("/{section_id}", response_model=schemas.SectionRead)
def update_section(
    section_id: int,
    payload: schemas.SectionUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    section = db.query(Section).filter(Section.id == section_id).first()
    if not section:
        raise HTTPException(status_code=404, detail="Section not found")
    for field, value in payload.dict(exclude_unset=True).items():
        setattr(section, field, value)
    db.commit()
    db.refresh(section)
    return section
