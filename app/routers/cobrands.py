from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import asc, desc
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_user
from app.database import get_db
from app.models import CobrandDeal, Employee, EmployeeRole, User

router = APIRouter(prefix="/cobrands", tags=["cobrands"])


def _dollars_to_cents(amount: Decimal) -> int:
    cents = (amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(cents)


@router.get("", response_model=list[schemas.CobrandDealRead])
def list_cobrand_deals(
    sort_by: str = Query(default="created_at"),
    sort_dir: str = Query(default="desc"),
    season_year: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sort_map = {
        "company_name": CobrandDeal.company_name,
        "amount": CobrandDeal.amount_cents,
        "date_of_commission": CobrandDeal.date_of_commission,
        "date_of_payment": CobrandDeal.date_of_payment,
        "date_of_pickup": CobrandDeal.date_of_pickup,
        "created_at": CobrandDeal.created_at,
    }
    sort_col = sort_map.get(sort_by, CobrandDeal.created_at)
    direction = desc if sort_dir.lower() == "desc" else asc
    query = db.query(CobrandDeal)
    if season_year is not None:
        query = query.filter(CobrandDeal.season_year == season_year)
    return query.order_by(direction(sort_col)).all()


@router.post("", response_model=schemas.CobrandDealRead, status_code=status.HTTP_201_CREATED)
def create_cobrand_deal(
    payload: schemas.CobrandDealCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if payload.amount_usd <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than zero")

    company_name = payload.company_name.strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required")

    if payload.season_year is None:
        raise HTTPException(status_code=400, detail="season_year is required")

    if payload.seller_id:
        seller_exists = (
            db.query(Employee.id)
            .filter(
                Employee.id == payload.seller_id,
                Employee.active.is_(True),
            )
            .first()
        )
        if not seller_exists:
            raise HTTPException(status_code=404, detail="Seller not found")

    deal = CobrandDeal(
        company_name=company_name,
        amount_cents=_dollars_to_cents(payload.amount_usd),
        date_of_commission=payload.date_of_commission,
        date_of_payment=payload.date_of_payment,
        date_of_pickup=payload.date_of_pickup,
        seller_id=payload.seller_id,
        logo_base64=payload.logo_base64,
        season_year=payload.season_year,
    )

    db.add(deal)
    db.commit()
    db.refresh(deal)
    return deal


@router.get("/sellers", response_model=list[schemas.SellerOption])
def list_cobrand_sellers(
    search: str | None = Query(default=None, min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Employee).filter(Employee.active.is_(True))

    # Prefer servers (and managers if that enum exists); fall back to all active employees
    preferred_roles = [EmployeeRole.SERVER]
    if hasattr(EmployeeRole, "MANAGER"):
        preferred_roles.append(getattr(EmployeeRole, "MANAGER"))
    if preferred_roles:
        query = query.filter(Employee.role.in_(preferred_roles))
    if search:
        like = f"%{search.lower()}%"
        query = query.filter(
            (Employee.first_name.ilike(like))
            | (Employee.last_name.ilike(like))
            | (Employee.nickname.ilike(like))
        )

    results = query.order_by(Employee.first_name.asc()).limit(25).all()
    return [
        schemas.SellerOption(
            id=emp.id,
            name=f"{emp.first_name} {emp.last_name}".strip(),
            role=emp.role,
        )
        for emp in results
    ]
