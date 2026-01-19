from datetime import date, datetime
from decimal import Decimal
from typing import List, Optional

from pydantic import BaseModel, EmailStr, Field, ConfigDict

from app.models import (
    EmployeeRole,
    SectionType,
    ShiftPeriod,
    TeamSheetStatus,
    UserRole,
    PayoutType,
    POSOrderStatus,
    PyosShift,
    PyosStatus,
)


class TimestampModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6)
    full_name: str
    role: UserRole = UserRole.SERVER


class UserRead(TimestampModel):
    id: int
    email: EmailStr
    full_name: str
    role: UserRole
    employee_id: Optional[int] = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserEmployeeLink(BaseModel):
    employee_id: int


class EmployeeBase(BaseModel):
    first_name: str
    last_name: str
    nickname: Optional[str] = None
    role: EmployeeRole
    employment_start_date: date
    active: bool = True
    upsell_score: Optional[int] = None
    pitty_score: Optional[int] = None
    employment_days: Optional[int] = None
    max_section_load: Optional[int] = None
    notes: Optional[str] = None


class EmployeeCreate(EmployeeBase):
    pass


class EmployeeUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    nickname: Optional[str] = None
    role: Optional[EmployeeRole] = None
    employment_start_date: Optional[date] = None
    active: Optional[bool] = None
    upsell_score: Optional[int] = None
    pitty_score: Optional[int] = None
    employment_days: Optional[int] = None
    max_section_load: Optional[int] = None
    notes: Optional[str] = None


class EmployeeRead(EmployeeBase, TimestampModel):
    id: int


class SectionBase(BaseModel):
    name: str
    label: str
    type: SectionType
    tables: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    cut_order: Optional[int] = None
    sidework: Optional[str] = None
    outwork: Optional[str] = None
    max_capacity: Optional[int] = None
    expected_out_time: Optional[str] = None
    max_guests: Optional[int] = None
    is_active: bool = True


class SectionCreate(SectionBase):
    pass


class SectionUpdate(BaseModel):
    name: Optional[str] = None
    label: Optional[str] = None
    type: Optional[SectionType] = None
    tables: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    cut_order: Optional[int] = None
    sidework: Optional[str] = None
    outwork: Optional[str] = None
    max_capacity: Optional[int] = None
    expected_out_time: Optional[str] = None
    max_guests: Optional[int] = None
    is_active: Optional[bool] = None


