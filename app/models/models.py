import enum
from datetime import datetime, date
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Float,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import relationship, Mapped, mapped_column

from app.database import Base


class UserRole(str, enum.Enum):
    ADMIN = "ADMIN"
    MANAGER = "MANAGER"
    SERVER = "SERVER"


class EmployeeRole(str, enum.Enum):
    SERVER = "SERVER"
    HOST = "HOST"
    BARTENDER = "BARTENDER"
    BUSSER = "BUSSER"
    OTHER = "OTHER"


class SectionType(str, enum.Enum):
    BAR = "BAR"
    FLOOR = "FLOOR"
    PATIO = "PATIO"
    LOBBY = "LOBBY"
    OTHER = "OTHER"


class ShiftPeriod(str, enum.Enum):
    LUNCH = "LUNCH"
    DINNER = "DINNER"
    DOUBLE = "DOUBLE"
    OTHER = "OTHER"


class TeamSheetStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"
    ARCHIVED = "ARCHIVED"


class PyosShift(str, enum.Enum):
    AM = "AM"
    PM = "PM"


class PyosStatus(str, enum.Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    DENIED = "DENIED"
    REVOKED = "REVOKED"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.SERVER)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"))

    shifts = relationship("Shift", back_populates="creator")
    team_sheets = relationship("TeamSheet", back_populates="creator")
    employee = relationship("Employee")


class Employee(Base, TimestampMixin):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    nickname: Mapped[str | None] = mapped_column(String(100))
    role: Mapped[EmployeeRole] = mapped_column(Enum(EmployeeRole))
    employment_start_date: Mapped[date]
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    upsell_score: Mapped[int | None]
    pitty_score: Mapped[int | None]
    employment_days: Mapped[int | None]
    max_section_load: Mapped[int | None]
    notes: Mapped[str | None] = mapped_column(Text)

    assignments = relationship("TeamSheetAssignment", back_populates="employee")


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    label: Mapped[str] = mapped_column(String(100))
    type: Mapped[SectionType] = mapped_column(Enum(SectionType))
    tables: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    tags: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    cut_order: Mapped[int | None]
    sidework: Mapped[str | None] = mapped_column(Text, nullable=True)
    outwork: Mapped[str | None] = mapped_column(Text, nullable=True)
    max_capacity: Mapped[int | None]
    expected_out_time: Mapped[str | None] = mapped_column(String(50))
    max_guests: Mapped[int | None]
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    assignments = relationship("TeamSheetAssignment", back_populates="section")


class Shift(Base, TimestampMixin):
    __tablename__ = "shifts"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date]
    time_period: Mapped[ShiftPeriod] = mapped_column(Enum(ShiftPeriod))
    store_id: Mapped[int | None]
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    creator = relationship("User", back_populates="shifts")
    team_sheets = relationship("TeamSheet", back_populates="shift")


class TeamSheet(Base, TimestampMixin):
    __tablename__ = "team_sheets"

    id: Mapped[int] = mapped_column(primary_key=True)
    shift_id: Mapped[int] = mapped_column(ForeignKey("shifts.id"))
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[TeamSheetStatus] = mapped_column(Enum(TeamSheetStatus), default=TeamSheetStatus.DRAFT)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))

    shift = relationship("Shift", back_populates="team_sheets")
    creator = relationship("User", back_populates="team_sheets")
    assignments = relationship("TeamSheetAssignment", back_populates="team_sheet", cascade="all, delete-orphan")
    sidework_tasks = relationship("SideworkTask", back_populates="team_sheet", cascade="all, delete-orphan")
    outwork_tasks = relationship("OutworkTask", back_populates="team_sheet", cascade="all, delete-orphan")


class TeamSheetAssignment(Base):
    __tablename__ = "team_sheet_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_sheet_id: Mapped[int] = mapped_column(ForeignKey("team_sheets.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"))
    role_label: Mapped[str | None] = mapped_column(String(100))
    order_index: Mapped[int | None]

    team_sheet = relationship("TeamSheet", back_populates="assignments")
    employee = relationship("Employee", back_populates="assignments")
    section = relationship("Section", back_populates="assignments")


