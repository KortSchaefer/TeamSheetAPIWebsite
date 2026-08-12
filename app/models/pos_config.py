from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from .models import TimestampMixin


class POSPage(Base, TimestampMixin):
    __tablename__ = "pos_pages"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True, server_default=text("1"))
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)

    buttons = relationship("POSButton", back_populates="page")


class POSButton(Base, TimestampMixin):
    __tablename__ = "pos_buttons"

    id: Mapped[int] = mapped_column(primary_key=True)
    internal_key: Mapped[str] = mapped_column(String(120), nullable=False, unique=True, index=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_items.id"), nullable=False, index=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("pos_pages.id"), nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    button_type: Mapped[str] = mapped_column(String(40), default="PRODUCT", nullable=False, server_default="PRODUCT")
    alternate_price_cents: Mapped[int | None] = mapped_column(Integer)
    weight_value: Mapped[float | None] = mapped_column(Float)
    weight_unit: Mapped[str | None] = mapped_column(String(30))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True, server_default=text("1"))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    availability: Mapped[dict | None] = mapped_column(JSON)
    visual: Mapped[dict | None] = mapped_column(JSON)
    routing: Mapped[dict | None] = mapped_column(JSON)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)
    grid_row: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))
    grid_column: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))
    grid_width: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))
    grid_height: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))

    menu_item = relationship("MenuItem")
    page = relationship("POSPage", back_populates="buttons")
    tag_links = relationship("POSButtonTag", back_populates="button", cascade="all, delete-orphan")
    modifier_links = relationship("POSButtonModifierGroup", back_populates="button", cascade="all, delete-orphan")
    prompt_links = relationship("POSButtonPrompt", back_populates="button", cascade="all, delete-orphan")


class POSTag(Base, TimestampMixin):
    __tablename__ = "pos_tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(20))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True, server_default=text("1"))
    behavior: Mapped[dict | None] = mapped_column(JSON)

    button_links = relationship("POSButtonTag", back_populates="tag", cascade="all, delete-orphan")
    modifier_links = relationship("POSTagModifierGroup", back_populates="tag", cascade="all, delete-orphan")
    prompt_links = relationship("POSTagPrompt", back_populates="tag", cascade="all, delete-orphan")


class POSButtonTag(Base):
    __tablename__ = "pos_button_tags"

    id: Mapped[int] = mapped_column(primary_key=True)
    button_id: Mapped[int] = mapped_column(ForeignKey("pos_buttons.id"), nullable=False, index=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("pos_tags.id"), nullable=False, index=True)

    button = relationship("POSButton", back_populates="tag_links")
    tag = relationship("POSTag", back_populates="button_links")
    __table_args__ = (UniqueConstraint("button_id", "tag_id", name="uq_pos_button_tag"),)


class POSModifierGroup(Base, TimestampMixin):
    __tablename__ = "pos_modifier_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    prompt: Mapped[str | None] = mapped_column(String(220))
    required: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default=text("0"))
    minimum_selections: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    maximum_selections: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))
    allow_quantities: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default=text("0"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True, server_default=text("1"))
    conditional_visibility: Mapped[dict | None] = mapped_column(JSON)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)

    modifiers = relationship("POSModifier", foreign_keys="POSModifier.group_id", back_populates="group", cascade="all, delete-orphan")


