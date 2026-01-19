import enum
from datetime import datetime, date

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
    String,
    Text,
    UniqueConstraint,
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


class POSOrderStatus(str, enum.Enum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"
    VOIDED = "VOIDED"


class MenuCategory(Base):
    __tablename__ = "menu_categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

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

    recipe_items = relationship("RecipeItem", back_populates="ingredient")
    stock_movements = relationship("StockMovement", back_populates="ingredient")


class RecipeItem(Base):
    __tablename__ = "recipe_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"))
    ingredient_id: Mapped[int] = mapped_column(ForeignKey("ingredients.id"))
    quantity: Mapped[float] = mapped_column(Float, default=1)

    menu_item = relationship("MenuItem", back_populates="recipe_items")
    ingredient = relationship("Ingredient", back_populates="recipe_items")


class POSOrder(Base, TimestampMixin):
    __tablename__ = "pos_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[POSOrderStatus] = mapped_column(Enum(POSOrderStatus), default=POSOrderStatus.OPEN)
    shift_id: Mapped[int | None] = mapped_column(ForeignKey("shifts.id"))
    server_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"))
    table_label: Mapped[str | None] = mapped_column(String(50))
    notes: Mapped[str | None] = mapped_column(Text)

    items = relationship("POSOrderItem", back_populates="order", cascade="all, delete-orphan")
    payments = relationship("POSPayment", back_populates="order", cascade="all, delete-orphan")


class POSOrderItem(Base, TimestampMixin):
    __tablename__ = "pos_order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("pos_orders.id"))
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

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
    quantity_change: Mapped[float] = mapped_column(Float, default=0)
    reason: Mapped[str] = mapped_column(String(100))
    order_item_id: Mapped[int | None] = mapped_column(ForeignKey("pos_order_items.id"))
    notes: Mapped[str | None] = mapped_column(Text)

    ingredient = relationship("Ingredient", back_populates="stock_movements")


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