class SideworkTask(Base):
    __tablename__ = "sidework_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_sheet_id: Mapped[int] = mapped_column(ForeignKey("team_sheets.id"))
    label: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)

    team_sheet = relationship("TeamSheet", back_populates="sidework_tasks")
    assignments = relationship("SideworkAssignment", back_populates="task", cascade="all, delete-orphan")


class SideworkAssignment(Base):
    __tablename__ = "sidework_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("sidework_tasks.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))

    task = relationship("SideworkTask", back_populates="assignments")


class OutworkTask(Base):
    __tablename__ = "outwork_tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_sheet_id: Mapped[int] = mapped_column(ForeignKey("team_sheets.id"))
    label: Mapped[str] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)

    team_sheet = relationship("TeamSheet", back_populates="outwork_tasks")
    assignments = relationship("OutworkAssignment", back_populates="task", cascade="all, delete-orphan")


class OutworkAssignment(Base):
    __tablename__ = "outwork_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("outwork_tasks.id"))
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))

    task = relationship("OutworkTask", back_populates="assignments")


class CobrandDeal(Base, TimestampMixin):
    __tablename__ = "cobrand_deals"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    date_of_commission: Mapped[date | None] = mapped_column(Date, nullable=True)
    date_of_payment: Mapped[date | None] = mapped_column(Date, nullable=True)
    date_of_pickup: Mapped[date | None] = mapped_column(Date, nullable=True)
    seller_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    logo_base64: Mapped[str | None] = mapped_column(Text, nullable=True)
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    seller = relationship("Employee")

    @property
    def amount_usd(self) -> float:
        if self.amount_cents is None:
            return 0.0
        return self.amount_cents / 100

    @property
    def seller_name(self) -> str | None:
        if not self.seller:
            return None
        full_name = f"{self.seller.first_name or ''} {self.seller.last_name or ''}".strip()
        return full_name or self.seller.nickname


class GiftTrackerEntry(Base, TimestampMixin):
    __tablename__ = "gift_tracker_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    week_number: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    tuesday: Mapped[int] = mapped_column(Integer, default=0)
    wednesday: Mapped[int] = mapped_column(Integer, default=0)
    thursday: Mapped[int] = mapped_column(Integer, default=0)
    friday: Mapped[int] = mapped_column(Integer, default=0)
    saturday: Mapped[int] = mapped_column(Integer, default=0)
    sunday: Mapped[int] = mapped_column(Integer, default=0)
    monday: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        {"sqlite_autoincrement": True},
    )


class PyosCredit(Base, TimestampMixin):
    __tablename__ = "pyos_credits"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), unique=True, nullable=False)
    balance: Mapped[int] = mapped_column(Integer, default=0)

    employee = relationship("Employee")


class PyosRequest(Base, TimestampMixin):
    __tablename__ = "pyos_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), nullable=False)
    section_id: Mapped[int] = mapped_column(ForeignKey("sections.id"), nullable=False)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    shift: Mapped[PyosShift] = mapped_column(Enum(PyosShift), nullable=False)
    status: Mapped[PyosStatus] = mapped_column(Enum(PyosStatus), default=PyosStatus.PENDING)
    notes: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    approved_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    denied_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    revoked_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    denied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    employee = relationship("Employee")
    section = relationship("Section")
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    approved_by = relationship("User", foreign_keys=[approved_by_user_id])
    denied_by = relationship("User", foreign_keys=[denied_by_user_id])
    revoked_by = relationship("User", foreign_keys=[revoked_by_user_id])

    __table_args__ = (
        UniqueConstraint("section_id", "date", "shift", name="uq_pyos_section_date_shift"),
    )


class PyosAudit(Base, TimestampMixin):
    __tablename__ = "pyos_audit"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"))
    action: Mapped[str] = mapped_column(String(50))
    delta: Mapped[int | None] = mapped_column(Integer)
    details_json: Mapped[dict | None] = mapped_column(JSON)

    actor = relationship("User")
    employee = relationship("Employee")


class PayoutType(str, enum.Enum):
    FIXED = "FIXED"
    PERCENT = "PERCENT"