class POSModifier(Base, TimestampMixin):
    __tablename__ = "pos_modifiers"

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int] = mapped_column(ForeignKey("pos_modifier_groups.id"), nullable=False, index=True)
    internal_key: Mapped[str] = mapped_column(String(120), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    price_delta_cents: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    default_selected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default=text("0"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, server_default=text("1"))
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    opens_modifier_group_id: Mapped[int | None] = mapped_column(ForeignKey("pos_modifier_groups.id"))
    conditional_visibility: Mapped[dict | None] = mapped_column(JSON)
    metadata_json: Mapped[dict | None] = mapped_column("metadata", JSON)

    group = relationship("POSModifierGroup", foreign_keys=[group_id], back_populates="modifiers")
    opens_modifier_group = relationship("POSModifierGroup", foreign_keys=[opens_modifier_group_id])
    __table_args__ = (UniqueConstraint("group_id", "internal_key", name="uq_pos_modifier_group_key"),)


class POSButtonModifierGroup(Base):
    __tablename__ = "pos_button_modifier_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    button_id: Mapped[int] = mapped_column(ForeignKey("pos_buttons.id"), nullable=False, index=True)
    modifier_group_id: Mapped[int] = mapped_column(ForeignKey("pos_modifier_groups.id"), nullable=False, index=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default=text("0"))
    override_config: Mapped[dict | None] = mapped_column(JSON)

    button = relationship("POSButton", back_populates="modifier_links")
    modifier_group = relationship("POSModifierGroup")
    __table_args__ = (UniqueConstraint("button_id", "modifier_group_id", name="uq_pos_button_modifier_group"),)


class POSTagModifierGroup(Base):
    __tablename__ = "pos_tag_modifier_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("pos_tags.id"), nullable=False, index=True)
    modifier_group_id: Mapped[int] = mapped_column(ForeignKey("pos_modifier_groups.id"), nullable=False, index=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    override_config: Mapped[dict | None] = mapped_column(JSON)

    tag = relationship("POSTag", back_populates="modifier_links")
    modifier_group = relationship("POSModifierGroup")
    __table_args__ = (UniqueConstraint("tag_id", "modifier_group_id", name="uq_pos_tag_modifier_group"),)


class POSPrompt(Base, TimestampMixin):
    __tablename__ = "pos_prompts"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(100), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    message: Mapped[str] = mapped_column(String(240), nullable=False)
    modifier_group_id: Mapped[int | None] = mapped_column(ForeignKey("pos_modifier_groups.id"), index=True)
    required: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default=text("0"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True, server_default=text("1"))
    config: Mapped[dict | None] = mapped_column(JSON)

    modifier_group = relationship("POSModifierGroup")


class POSButtonPrompt(Base):
    __tablename__ = "pos_button_prompts"

    id: Mapped[int] = mapped_column(primary_key=True)
    button_id: Mapped[int] = mapped_column(ForeignKey("pos_buttons.id"), nullable=False, index=True)
    prompt_id: Mapped[int] = mapped_column(ForeignKey("pos_prompts.id"), nullable=False, index=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, server_default=text("0"))
    override_config: Mapped[dict | None] = mapped_column(JSON)

    button = relationship("POSButton", back_populates="prompt_links")
    prompt = relationship("POSPrompt")
    __table_args__ = (UniqueConstraint("button_id", "prompt_id", name="uq_pos_button_prompt"),)


class POSTagPrompt(Base):
    __tablename__ = "pos_tag_prompts"

    id: Mapped[int] = mapped_column(primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("pos_tags.id"), nullable=False, index=True)
    prompt_id: Mapped[int] = mapped_column(ForeignKey("pos_prompts.id"), nullable=False, index=True)
    display_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    override_config: Mapped[dict | None] = mapped_column(JSON)

    tag = relationship("POSTag", back_populates="prompt_links")
    prompt = relationship("POSPrompt")
    __table_args__ = (UniqueConstraint("tag_id", "prompt_id", name="uq_pos_tag_prompt"),)


class POSBehaviorRule(Base, TimestampMixin):
    __tablename__ = "pos_behavior_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    scope_type: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    scope_id: Mapped[int | None] = mapped_column(Integer, index=True)
    condition: Mapped[dict] = mapped_column(JSON, nullable=False)
    action: Mapped[dict] = mapped_column(JSON, nullable=False)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default=text("0"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True, server_default=text("1"))


class POSConfigAudit(Base):
    __tablename__ = "pos_config_audit"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    entity_id: Mapped[int | None] = mapped_column(Integer, index=True)
    before_value: Mapped[dict | None] = mapped_column(JSON)
    after_value: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow, nullable=False, index=True, server_default=text("CURRENT_TIMESTAMP"))

    actor = relationship("User")
