from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class AGMTimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )


class AGMStore(Base, AGMTimestampMixin):
    __tablename__ = "agm_stores"

    id: Mapped[int] = mapped_column(primary_key=True)
    store_number: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    timezone: Mapped[str] = mapped_column(String(80), default="America/Chicago", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class AGMStoreMembership(Base, AGMTimestampMixin):
    __tablename__ = "agm_store_memberships"
    __table_args__ = (UniqueConstraint("store_id", "user_id", name="uq_agm_store_membership"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("agm_stores.id"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    access_role: Mapped[str] = mapped_column(String(20), default="AGM", nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class AGMLayout(Base, AGMTimestampMixin):
    __tablename__ = "agm_layouts"
    __table_args__ = (UniqueConstraint("store_id", "name", "version", name="uq_agm_layout_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("agm_stores.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="DRAFT", nullable=False, index=True)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    canvas_width: Mapped[int] = mapped_column(Integer, default=1200, nullable=False)
    canvas_height: Mapped[int] = mapped_column(Integer, default=760, nullable=False)
    areas: Mapped[list | None] = mapped_column(JSON, nullable=True)
    fixtures: Mapped[list | None] = mapped_column(JSON, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)


class AGMTableDefinition(Base, AGMTimestampMixin):
    __tablename__ = "agm_table_definitions"
    __table_args__ = (UniqueConstraint("layout_id", "table_number", name="uq_agm_layout_table_number"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    layout_id: Mapped[int] = mapped_column(ForeignKey("agm_layouts.id"), nullable=False, index=True)
    table_number: Mapped[str] = mapped_column(String(20), nullable=False)
    label: Mapped[str] = mapped_column(String(60), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False)
    shape: Mapped[str] = mapped_column(String(20), default="ROUND", nullable=False)
    x: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    y: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    width: Mapped[int] = mapped_column(Integer, default=88, nullable=False)
    height: Mapped[int] = mapped_column(Integer, default=88, nullable=False)
    rotation: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    area_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    section_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    combinable_with: Mapped[list | None] = mapped_column(JSON, nullable=True)


class AGMService(Base, AGMTimestampMixin):
    __tablename__ = "agm_services"
    __table_args__ = (UniqueConstraint("store_id", "service_date", "name", name="uq_agm_store_service"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("agm_stores.id"), nullable=False, index=True)
    layout_id: Mapped[int] = mapped_column(ForeignKey("agm_layouts.id"), nullable=False)
    service_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(60), default="Dinner", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="OPEN", nullable=False, index=True)
    starts_at: Mapped[str | None] = mapped_column(String(10), nullable=True)
    ends_at: Mapped[str | None] = mapped_column(String(10), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    opened_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AGMParty(Base, AGMTimestampMixin):
    __tablename__ = "agm_parties"

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("agm_stores.id"), nullable=False, index=True)
    service_id: Mapped[int | None] = mapped_column(ForeignKey("agm_services.id"), nullable=True, index=True)
    source: Mapped[str] = mapped_column(String(20), default="WALK_IN", nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(24), default="WAITING", nullable=False, index=True)
    guest_name: Mapped[str] = mapped_column(String(120), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    party_size: Mapped[int] = mapped_column(Integer, nullable=False)
    reservation_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    quoted_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    sms_consent: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    table_numbers: Mapped[list | None] = mapped_column(JSON, nullable=True)
    server_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    dining_stage: Mapped[str | None] = mapped_column(String(30), nullable=True)
    seated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)


class AGMTableState(Base, AGMTimestampMixin):
    __tablename__ = "agm_table_states"
    __table_args__ = (UniqueConstraint("service_id", "table_number", name="uq_agm_service_table_state"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("agm_services.id"), nullable=False, index=True)
    table_number: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="AVAILABLE", nullable=False, index=True)
    party_id: Mapped[int | None] = mapped_column(ForeignKey("agm_parties.id"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class AGMServerRotation(Base, AGMTimestampMixin):
    __tablename__ = "agm_server_rotations"
    __table_args__ = (UniqueConstraint("service_id", "employee_id", name="uq_agm_service_server"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("agm_services.id"), nullable=False, index=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), nullable=False)
    section_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    turns: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    covers: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_sat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rotation_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)


class AGMEvent(Base):
    __tablename__ = "agm_events"
    __table_args__ = (UniqueConstraint("service_id", "command_id", name="uq_agm_service_command"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("agm_services.id"), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    command_id: Mapped[str] = mapped_column(String(64), nullable=False)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False)


class AGMSmsOutbox(Base, AGMTimestampMixin):
    __tablename__ = "agm_sms_outbox"

    id: Mapped[int] = mapped_column(primary_key=True)
    store_id: Mapped[int] = mapped_column(ForeignKey("agm_stores.id"), nullable=False, index=True)
    party_id: Mapped[int] = mapped_column(ForeignKey("agm_parties.id"), nullable=False, index=True)
    template_key: Mapped[str] = mapped_column(String(40), nullable=False)
    recipient_phone: Mapped[str] = mapped_column(String(32), nullable=False)
    body: Mapped[str] = mapped_column(String(480), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="PROVIDER_UNCONFIGURED", nullable=False)
    provider_message_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(String(255), nullable=True)