class PayoutTier(Base, TimestampMixin):
    __tablename__ = "payout_tiers"

    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    min_amount_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_amount_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payout_type: Mapped[PayoutType] = mapped_column(Enum(PayoutType), default=PayoutType.FIXED)
    payout_value: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # cents if FIXED, percent * 100 if PERCENT
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class PayoutRule(Base, TimestampMixin):
    __tablename__ = "payout_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(100), nullable=False)  # e.g., season_top_seller, monthly_pass
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    config: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON string
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Prize(Base, TimestampMixin):
    __tablename__ = "prizes"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    cost_cents: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class PrizeAssignment(Base, TimestampMixin):
    __tablename__ = "prize_assignments"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    prize_id: Mapped[int] = mapped_column(ForeignKey("prizes.id"))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    prize = relationship("Prize")


class PayoutAdjustment(Base, TimestampMixin):
    __tablename__ = "payout_adjustments"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    season_year: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class Season(Base, TimestampMixin):
    __tablename__ = "seasons"

    id: Mapped[int] = mapped_column(primary_key=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)


class StorePreference(Base, TimestampMixin):
    __tablename__ = "store_preferences"

    id: Mapped[int] = mapped_column(primary_key=True)
    store_number: Mapped[str] = mapped_column(String(50), nullable=False, unique=True, index=True)
    daily_schedule: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
    blast_minimum_percent: Mapped[float] = mapped_column(Float, nullable=False, default=98.0)


class POSOrderStatus(str, enum.Enum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    VOIDED = "VOIDED"


class POSAccessRole(str, enum.Enum):
    SERVER = "SERVER"
    MANAGER = "MANAGER"


class POSTableStatus(str, enum.Enum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"


class POSCheckProgress(str, enum.Enum):
    FOOD_UNORDERED = "FOOD_UNORDERED"
    FOOD_ORDERED = "FOOD_ORDERED"
    CHECK_PAID = "CHECK_PAID"


class POSCredential(Base, TimestampMixin):
    __tablename__ = "pos_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        ForeignKey("employees.id"), unique=True, nullable=False, index=True
    )
    pin_lookup_digest: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, index=True
    )
    pin_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    access_role: Mapped[POSAccessRole] = mapped_column(
        Enum(POSAccessRole), default=POSAccessRole.SERVER, nullable=False
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    employee = relationship("Employee")
    sessions = relationship(
        "POSTerminalSession", back_populates="credential", cascade="all, delete-orphan"
    )


class POSTerminalSession(Base):
    __tablename__ = "pos_terminal_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    credential_id: Mapped[int] = mapped_column(
        ForeignKey("pos_credentials.id"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(
        String(64), unique=True, nullable=False, index=True
    )
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    credential = relationship("POSCredential", back_populates="sessions")


class POSTable(Base, TimestampMixin):
    __tablename__ = "pos_tables"

    id: Mapped[int] = mapped_column(primary_key=True)
    table_number: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    client_request_id: Mapped[str | None] = mapped_column(
        String(64), unique=True, nullable=True, index=True
    )
    active_number_key: Mapped[str | None] = mapped_column(
        String(20), unique=True, nullable=True, index=True
    )
    owner_employee_id: Mapped[int] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    status: Mapped[POSTableStatus] = mapped_column(
        Enum(POSTableStatus), default=POSTableStatus.OPEN, nullable=False, index=True
    )
    progress: Mapped[POSCheckProgress] = mapped_column(
        Enum(POSCheckProgress),
        default=POSCheckProgress.FOOD_UNORDERED,
        nullable=False,
    )
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    owner = relationship("Employee")
    checks = relationship(
        "POSOrder", back_populates="table", cascade="all, delete-orphan"
    )
    events = relationship(
        "POSTableEvent", back_populates="table", cascade="all, delete-orphan"
    )


class POSTableEvent(Base):
    __tablename__ = "pos_table_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    table_id: Mapped[int] = mapped_column(
        ForeignKey("pos_tables.id"), nullable=False, index=True
    )
    order_id: Mapped[int | None] = mapped_column(
        ForeignKey("pos_orders.id"), nullable=True, index=True
    )
    employee_id: Mapped[int] = mapped_column(
        ForeignKey("employees.id"), nullable=False, index=True
    )
    event_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, nullable=False
    )

    table = relationship("POSTable", back_populates="events")
    order = relationship("POSOrder")
    employee = relationship("Employee")


