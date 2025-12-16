import enum
from datetime import datetime, date

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
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

    shifts = relationship("Shift", back_populates="creator")
    team_sheets = relationship("TeamSheet", back_populates="creator")


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
