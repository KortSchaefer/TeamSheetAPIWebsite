from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AGMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class AGMTableInput(AGMModel):
    table_number: str = Field(min_length=1, max_length=20)
    label: str = Field(min_length=1, max_length=60)
    capacity: int = Field(ge=1, le=40)
    shape: Literal["ROUND", "SQUARE", "RECTANGLE", "BOOTH", "BAR"] = "ROUND"
    x: int = Field(ge=0, le=5000)
    y: int = Field(ge=0, le=5000)
    width: int = Field(default=88, ge=40, le=1000)
    height: int = Field(default=88, ge=40, le=1000)
    rotation: int = Field(default=0, ge=0, le=359)
    area_name: str | None = Field(default=None, max_length=80)
    section_name: str | None = Field(default=None, max_length=80)
    combinable_with: list[str] = Field(default_factory=list)


class AGMLayoutCreate(AGMModel):
    name: str = Field(min_length=1, max_length=120)
    canvas_width: int = Field(default=1200, ge=320, le=5000)
    canvas_height: int = Field(default=760, ge=320, le=5000)
    areas: list[dict[str, Any]] = Field(default_factory=list)
    fixtures: list[dict[str, Any]] = Field(default_factory=list)
    tables: list[AGMTableInput] = Field(default_factory=list, max_length=400)

    @field_validator("tables")
    @classmethod
    def unique_table_numbers(cls, rows: list[AGMTableInput]):
        numbers = [row.table_number.strip().lower() for row in rows]
        if len(numbers) != len(set(numbers)):
            raise ValueError("Table numbers must be unique within a layout")
        return rows


class AGMLayoutUpdate(AGMLayoutCreate):
    revision: int = Field(ge=1)


class AGMServiceCreate(AGMModel):
    layout_id: int
    service_date: date
    name: str = Field(default="Dinner", min_length=1, max_length=60)
    starts_at: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    ends_at: str | None = Field(default=None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


class AGMPartyCreate(AGMModel):
    guest_name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=32)
    party_size: int = Field(ge=1, le=40)
    source: Literal["WALK_IN", "WAITLIST", "RESERVATION"] = "WAITLIST"
    status: str | None = None
    reservation_at: datetime | None = None
    quoted_minutes: int | None = Field(default=None, ge=0, le=480)
    notes: str | None = Field(default=None, max_length=1000)
    sms_consent: bool = False


class AGMPartyUpdate(AGMModel):
    status: str | None = None
    guest_name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=32)
    party_size: int | None = Field(default=None, ge=1, le=40)
    reservation_at: datetime | None = None
    quoted_minutes: int | None = Field(default=None, ge=0, le=480)
    notes: str | None = Field(default=None, max_length=1000)
    sms_consent: bool | None = None
    revision: int = Field(ge=1)


class AGMRotationInput(AGMModel):
    employee_id: int
    section_name: str | None = Field(default=None, max_length=80)


class AGMCommand(AGMModel):
    command_id: str = Field(min_length=8, max_length=64)
    expected_revision: int = Field(ge=0)
    type: Literal[
        "SEAT",
        "MOVE",
        "COMBINE",
        "SET_TABLE_STATUS",
        "ADVANCE_STAGE",
        "CLEAR",
        "NOTIFY",
        "PAUSE_SERVER",
        "CLOSE_SERVICE",
    ]
    party_id: int | None = None
    table_numbers: list[str] = Field(default_factory=list, max_length=12)
    status: str | None = None
    dining_stage: str | None = None
    server_employee_id: int | None = None
    paused: bool | None = None


class AGMStoreMembershipCreate(AGMModel):
    user_id: int
    access_role: Literal["AGM", "ADMIN"] = "AGM"


class AGMStoreCreate(AGMModel):
    store_number: str = Field(min_length=1, max_length=30)
    name: str = Field(min_length=1, max_length=150)
    timezone: str = Field(default="America/Chicago", min_length=1, max_length=80)