class MenuCategory(Base):
    __tablename__ = "menu_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    items = relationship("MenuItem", back_populates="category")


class MenuItem(Base):
    __tablename__ = "menu_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("menu_categories.id"))
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    category = relationship("MenuCategory", back_populates="items")
    recipe_items = relationship("RecipeItem", back_populates="menu_item", cascade="all, delete-orphan")


class Ingredient(Base):
    __tablename__ = "ingredients"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False, unique=True)
    unit: Mapped[str] = mapped_column(String(50), nullable=False, default="unit")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    external_id: Mapped[str | None] = mapped_column(String(150), nullable=True, unique=True, index=True)
    normalized_name: Mapped[str | None] = mapped_column(String(150), nullable=True, index=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    stage: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    process: Mapped[str | None] = mapped_column(Text, nullable=True)
    added_to_complete_lineage: Mapped[bool] = mapped_column(Boolean, default=False)
    source_correction: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolution_needed: Mapped[str | None] = mapped_column(Text, nullable=True)
    catalog_schema_version: Mapped[str | None] = mapped_column(String(30), nullable=True)
    catalog_metadata: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    recipe_items = relationship("RecipeItem", back_populates="ingredient")
    stock_movements = relationship("StockMovement", back_populates="ingredient")
    inventory_items = relationship("InventoryItem", back_populates="ingredient")
    parent_links = relationship(
        "IngredientLineage",
        foreign_keys="IngredientLineage.child_ingredient_id",
        back_populates="child",
        cascade="all, delete-orphan",
    )
    child_links = relationship(
        "IngredientLineage",
        foreign_keys="IngredientLineage.parent_ingredient_id",
        back_populates="parent",
    )


class IngredientLineage(Base):
    __tablename__ = "ingredient_lineage"

    id: Mapped[int] = mapped_column(primary_key=True)
    child_ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), nullable=False, index=True)
    parent_ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"), nullable=False, index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)

    child = relationship("Ingredient", foreign_keys=[child_ingredient_id], back_populates="parent_links")
    parent = relationship("Ingredient", foreign_keys=[parent_ingredient_id], back_populates="child_links")
    __table_args__ = (
        UniqueConstraint(
            "child_ingredient_id",
            "parent_ingredient_id",
            name="uq_ingredient_lineage_child_parent",
        ),
    )


class IngredientCatalogImport(Base, TimestampMixin):
    __tablename__ = "ingredient_catalog_imports"

    id: Mapped[int] = mapped_column(primary_key=True)
    schema_version: Mapped[str] = mapped_column(String(30), nullable=False)
    source_name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    item_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    relationship_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    catalog_metadata: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class RecipeItem(Base):
    __tablename__ = "recipe_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"))
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"))
    quantity: Mapped[float] = mapped_column(Float, default=1)
    selection_type: Mapped[str] = mapped_column(String(20), default="INCLUDED", nullable=False, server_default="INCLUDED")
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))

    menu_item = relationship("MenuItem", back_populates="recipe_items")
    ingredient = relationship("Ingredient", back_populates="recipe_items")


class POSOrder(Base, TimestampMixin):
    __tablename__ = "pos_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[POSOrderStatus] = mapped_column(Enum(POSOrderStatus), default=POSOrderStatus.OPEN)
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"))
    server_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"))
    table_id: Mapped[int | None] = mapped_column(
        ForeignKey("pos_tables.id"), nullable=True, index=True
    )
    check_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    progress: Mapped[POSCheckProgress] = mapped_column(
        Enum(POSCheckProgress),
        default=POSCheckProgress.FOOD_UNORDERED,
        nullable=False,
    )
    subtotal_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tax_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tip_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    print_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    printed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    table_label: Mapped[str | None] = mapped_column(String(50))
    notes: Mapped[str | None] = mapped_column(Text)

    table = relationship("POSTable", back_populates="checks")
    items = relationship("POSOrderItem", back_populates="order", cascade="all, delete-orphan")
    payments = relationship("POSPayment", back_populates="order", cascade="all, delete-orphan")


class POSOrderItem(Base, TimestampMixin):
    __tablename__ = "pos_order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("pos_orders.id"))
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    modifier_total_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    display_name_snapshot: Mapped[str | None] = mapped_column(String(150))
    configuration_snapshot: Mapped[dict | None] = mapped_column(JSON)

    order = relationship("POSOrder", back_populates="items")
    menu_item = relationship("MenuItem")


