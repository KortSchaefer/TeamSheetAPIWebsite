from datetime import date, datetime
from decimal import Decimal
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field, ConfigDict

from app.models import (
    EmployeeRole,
    SectionType,
    ShiftPeriod,
    TeamSheetStatus,
    UserRole,
    PayoutType,
    POSAccessRole,
    POSCheckProgress,
    POSOrderStatus,
    POSTableStatus,
    PurchaseOrderStatus,
    InventoryCountStatus,
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
    blast_minimum_percent: float = Field(default=98.0, ge=0, le=250)


class StorePreferenceCreate(StorePreferenceBase):
    pass


class StorePreferenceRead(StorePreferenceBase, TimestampModel):
    id: int

    model_config = ConfigDict(from_attributes=True)


class MenuCategoryBase(BaseModel):
    name: str
    description: Optional[str] = None
    active: bool = True
    display_order: int = Field(default=0, ge=0)


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


class POSAccessUpsert(BaseModel):
    employee_number: Optional[str] = Field(
        default=None, pattern=r"^\d{4,6}$"
    )
    access_role: POSAccessRole = POSAccessRole.SERVER
    active: bool = True


class POSAccessRead(BaseModel):
    employee_id: int
    employee_name: str
    employee_role: str
    access_role: Optional[POSAccessRole] = None
    pos_active: bool = False
    has_employee_number: bool = False
    last_used_at: Optional[datetime] = None
    locked_until: Optional[datetime] = None


class POSPinLogin(BaseModel):
    employee_number: str = Field(pattern=r"^\d{4,6}$")


class POSTerminalEmployeeRead(BaseModel):
    employee_id: int
    employee_name: str
    access_role: POSAccessRole


class POSCheckSummaryRead(BaseModel):
    id: int
    check_number: int
    status: POSOrderStatus
    progress: POSCheckProgress
    subtotal_cents: int
    tax_cents: int
    tip_cents: int
    total_cents: int
    print_count: int
    printed_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    item_count: int = 0


class POSTableRead(BaseModel):
    id: int
    table_number: int
    owner_employee_id: int
    owner_name: str
    status: POSTableStatus
    progress: POSCheckProgress
    revision: int
    opened_at: datetime
    closed_at: Optional[datetime] = None
    check: POSCheckSummaryRead


class POSTableCreate(BaseModel):
    table_number: int = Field(ge=1, le=9999)
    client_request_id: str = Field(min_length=8, max_length=64)


class POSTableTransfer(BaseModel):
    owner_employee_id: int
    revision: int = Field(ge=1)


class POSCloseEmptyRequest(BaseModel):
    revision: int = Field(ge=1)


class POSTerminalSessionRead(BaseModel):
    employee: POSTerminalEmployeeRead
    idle_timeout_seconds: int
    expires_at: datetime


class POSTerminalBootstrapRead(POSTerminalSessionRead):
    permissions: dict[str, bool]
    features: dict[str, bool]
    categories: list[MenuCategoryRead]
    tables: list[POSTableRead]
    transfer_candidates: list[POSTerminalEmployeeRead] = Field(default_factory=list)


class POSPrintStartRead(BaseModel):
    print_url: str
    print_count: int
    printed_at: datetime


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


class InventoryLocationBase(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: Optional[str] = None
    active: bool = True


class InventoryLocationCreate(InventoryLocationBase):
    pass


class InventoryLocationRead(InventoryLocationBase):
    id: int
    model_config = ConfigDict(from_attributes=True)


class InventoryItemBase(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    category: Optional[str] = None
    sku: Optional[str] = None
    base_unit: str = "unit"
    purchase_unit: Optional[str] = None
    purchase_to_base: Decimal = Field(default=Decimal("1"), gt=0)
    default_location_id: Optional[int] = None
    cost_cents: int = Field(default=0, ge=0)
    shelf_life_days: Optional[int] = Field(default=None, ge=0)
    active: bool = True


class InventoryItemCreate(InventoryItemBase):
    pass


class InventoryItemRead(InventoryItemBase, TimestampModel):
    id: int
    ingredient_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


class IngredientCatalogItemRead(BaseModel):
    id: int
    external_id: str
    name: str
    normalized_name: str
    category: Optional[str] = None
    stage: str
    process: Optional[str] = None
    added_to_complete_lineage: bool
    source_correction: Optional[str] = None
    resolution_needed: Optional[str] = None
    catalog_schema_version: Optional[str] = None
    parent_ids: List[str] = Field(default_factory=list)
    child_ids: List[str] = Field(default_factory=list)
    activated_inventory_item_id: Optional[int] = None


class IngredientCatalogListRead(BaseModel):
    items: List[IngredientCatalogItemRead]
    total: int
    limit: int
    offset: int


class IngredientCatalogImportRead(BaseModel):
    import_id: Optional[int] = None
    schema_version: str
    source_name: str
    source_sha256: str
    item_count: int
    relationship_count: int
    created: int
    updated: int
    unchanged: int
    dry_run: bool


class InventoryCatalogActivationCreate(BaseModel):
    catalog_id: str = Field(min_length=1, max_length=150)
    base_unit: str = Field(default="unit", min_length=1, max_length=30)
    sku: Optional[str] = None
    purchase_unit: Optional[str] = None
    purchase_to_base: Decimal = Field(default=Decimal("1"), gt=0)
    default_location_id: Optional[int] = None
    cost_cents: int = Field(default=0, ge=0)
    shelf_life_days: Optional[int] = Field(default=None, ge=0)


class InventoryBalanceRead(BaseModel):
    id: int
    inventory_item_id: int
    location_id: int
    quantity_on_hand: Decimal
    minimum_quantity: Decimal
    par_quantity: Decimal
    maximum_quantity: Optional[Decimal] = None
    model_config = ConfigDict(from_attributes=True)


class InventoryBalanceUpsert(BaseModel):
    location_id: int
    minimum_quantity: Decimal = Field(default=Decimal("0"), ge=0)
    par_quantity: Decimal = Field(default=Decimal("0"), ge=0)
    maximum_quantity: Optional[Decimal] = Field(default=None, ge=0)


class EasyInventoryRowInput(BaseModel):
    client_row_id: str = Field(min_length=1, max_length=100)
    action: Optional[Literal["CREATE", "UPDATE", "STOCK_AT_LOCATION"]] = None
    inventory_item_id: Optional[int] = None
    catalog_id: Optional[str] = Field(default=None, max_length=150)
    name: Optional[str] = Field(default=None, max_length=150)
    category: Optional[str] = Field(default=None, max_length=100)
    sku: Optional[str] = Field(default=None, max_length=100)
    base_unit: Optional[str] = Field(default=None, max_length=30)
    location_id: Optional[int] = None
    purchase_unit: Optional[str] = Field(default=None, max_length=30)
    pack_quantity: Optional[Decimal] = None
    pack_cost_cents: Optional[int] = None
    opening_quantity: Optional[Decimal] = None
    minimum_quantity: Optional[Decimal] = None
    par_quantity: Optional[Decimal] = None
    maximum_quantity: Optional[Decimal] = None
    preferred_vendor_id: Optional[int] = None
    vendor_sku: Optional[str] = Field(default=None, max_length=100)
    shelf_life_days: Optional[int] = None


class EasyInventoryPreviewRequest(BaseModel):
    rows: List[EasyInventoryRowInput] = Field(min_length=1, max_length=250)


class EasyInventoryCommitRequest(EasyInventoryPreviewRequest):
    idempotency_key: str = Field(min_length=8, max_length=100)


class InventoryPlanningSettingsRowUpdate(BaseModel):
    inventory_item_id: int
    planning_active: bool = True
    weekday_targets: dict[int, Optional[Decimal]] = Field(default_factory=dict)
    lower_tolerance_percent: Optional[Decimal] = Field(default=None, ge=0, le=100)
    upper_tolerance_percent: Optional[Decimal] = Field(default=None, ge=0, le=100)
    preferred_vendor_id: Optional[int] = None
    vendor_sku: Optional[str] = Field(default=None, max_length=100)
    purchase_unit: Optional[str] = Field(default=None, max_length=30)
    pack_quantity: Decimal = Field(default=Decimal("1"), gt=0)
    unit_price_cents: int = Field(default=0, ge=0)


class InventoryPlanningSettingsBulkUpdate(BaseModel):
    location_id: int
    rows: List[InventoryPlanningSettingsRowUpdate] = Field(min_length=1)


class VendorBase(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    contact_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    lead_time_days: int = Field(default=1, ge=0)
    active: bool = True


class VendorCreate(VendorBase):
    pass


class VendorRead(VendorBase, TimestampModel):
    id: int
    model_config = ConfigDict(from_attributes=True)


class VendorItemCreate(BaseModel):
    vendor_id: int
    inventory_item_id: int
    vendor_sku: Optional[str] = None
    unit_price_cents: int = Field(default=0, ge=0)
    pack_quantity: Decimal = Field(default=Decimal("1"), gt=0)
    preferred: bool = False


class VendorItemRead(VendorItemCreate, TimestampModel):
    id: int
    model_config = ConfigDict(from_attributes=True)


class InventoryMovementCreate(BaseModel):
    inventory_item_id: int
    location_id: int
    quantity_change: Decimal
    reason: str = Field(min_length=1, max_length=100)
    notes: Optional[str] = None
    source_event_key: Optional[str] = None
    lot_number: Optional[str] = None
    expiration_date: Optional[date] = None


class InventoryMovementRead(InventoryMovementCreate, TimestampModel):
    id: int
    created_by_user_id: Optional[int] = None
    model_config = ConfigDict(from_attributes=True)


class InventoryTransferCreate(BaseModel):
    inventory_item_id: int
    from_location_id: int
    to_location_id: int
    quantity: Decimal = Field(gt=0)
    notes: Optional[str] = None


class InventoryStockRead(BaseModel):
    inventory_item_id: int
    item_name: str
    category: Optional[str]
    location_id: int
    location_name: str
    base_unit: str
    quantity_on_hand: Decimal
    minimum_quantity: Decimal
    par_quantity: Decimal
    status: str
    earliest_expiration: Optional[date] = None


class InventoryCountLineCreate(BaseModel):
    inventory_item_id: int
    counted_quantity: Decimal = Field(ge=0)
    notes: Optional[str] = None


class InventoryCountCreate(BaseModel):
    location_id: int
    notes: Optional[str] = None
    lines: List[InventoryCountLineCreate] = Field(default_factory=list)


class InventoryCountRead(BaseModel):
    id: int
    location_id: int
    status: InventoryCountStatus
    counted_by_user_id: int
    reviewed_by_user_id: Optional[int] = None
    notes: Optional[str] = None
    lines: List[dict] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)


class CountSheetCreate(BaseModel):
    location_id: int
    template_id: Optional[int] = None
    notes: Optional[str] = None
    resume_existing: bool = True


class CountSheetLinePatch(BaseModel):
    counted_quantity: Optional[Decimal] = Field(default=None, ge=0)
    is_counted: Optional[bool] = None
    notes: Optional[str] = None
    source: Optional[Literal["MANUAL", "VOICE", "IMPORT"]] = None
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    review_status: Optional[
        Literal["PENDING", "READY", "NEEDS_REVIEW", "APPROVED"]
    ] = None
    evidence: Optional[str] = Field(default=None, max_length=4000)
    client_revision: Optional[int] = Field(default=None, ge=1)


class CountSheetBatchLinePatch(CountSheetLinePatch):
    line_id: int


class CountSheetBatchPatch(BaseModel):
    edits: List[CountSheetBatchLinePatch] = Field(min_length=1, max_length=250)


class CountSheetReorder(BaseModel):
    line_ids: List[int] = Field(min_length=1, max_length=2000)


class CountSheetRead(BaseModel):
    id: int
    location_id: int
    location_name: str
    template_id: Optional[int] = None
    template_name: Optional[str] = None
    status: str
    revision: int
    counted_by_user_id: int
    reviewed_by_user_id: Optional[int] = None
    approved_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    line_count: int
    counted_line_count: int
    uncounted_line_count: int
    exception_count: int
    completion_percent: float
    lines: List[dict[str, Any]] = Field(default_factory=list)


class CountTemplateLineCreate(BaseModel):
    inventory_item_id: int
    location_id: int
    display_order: int = Field(default=0, ge=0)
    preferred_unit: Optional[str] = Field(default=None, max_length=30)


class CountTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    description: Optional[str] = None
    lines: List[CountTemplateLineCreate] = Field(min_length=1, max_length=2000)


class CountTemplateRead(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    active: bool
    created_by_user_id: int
    lines: List[dict[str, Any]] = Field(default_factory=list)


class PurchaseOrderLineCreate(BaseModel):
    inventory_item_id: int
    location_id: Optional[int] = None
    ordered_quantity: Decimal = Field(gt=0)
    unit_price_cents: int = Field(default=0, ge=0)
    purchase_unit: Optional[str] = None
    quantity_per_purchase_unit: Decimal = Field(default=Decimal("1"), gt=0)


class PurchaseOrderCreate(BaseModel):
    vendor_id: int
    expected_date: Optional[date] = None
    notes: Optional[str] = None
    lines: List[PurchaseOrderLineCreate] = Field(default_factory=list)


class PurchaseOrderRead(BaseModel):
    id: int
    vendor_id: int
    status: PurchaseOrderStatus
    expected_date: Optional[date] = None
    notes: Optional[str] = None
    external_reference: Optional[str] = None
    imported_filename: Optional[str] = None
    created_by_user_id: int
    lines: List[dict] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)


class PurchaseOrderCSVPreviewRequest(BaseModel):
    vendor_id: int
    csv_text: str = Field(min_length=1, max_length=2_000_000)
    source_filename: Optional[str] = Field(default=None, max_length=255)
    expected_date: Optional[date] = None
    item_overrides: dict[int, int] = Field(default_factory=dict)
    default_location_id: Optional[int] = None
    location_overrides: dict[int, int] = Field(default_factory=dict)


class PurchaseOrderCSVImportRequest(PurchaseOrderCSVPreviewRequest):
    notes: Optional[str] = Field(default=None, max_length=2000)
    external_reference: Optional[str] = Field(default=None, max_length=100)


class PurchaseOrderPlanLineCreate(BaseModel):
    inventory_item_id: int
    location_id: int
    purchase_quantity: Decimal = Field(gt=0)


class PurchaseOrderPlanCreate(BaseModel):
    expected_date: date
    notes: Optional[str] = Field(default=None, max_length=2000)
    lines: List[PurchaseOrderPlanLineCreate] = Field(min_length=1)


class ReceivingLineCreate(BaseModel):
    purchase_order_line_id: Optional[int] = None
    inventory_item_id: int
    location_id: Optional[int] = None
    received_quantity: Decimal = Field(gt=0)
    unit_price_cents: int = Field(default=0, ge=0)
    lot_number: Optional[str] = None
    expiration_date: Optional[date] = None
    notes: Optional[str] = None


class ReceivingCreate(BaseModel):
    purchase_order_id: int
    invoice_number: Optional[str] = None
    notes: Optional[str] = None
    allow_overage: bool = False
    lines: List[ReceivingLineCreate] = Field(default_factory=list)


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