class SectionRead(SectionBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class ShiftBase(BaseModel):
    date: date
    time_period: ShiftPeriod
    store_id: Optional[int] = None


class ShiftCreate(ShiftBase):
    pass


class ShiftRead(ShiftBase, TimestampModel):
    id: int
    created_by_user_id: int


class TeamSheetAssignmentPayload(BaseModel):
    employee_id: int
    section_id: int
    role_label: Optional[str] = None
    order_index: Optional[int] = None


class TeamSheetTaskPayload(BaseModel):
    label: str
    description: Optional[str] = None
    employee_ids: List[int] = Field(default_factory=list)


class TeamSheetBase(BaseModel):
    shift_id: int
    title: str
    status: TeamSheetStatus = TeamSheetStatus.DRAFT
    notes: Optional[str] = None


class TeamSheetCreate(TeamSheetBase):
    assignments: List[TeamSheetAssignmentPayload] = Field(default_factory=list)
    sidework: List[TeamSheetTaskPayload] = Field(default_factory=list)
    outwork: List[TeamSheetTaskPayload] = Field(default_factory=list)
    source_team_sheet_id: Optional[int] = None


class TeamSheetUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[TeamSheetStatus] = None
    notes: Optional[str] = None
    assignments: Optional[List[TeamSheetAssignmentPayload]] = None
    sidework: Optional[List[TeamSheetTaskPayload]] = None
    outwork: Optional[List[TeamSheetTaskPayload]] = None


class TeamSheetAssignmentRead(TeamSheetAssignmentPayload):
    id: int
    employee_name: Optional[str] = None
    section_label: Optional[str] = None


class TeamSheetTaskRead(BaseModel):
    id: int
    label: str
    description: Optional[str] = None
    employee_ids: List[int] = Field(default_factory=list)


class TeamSheetRead(TeamSheetBase, TimestampModel):
    id: int
    created_by_user_id: int
    assignments: List[TeamSheetAssignmentRead] = Field(default_factory=list)
    sidework: List[TeamSheetTaskRead] = Field(default_factory=list)
    outwork: List[TeamSheetTaskRead] = Field(default_factory=list)


class CobrandDealBase(BaseModel):
    company_name: str = Field(min_length=1, max_length=255)
    amount_usd: Decimal = Field(gt=0)
    season_year: Optional[int] = None
    date_of_commission: date | None = None
    date_of_payment: date | None = None
    date_of_pickup: date | None = None
    seller_id: int | None = None
    logo_base64: str | None = None


class CobrandDealCreate(CobrandDealBase):
    pass


class CobrandDealRead(CobrandDealBase, TimestampModel):
    amount_usd: float
    id: int
    seller_name: str | None = None

    model_config = ConfigDict(from_attributes=True)


class SellerOption(BaseModel):
    id: int
    name: str
    role: EmployeeRole

    model_config = ConfigDict(from_attributes=True)


class PayoutTierBase(BaseModel):
    label: str
    season_year: Optional[int] = None
    min_amount_cents: int = Field(ge=0)
    max_amount_cents: int | None = Field(default=None, ge=0)
    payout_type: PayoutType = PayoutType.FIXED
    payout_value: int = Field(ge=0)  # cents if FIXED, percent * 100 if PERCENT
    active: bool = True


class PayoutTierCreate(PayoutTierBase):
    pass


class PayoutTierRead(PayoutTierBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class PayoutRuleBase(BaseModel):
    name: str
    type: str
    season_year: Optional[int] = None
    config: dict | None = None
    active: bool = True


class PayoutRuleCreate(PayoutRuleBase):
    pass


class PayoutRuleRead(PayoutRuleBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class PrizeBase(BaseModel):
    name: str
    season_year: Optional[int] = None
    description: Optional[str] = None
    cost_cents: Optional[int] = Field(default=None, ge=0)
    image_url: Optional[str] = None
    active: bool = True


class PrizeCreate(PrizeBase):
    pass


class PrizeRead(PrizeBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class PrizeAssignmentCreate(BaseModel):
    employee_name: str
    prize_id: int
    season_year: Optional[int] = None
    notes: Optional[str] = None


class PrizeAssignmentRead(PrizeAssignmentCreate, TimestampModel):
    id: int
    prize: Optional[PrizeRead] = None

    model_config = ConfigDict(from_attributes=True)


class PayoutAdjustmentCreate(BaseModel):
    employee_name: str
    label: str
    season_year: Optional[int] = None
    amount_cents: int


class PayoutAdjustmentRead(PayoutAdjustmentCreate, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class PayoutSummaryRow(BaseModel):
    employee_name: str
    sales_total_cents: int
    tier_payout_cents: int
    rule_payout_cents: int
    misc_cents: int
    prize_value_cents: int
    total_payout_cents: int
    prizes: List[PrizeRead] = Field(default_factory=list)


class PayoutSummaryResponse(BaseModel):
    rows: List[PayoutSummaryRow]


class SeasonCreate(BaseModel):
    year: int
    start_date: date


class SeasonRead(SeasonCreate, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class GiftTrackerEntryPayload(BaseModel):
    employee_name: str = Field(min_length=1, max_length=255)
    season_year: Optional[int] = None
    tuesday: int = 0
    wednesday: int = 0
    thursday: int = 0
    friday: int = 0
    saturday: int = 0
    sunday: int = 0
    monday: int = 0


class GiftTrackerUpsertRequest(BaseModel):
    week_number: int = Field(ge=1)
    season_year: Optional[int] = None
    entries: List[GiftTrackerEntryPayload] = Field(default_factory=list)


class GiftTrackerEntryRead(GiftTrackerEntryPayload, TimestampModel):
    id: int
    week_number: int

    model_config = ConfigDict(from_attributes=True)


class DailyScheduleEntry(BaseModel):
    day: str
    open_time: Optional[str] = None
    close_time: Optional[str] = None
    first_shift_in: Optional[str] = None
    second_shift_in: Optional[str] = None
    number_of_shifts: Optional[int] = Field(default=None, ge=1, le=2)


class StorePreferenceBase(BaseModel):
    store_number: str
    daily_schedule: List[DailyScheduleEntry] = Field(default_factory=list)


class StorePreferenceCreate(StorePreferenceBase):
    pass


class StorePreferenceRead(StorePreferenceBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class MenuCategoryBase(BaseModel):
    name: str
    description: Optional[str] = None
    active: bool = True


class MenuCategoryCreate(MenuCategoryBase):
    pass


class MenuCategoryRead(MenuCategoryBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class MenuItemBase(BaseModel):
    name: str
    category_id: Optional[int] = None
    price_cents: int = Field(ge=0)
    active: bool = True


class MenuItemCreate(MenuItemBase):
    pass


class MenuItemRead(MenuItemBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class IngredientBase(BaseModel):
    name: str
    unit: str = "unit"
    active: bool = True


class IngredientCreate(IngredientBase):
    pass


class IngredientRead(IngredientBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class RecipeItemBase(BaseModel):
    menu_item_id: int
    ingredient_id: int
    quantity: float = Field(gt=0)


class RecipeItemCreate(RecipeItemBase):
    pass


class RecipeItemRead(RecipeItemBase):
    id: int

    model_config = ConfigDict(from_attributes=True)


class POSOrderItemBase(BaseModel):
    menu_item_id: int
    quantity: int = Field(ge=1)
    price_cents: int = Field(ge=0)


class POSOrderItemCreate(POSOrderItemBase):
    pass


class POSOrderItemRead(POSOrderItemBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class POSOrderBase(BaseModel):
    shift_id: Optional[int] = None
    server_id: Optional[int] = None
    table_label: Optional[str] = None
    notes: Optional[str] = None


class POSOrderCreate(POSOrderBase):
    pass


class POSOrderRead(POSOrderBase, TimestampModel):
    id: int
    status: POSOrderStatus
    items: List[POSOrderItemRead] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class POSPaymentCreate(BaseModel):
    amount_cents: int = Field(ge=0)
    method: str = "CARD"


class POSPaymentRead(POSPaymentCreate, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class POSCloseRequest(BaseModel):
    payment: POSPaymentCreate


class StockMovementBase(BaseModel):
    ingredient_id: int
    quantity_change: float
    reason: str
    notes: Optional[str] = None


class StockMovementCreate(StockMovementBase):
    order_item_id: Optional[int] = None


class StockMovementRead(StockMovementBase, TimestampModel):
    id: int
    order_item_id: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)


class StockLevelRead(BaseModel):
    ingredient_id: int
    name: str
    unit: str
    quantity_on_hand: float


class DailyRosterEntry(BaseModel):
    name: str
    in_time: Optional[str] = None


class DailyRosterCreate(BaseModel):
    date: date
    store_id: Optional[int] = None
    entries: List[DailyRosterEntry] = Field(default_factory=list)


class DailyRosterRead(DailyRosterCreate, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class TeamSheetPresetBase(BaseModel):
    name: str
    store_id: Optional[int] = None
    data_json: List[dict] = Field(default_factory=list)


class TeamSheetPresetCreate(TeamSheetPresetBase):
    pass


class TeamSheetPresetRead(TeamSheetPresetBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class PyosCreditRead(TimestampModel):
    id: int
    employee_id: int
    balance: int


class PyosCreditGrant(BaseModel):
    employee_id: int
    delta: int = Field(gt=0)
    note: Optional[str] = None


class PyosRequestCreate(BaseModel):
    section_id: int
    date: date
    shift: PyosShift
    notes: Optional[str] = None


class PyosRequestManualCreate(BaseModel):
    employee_id: int
    section_id: int
    date: date
    shift: PyosShift
    notes: Optional[str] = None


class PyosRequestAction(BaseModel):
    notes: Optional[str] = None


class PyosRequestRead(TimestampModel):
    id: int
    employee_id: int
    section_id: int
    date: date
    shift: PyosShift
    status: PyosStatus
    notes: Optional[str] = None
    created_by_user_id: int
    approved_by_user_id: Optional[int] = None
    denied_by_user_id: Optional[int] = None
    revoked_by_user_id: Optional[int] = None
    approved_at: Optional[datetime] = None
    denied_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    employee_name: Optional[str] = None
    section_label: Optional[str] = None


class PyosAuditRead(TimestampModel):
    id: int
    actor_user_id: int
    employee_id: Optional[int] = None
    action: str
    delta: Optional[int] = None
    details_json: Optional[dict] = None