class POSPayment(Base, TimestampMixin):
    __tablename__ = "pos_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("pos_orders.id"))
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    method: Mapped[str] = mapped_column(String(50), default="CARD")

    order = relationship("POSOrder", back_populates="payments")


class StockMovement(Base, TimestampMixin):
    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"))
    inventory_item_id: Mapped[int | None] = mapped_column(ForeignKey("inventory_items.id"), nullable=True, index=True)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("inventory_locations.id"), nullable=True, index=True)
    quantity_change: Mapped[float] = mapped_column(Float, default=0)
    reason: Mapped[str] = mapped_column(String(100))
    order_item_id: Mapped[int | None] = mapped_column(ForeignKey("pos_order_items.id"))
    source_event_key: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True, index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    lot_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    expiration_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text)

    ingredient = relationship("Ingredient", back_populates="stock_movements")


class InventoryLocation(Base, TimestampMixin):
    __tablename__ = "inventory_locations"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class InventoryItem(Base, TimestampMixin):
    __tablename__ = "inventory_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[int | None] = mapped_column(
        ForeignKey("ingredients.id"), unique=True, nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False, index=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    sku: Mapped[str | None] = mapped_column(String(100), unique=True, nullable=True, index=True)
    base_unit: Mapped[str] = mapped_column(String(30), default="unit")
    purchase_unit: Mapped[str | None] = mapped_column(String(30), nullable=True)
    purchase_to_base: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=1)
    default_location_id: Mapped[int | None] = mapped_column(ForeignKey("inventory_locations.id"), nullable=True)
    cost_cents: Mapped[int] = mapped_column(Integer, default=0)
    shelf_life_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    default_location = relationship("InventoryLocation")
    ingredient = relationship("Ingredient", back_populates="inventory_items")
    balances = relationship("InventoryBalance", back_populates="item", cascade="all, delete-orphan")
    vendor_items = relationship("VendorItem", back_populates="item", cascade="all, delete-orphan")


class InventoryEasyManagerCommit(Base, TimestampMixin):
    __tablename__ = "inventory_easy_manager_commits"

    id: Mapped[int] = mapped_column(primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(
        String(100), unique=True, nullable=False, index=True
    )
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    response_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True
    )


class InventoryBalance(Base, TimestampMixin):
    __tablename__ = "inventory_balances"

    id: Mapped[int] = mapped_column(primary_key=True)
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"), nullable=False)
    location_id: Mapped[int] = mapped_column(ForeignKey("inventory_locations.id"), nullable=False)
    quantity_on_hand: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    minimum_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    par_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    maximum_quantity: Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    planning_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    lower_tolerance_percent: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    upper_tolerance_percent: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)

    item = relationship("InventoryItem", back_populates="balances")
    location = relationship("InventoryLocation")
    __table_args__ = (UniqueConstraint("inventory_item_id", "location_id", name="uq_inventory_balance_item_location"),)


class InventoryWeekdayTarget(Base, TimestampMixin):
    __tablename__ = "inventory_weekday_targets"

    id: Mapped[int] = mapped_column(primary_key=True)
    inventory_item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id"), nullable=False, index=True
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id"), nullable=False, index=True
    )
    weekday: Mapped[int] = mapped_column(Integer, nullable=False)
    target_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), nullable=False)

    item = relationship("InventoryItem")
    location = relationship("InventoryLocation")
    __table_args__ = (
        UniqueConstraint(
            "inventory_item_id",
            "location_id",
            "weekday",
            name="uq_inventory_weekday_target",
        ),
    )


class Vendor(Base, TimestampMixin):
    __tablename__ = "inventory_vendors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False)
    contact_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    lead_time_days: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    items = relationship("VendorItem", back_populates="vendor", cascade="all, delete-orphan")


