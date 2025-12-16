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


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


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
    max_guests: Optional[int] = None
    is_active: bool = True


class SectionCreate(SectionBase):
    pass


class SectionUpdate(BaseModel):
    name: Optional[str] = None
    label: Optional[str] = None
    type: Optional[SectionType] = None
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


class GiftTrackerEntryPayload(BaseModel):
    employee_name: str = Field(min_length=1, max_length=255)
    tuesday: int = 0
    wednesday: int = 0
    thursday: int = 0
    friday: int = 0
    saturday: int = 0
    sunday: int = 0
    monday: int = 0


class GiftTrackerUpsertRequest(BaseModel):
    week_number: int = Field(ge=1)
    entries: List[GiftTrackerEntryPayload] = Field(default_factory=list)


class GiftTrackerEntryRead(GiftTrackerEntryPayload, TimestampModel):
    id: int
    week_number: int

    model_config = ConfigDict(from_attributes=True)
