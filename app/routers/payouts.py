import json
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import (
    CobrandDeal,
    GiftTrackerEntry,
    PayoutAdjustment,
    PayoutRule,
    PayoutTier,
    PayoutType,
    Prize,
    PrizeAssignment,
    User,
)

router = APIRouter(prefix="/payouts", tags=["payouts"])


def _to_cents(amount: Decimal) -> int:
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


@router.get("/tiers", response_model=list[schemas.PayoutTierRead])
def list_tiers(
    season_year: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(PayoutTier)
    if season_year is not None:
        query = query.filter(PayoutTier.season_year == season_year)
    return query.order_by(PayoutTier.min_amount_cents.asc()).all()


@router.post("/tiers", response_model=schemas.PayoutTierRead, status_code=status.HTTP_201_CREATED)
def create_tier(
    payload: schemas.PayoutTierCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    tier = PayoutTier(**payload.dict())
    db.add(tier)
    db.commit()
    db.refresh(tier)
    return tier


@router.put("/tiers/{tier_id}", response_model=schemas.PayoutTierRead)
def update_tier(
    tier_id: int,
    payload: schemas.PayoutTierCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    tier = db.query(PayoutTier).filter(PayoutTier.id == tier_id).first()
    if not tier:
        raise HTTPException(status_code=404, detail="Tier not found")
    for field, value in payload.dict().items():
        setattr(tier, field, value)
    db.commit()
    db.refresh(tier)
    return tier


@router.delete("/tiers/{tier_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tier(
    tier_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    tier = db.query(PayoutTier).filter(PayoutTier.id == tier_id).first()
    if not tier:
        raise HTTPException(status_code=404, detail="Tier not found")
    db.delete(tier)
    db.commit()
    return None


@router.get("/rules", response_model=list[schemas.PayoutRuleRead])
def list_rules(
    season_year: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(PayoutRule)
    if season_year is not None:
        query = query.filter(PayoutRule.season_year == season_year)
    rules = query.order_by(PayoutRule.created_at.desc()).all()
    for rule in rules:
        if isinstance(rule.config, str):
            try:
                rule.config = json.loads(rule.config)
            except Exception:
                rule.config = None
    return rules


@router.post("/rules", response_model=schemas.PayoutRuleRead, status_code=status.HTTP_201_CREATED)
def create_rule(
    payload: schemas.PayoutRuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    rule = PayoutRule(
        name=payload.name,
        type=payload.type,
        season_year=payload.season_year,
        config=json.dumps(payload.config) if payload.config else None,
        active=payload.active,
    )
    db.add(rule)
    db.commit()
    db.refresh(rule)
    if isinstance(rule.config, str):
        rule.config = payload.config
    return rule


@router.put("/rules/{rule_id}", response_model=schemas.PayoutRuleRead)
def update_rule(
    rule_id: int,
    payload: schemas.PayoutRuleCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    rule = db.query(PayoutRule).filter(PayoutRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    rule.name = payload.name
    rule.type = payload.type
    rule.config = json.dumps(payload.config) if payload.config else None
    rule.active = payload.active
    db.commit()
    db.refresh(rule)
    if isinstance(rule.config, str):
        rule.config = payload.config
    return rule


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_rule(
    rule_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    rule = db.query(PayoutRule).filter(PayoutRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    db.delete(rule)
    db.commit()
    return None


@router.get("/prizes", response_model=list[schemas.PrizeRead])
def list_prizes(
    season_year: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(Prize)
    if season_year is not None:
        query = query.filter(Prize.season_year == season_year)
    return query.order_by(Prize.created_at.desc()).all()


@router.post("/prizes", response_model=schemas.PrizeRead, status_code=status.HTTP_201_CREATED)
def create_prize(
    payload: schemas.PrizeCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    prize = Prize(**payload.dict())
    db.add(prize)
    db.commit()
    db.refresh(prize)
    return prize


@router.put("/prizes/{prize_id}", response_model=schemas.PrizeRead)
def update_prize(
    prize_id: int,
    payload: schemas.PrizeCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    prize = db.query(Prize).filter(Prize.id == prize_id).first()
    if not prize:
        raise HTTPException(status_code=404, detail="Prize not found")
    for field, value in payload.dict().items():
        setattr(prize, field, value)
    db.commit()
    db.refresh(prize)
    return prize


@router.delete("/prizes/{prize_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_prize(
    prize_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    prize = db.query(Prize).filter(Prize.id == prize_id).first()
    if not prize:
        raise HTTPException(status_code=404, detail="Prize not found")
    db.delete(prize)
    db.commit()
    return None


@router.post("/prizes/assign", response_model=schemas.PrizeAssignmentRead, status_code=status.HTTP_201_CREATED)
def assign_prize(
    payload: schemas.PrizeAssignmentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    prize = db.query(Prize).filter(Prize.id == payload.prize_id).first()
    if not prize:
        raise HTTPException(status_code=404, detail="Prize not found")
    assignment = PrizeAssignment(**payload.dict())
    db.add(assignment)
    db.commit()
    db.refresh(assignment)
    return assignment


@router.get("/prizes/assign", response_model=list[schemas.PrizeAssignmentRead])
def list_prize_assignments(
    season_year: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(PrizeAssignment)
    if season_year is not None:
        query = query.filter(PrizeAssignment.season_year == season_year)
    return query.order_by(PrizeAssignment.created_at.desc()).all()


@router.post("/adjustments", response_model=schemas.PayoutAdjustmentRead, status_code=status.HTTP_201_CREATED)
def create_adjustment(
    payload: schemas.PayoutAdjustmentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    adj = PayoutAdjustment(**payload.dict())
    db.add(adj)
    db.commit()
    db.refresh(adj)
    return adj


@router.get("/adjustments", response_model=list[schemas.PayoutAdjustmentRead])
def list_adjustments(
    season_year: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(PayoutAdjustment)
    if season_year is not None:
        query = query.filter(PayoutAdjustment.season_year == season_year)
    return query.order_by(PayoutAdjustment.created_at.desc()).all()


@router.get("/summary", response_model=schemas.PayoutSummaryResponse)
def payout_summary(
    season_year: int | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # aggregate sales from gift tracker entries
    sales_map: dict[str, int] = defaultdict(int)
    gt_query = db.query(GiftTrackerEntry)
    if season_year is not None:
        gt_query = gt_query.filter(GiftTrackerEntry.season_year == season_year)
    for row in gt_query.all():
        total_dollars = (
            row.tuesday
            + row.wednesday
            + row.thursday
            + row.friday
            + row.saturday
            + row.sunday
            + row.monday
        )
        sales_map[row.employee_name] += total_dollars * 100  # convert to cents

    # add cobrand sales
    cobrand_query = db.query(CobrandDeal)
    if season_year is not None:
        cobrand_query = cobrand_query.filter(CobrandDeal.season_year == season_year)
    for deal in cobrand_query.all():
        if not deal.seller_name:
            continue
        sales_map[deal.seller_name] += deal.amount_cents

    # tiers
    tiers_query = db.query(PayoutTier).filter(PayoutTier.active.is_(True))
    if season_year is not None:
        tiers_query = tiers_query.filter(PayoutTier.season_year == season_year)
    tiers = tiers_query.order_by(PayoutTier.min_amount_cents.asc()).all()

    # rules
    rules_query = db.query(PayoutRule).filter(PayoutRule.active.is_(True))
    if season_year is not None:
        rules_query = rules_query.filter(PayoutRule.season_year == season_year)
    rules = rules_query.all()

    # prize assignments
    pa_query = db.query(PrizeAssignment)
    if season_year is not None:
        pa_query = pa_query.filter(PrizeAssignment.season_year == season_year)
    prize_assignments = pa_query.all()
    prize_map: dict[str, list[Prize]] = defaultdict(list)
    for pa in prize_assignments:
        if pa.prize:
            prize_map[pa.employee_name].append(pa.prize)

    # adjustments
    adj_query = db.query(PayoutAdjustment)
    if season_year is not None:
        adj_query = adj_query.filter(PayoutAdjustment.season_year == season_year)
    adjustments = adj_query.all()
    adj_map: dict[str, int] = defaultdict(int)
    for adj in adjustments:
        adj_map[adj.employee_name] += adj.amount_cents

    # rule payouts
    rule_payouts: dict[str, int] = defaultdict(int)
    # season_top_seller rule
    for rule in rules:
        if rule.type == "season_top_seller":
            config = json.loads(rule.config) if rule.config else {}
            first_pct = Decimal(str(config.get("first_pct", 10)))
            second_pct = Decimal(str(config.get("second_pct", 5)))
            sorted_sales = sorted(sales_map.items(), key=lambda x: x[1], reverse=True)
            if sorted_sales:
                first_name, first_total = sorted_sales[0]
                rule_payouts[first_name] += int(
                    (Decimal(first_total) * first_pct / Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                )
            if len(sorted_sales) > 1:
                second_name, second_total = sorted_sales[1]
                rule_payouts[second_name] += int(
                    (Decimal(second_total) * second_pct / Decimal(100)).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
                )

    rows: list[schemas.PayoutSummaryRow] = []
    for name, sales_cents in sales_map.items():
        # tier payout
        tier_payout = 0
        for tier in tiers:
            within_min = sales_cents >= tier.min_amount_cents
            within_max = tier.max_amount_cents is None or sales_cents <= tier.max_amount_cents
            if within_min and within_max:
                if tier.payout_type == PayoutType.FIXED:
                    tier_payout = tier.payout_value
                else:
                    tier_payout = _to_cents(Decimal(sales_cents) * Decimal(tier.payout_value) / Decimal(10000))
                break
        prize_value = sum([p.cost_cents or 0 for p in prize_map.get(name, [])])
        misc = adj_map.get(name, 0)
        rule_bonus = rule_payouts.get(name, 0)
        total = tier_payout + rule_bonus + misc + prize_value
        rows.append(
          schemas.PayoutSummaryRow(
              employee_name=name,
              sales_total_cents=sales_cents,
              tier_payout_cents=tier_payout,
              rule_payout_cents=rule_bonus,
              misc_cents=misc,
              prize_value_cents=prize_value,
              total_payout_cents=total,
              prizes=[schemas.PrizeRead.model_validate(p) for p in prize_map.get(name, [])],
          )
        )

    return schemas.PayoutSummaryResponse(rows=rows)