class VendorItem(Base, TimestampMixin):
    __tablename__ = "inventory_vendor_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("inventory_vendors.id"), nullable=False)
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"), nullable=False)
    vendor_sku: Mapped[str | None] = mapped_column(String(100), nullable=True)
    unit_price_cents: Mapped[int] = mapped_column(Integer, default=0)
    pack_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=1)
    preferred: Mapped[bool] = mapped_column(Boolean, default=False)

    vendor = relationship("Vendor", back_populates="items")
    item = relationship("InventoryItem", back_populates="vendor_items")
    __table_args__ = (UniqueConstraint("vendor_id", "inventory_item_id", name="uq_vendor_inventory_item"),)


class PurchaseOrderStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED"
    RECEIVED = "RECEIVED"
    CANCELLED = "CANCELLED"


class PurchaseOrder(Base, TimestampMixin):
    __tablename__ = "inventory_purchase_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("inventory_vendors.id"), nullable=False)
    status: Mapped[PurchaseOrderStatus] = mapped_column(Enum(PurchaseOrderStatus), default=PurchaseOrderStatus.DRAFT)
    expected_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_reference: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    import_source_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True, index=True)
    imported_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)

    vendor = relationship("Vendor")
    lines = relationship("PurchaseOrderLine", back_populates="purchase_order", cascade="all, delete-orphan")
    __table_args__ = (
        UniqueConstraint("vendor_id", "external_reference", name="uq_purchase_order_vendor_reference"),
    )


class PurchaseOrderLine(Base):
    __tablename__ = "inventory_purchase_order_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("inventory_purchase_orders.id"), nullable=False)
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"), nullable=False)
    location_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_locations.id"), nullable=True, index=True
    )
    ordered_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    unit_price_cents: Mapped[int] = mapped_column(Integer, default=0)
    received_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    purchase_unit: Mapped[str | None] = mapped_column(String(30), nullable=True)
    quantity_per_purchase_unit: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=1)

    purchase_order = relationship("PurchaseOrder", back_populates="lines")
    item = relationship("InventoryItem")
    location = relationship("InventoryLocation")


class InventoryCountStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    APPROVED = "APPROVED"
    POSTED = "POSTED"
    REJECTED = "REJECTED"


class InventoryCount(Base, TimestampMixin):
    __tablename__ = "inventory_counts"

    id: Mapped[int] = mapped_column(primary_key=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("inventory_locations.id"), nullable=False)
    template_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_count_templates.id"), nullable=True, index=True
    )
    status: Mapped[InventoryCountStatus] = mapped_column(Enum(InventoryCountStatus), default=InventoryCountStatus.DRAFT)
    counted_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    reviewed_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    approved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    location = relationship("InventoryLocation")
    template = relationship("InventoryCountTemplate")
    lines = relationship("InventoryCountLine", back_populates="count", cascade="all, delete-orphan")


class InventoryCountLine(Base):
    __tablename__ = "inventory_count_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    count_id: Mapped[int] = mapped_column(ForeignKey("inventory_counts.id"), nullable=False)
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"), nullable=False)
    counted_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    expected_quantity: Mapped[Decimal | None] = mapped_column(Numeric(12, 4), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_counted: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    source: Mapped[str | None] = mapped_column(String(20), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    review_status: Mapped[str] = mapped_column(
        String(30), default="READY", nullable=False, index=True
    )
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id"), nullable=True
    )

    count = relationship("InventoryCount", back_populates="lines")
    item = relationship("InventoryItem")
    __table_args__ = (UniqueConstraint("count_id", "inventory_item_id", name="uq_inventory_count_line"),)


class InventoryCountTemplate(Base, TimestampMixin):
    __tablename__ = "inventory_count_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_by_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )

    lines = relationship(
        "InventoryCountTemplateLine",
        back_populates="template",
        cascade="all, delete-orphan",
        order_by="InventoryCountTemplateLine.display_order",
    )


class InventoryCountTemplateLine(Base):
    __tablename__ = "inventory_count_template_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    template_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_count_templates.id"), nullable=False, index=True
    )
    inventory_item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id"), nullable=False
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id"), nullable=False
    )
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    preferred_unit: Mapped[str | None] = mapped_column(String(30), nullable=True)

    template = relationship("InventoryCountTemplate", back_populates="lines")
    item = relationship("InventoryItem")
    location = relationship("InventoryLocation")
    __table_args__ = (
        UniqueConstraint(
            "template_id",
            "inventory_item_id",
            "location_id",
            name="uq_count_template_item_location",
        ),
    )


class InventoryVoiceSessionStatus(str, enum.Enum):
    CREATED = "CREATED"
    LISTENING = "LISTENING"
    PAUSED = "PAUSED"
    OFFLINE = "OFFLINE"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    FINISHED = "FINISHED"
    ABANDONED = "ABANDONED"


class InventoryVoiceUtteranceStatus(str, enum.Enum):
    RECEIVED = "RECEIVED"
    TRANSCRIBED = "TRANSCRIBED"
    NORMALIZED = "NORMALIZED"
    NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"


class InventoryVoiceEntryAction(str, enum.Enum):
    SET = "SET"
    ADD = "ADD"
    REPLACE = "REPLACE"
    REMOVE = "REMOVE"
    NOTE = "NOTE"
    SWITCH_LOCATION = "SWITCH_LOCATION"


class InventoryVoiceReviewStatus(str, enum.Enum):
    AUTO_ACCEPTED = "AUTO_ACCEPTED"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    CORRECTED = "CORRECTED"
    REJECTED = "REJECTED"


class InventoryAliasSource(str, enum.Enum):
    CATALOG = "CATALOG"
    MANUAL = "MANUAL"
    LEARNED = "LEARNED"


class InventoryVoiceSession(Base, TimestampMixin):
    __tablename__ = "inventory_voice_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_session_id: Mapped[str] = mapped_column(
        String(36), unique=True, nullable=False, index=True
    )
    manager_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id"), nullable=False, index=True
    )
    status: Mapped[InventoryVoiceSessionStatus] = mapped_column(
        Enum(InventoryVoiceSessionStatus),
        default=InventoryVoiceSessionStatus.CREATED,
        nullable=False,
        index=True,
    )
    current_location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id"), nullable=False
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_client_sequence: Mapped[int] = mapped_column(Integer, default=0)
    device_metadata: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    transcription_model: Mapped[str] = mapped_column(
        String(100), default="gpt-realtime-whisper"
    )
    normalization_model: Mapped[str] = mapped_column(
        String(100), default="gpt-5.6-luna"
    )
    prompt_version: Mapped[str] = mapped_column(String(50), default="voice-inventory-v1")
    audio_delete_after: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    manager = relationship("User")
    current_location = relationship("InventoryLocation")
    utterances = relationship(
        "InventoryVoiceUtterance",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="InventoryVoiceUtterance.sequence",
    )
    entries = relationship(
        "InventoryVoiceEntry",
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="InventoryVoiceEntry.id",
    )
    count_links = relationship(
        "InventoryVoiceSessionCount",
        back_populates="session",
        cascade="all, delete-orphan",
    )


class InventoryVoiceUtterance(Base, TimestampMixin):
    __tablename__ = "inventory_voice_utterances"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_voice_sessions.id"), nullable=False, index=True
    )
    client_event_id: Mapped[str] = mapped_column(String(36), nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    realtime_item_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    transcript: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status: Mapped[InventoryVoiceUtteranceStatus] = mapped_column(
        Enum(InventoryVoiceUtteranceStatus),
        default=InventoryVoiceUtteranceStatus.RECEIVED,
        nullable=False,
        index=True,
    )
    audio_object_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    audio_missing: Mapped[bool] = mapped_column(Boolean, default=False)
    error_details: Mapped[str | None] = mapped_column(Text, nullable=True)

    session = relationship("InventoryVoiceSession", back_populates="utterances")
    entries = relationship(
        "InventoryVoiceEntry",
        back_populates="utterance",
        cascade="all, delete-orphan",
    )
    __table_args__ = (
        UniqueConstraint(
            "session_id", "client_event_id", name="uq_voice_utterance_client_event"
        ),
        UniqueConstraint("session_id", "sequence", name="uq_voice_utterance_sequence"),
    )


class InventoryVoiceEntry(Base, TimestampMixin):
    __tablename__ = "inventory_voice_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_voice_sessions.id"), nullable=False, index=True
    )
    utterance_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_voice_utterances.id"), nullable=False, index=True
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id"), nullable=False, index=True
    )
    inventory_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_items.id"), nullable=True, index=True
    )
    action: Mapped[InventoryVoiceEntryAction] = mapped_column(
        Enum(InventoryVoiceEntryAction), nullable=False
    )
    spoken_item: Mapped[str | None] = mapped_column(String(200), nullable=True)
    spoken_quantity: Mapped[Decimal | None] = mapped_column(
        Numeric(12, 4), nullable=True
    )
    spoken_unit: Mapped[str | None] = mapped_column(String(50), nullable=True)
    normalized_quantity: Mapped[Decimal | None] = mapped_column(
        Numeric(12, 4), nullable=True
    )
    evidence: Mapped[str] = mapped_column(Text, nullable=False)
    ambiguity_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    review_status: Mapped[InventoryVoiceReviewStatus] = mapped_column(
        Enum(InventoryVoiceReviewStatus),
        default=InventoryVoiceReviewStatus.NEEDS_REVIEW,
        nullable=False,
        index=True,
    )
    supersedes_entry_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_voice_entries.id"), nullable=True
    )

    session = relationship("InventoryVoiceSession", back_populates="entries")
    utterance = relationship("InventoryVoiceUtterance", back_populates="entries")
    location = relationship("InventoryLocation")
    item = relationship("InventoryItem")
    supersedes_entry = relationship("InventoryVoiceEntry", remote_side=[id])


class InventoryItemAlias(Base, TimestampMixin):
    __tablename__ = "inventory_item_aliases"

    id: Mapped[int] = mapped_column(primary_key=True)
    inventory_item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id"), nullable=False, index=True
    )
    normalized_alias: Mapped[str] = mapped_column(
        String(200), nullable=False, index=True
    )
    source: Mapped[InventoryAliasSource] = mapped_column(
        Enum(InventoryAliasSource), default=InventoryAliasSource.MANUAL
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    item = relationship("InventoryItem")
    __table_args__ = (
        UniqueConstraint(
            "inventory_item_id", "normalized_alias", name="uq_inventory_item_alias"
        ),
    )


class InventoryVoiceSessionCount(Base, TimestampMixin):
    __tablename__ = "inventory_voice_session_counts"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_voice_sessions.id"), nullable=False, index=True
    )
    location_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_locations.id"), nullable=False
    )
    inventory_count_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_counts.id"), nullable=False, unique=True
    )

    session = relationship("InventoryVoiceSession", back_populates="count_links")
    location = relationship("InventoryLocation")
    inventory_count = relationship("InventoryCount")
    __table_args__ = (
        UniqueConstraint(
            "session_id", "location_id", name="uq_voice_session_count_location"
        ),
    )


class InventoryReceiving(Base, TimestampMixin):
    __tablename__ = "inventory_receiving"

    id: Mapped[int] = mapped_column(primary_key=True)
    purchase_order_id: Mapped[int] = mapped_column(ForeignKey("inventory_purchase_orders.id"), nullable=False)
    received_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    invoice_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    purchase_order = relationship("PurchaseOrder")
    lines = relationship("InventoryReceivingLine", back_populates="receiving", cascade="all, delete-orphan")


class InventoryReceivingLine(Base):
    __tablename__ = "inventory_receiving_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    receiving_id: Mapped[int] = mapped_column(ForeignKey("inventory_receiving.id"), nullable=False)
    purchase_order_line_id: Mapped[int | None] = mapped_column(
        ForeignKey("inventory_purchase_order_lines.id"), nullable=True, index=True
    )
    inventory_item_id: Mapped[int] = mapped_column(ForeignKey("inventory_items.id"), nullable=False)
    location_id: Mapped[int] = mapped_column(ForeignKey("inventory_locations.id"), nullable=False)
    received_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 4), default=0)
    unit_price_cents: Mapped[int] = mapped_column(Integer, default=0)
    lot_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    expiration_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    receiving = relationship("InventoryReceiving", back_populates="lines")
    purchase_order_line = relationship("PurchaseOrderLine")
    item = relationship("InventoryItem")
    location = relationship("InventoryLocation")


class DailyRoster(Base, TimestampMixin):
    __tablename__ = "daily_rosters"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    store_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    entries: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)


class TeamSheetPreset(Base, TimestampMixin):
    __tablename__ = "teamsheet_presets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    store_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    data_json: Mapped[list[dict] | None] = mapped_column(JSON, nullable=True)
