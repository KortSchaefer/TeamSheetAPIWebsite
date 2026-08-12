from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class POSPageUpsert(BaseModel):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    active: bool = True
    display_order: int = Field(default=0, ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class POSAssignmentInput(BaseModel):
    id: int = Field(gt=0)
    display_order: int = Field(default=0, ge=0)
    disabled: bool = False
    overrides: dict[str, Any] = Field(default_factory=dict)


class POSIngredientInput(BaseModel):
    ingredient_id: int = Field(gt=0)
    quantity: float = Field(default=1, gt=0)
    selection_type: Literal["INCLUDED", "DEFAULT", "OPTIONAL"] = "INCLUDED"
    display_order: int = Field(default=0, ge=0)


class POSButtonUpsert(BaseModel):
    internal_key: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    menu_item_id: int | None = Field(default=None, gt=0)
    name: str = Field(min_length=1, max_length=150)
    display_name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    category_id: int | None = Field(default=None, gt=0)
    page_id: int = Field(gt=0)
    price_cents: int = Field(default=0, ge=0)
    alternate_price_cents: int | None = Field(default=None, ge=0)
    weight_value: float | None = Field(default=None, gt=0)
    weight_unit: str | None = Field(default=None, max_length=30)
    button_type: str = Field(default="PRODUCT", min_length=1, max_length=40)
    active: bool = True
    availability: dict[str, Any] = Field(default_factory=dict)
    visual: dict[str, Any] = Field(default_factory=dict)
    routing: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    grid_row: int = Field(default=1, ge=1, le=100)
    grid_column: int = Field(default=1, ge=1, le=100)
    grid_width: int = Field(default=1, ge=1, le=12)
    grid_height: int = Field(default=1, ge=1, le=12)
    display_order: int = Field(default=0, ge=0)
    tag_ids: list[int] = Field(default_factory=list)
    modifier_groups: list[POSAssignmentInput] = Field(default_factory=list)
    prompts: list[POSAssignmentInput] = Field(default_factory=list)
    ingredients: list[POSIngredientInput] = Field(default_factory=list)


class POSTagUpsert(BaseModel):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=100)
    description: str | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    active: bool = True
    behavior: dict[str, Any] = Field(default_factory=dict)
    modifier_groups: list[POSAssignmentInput] = Field(default_factory=list)
    prompts: list[POSAssignmentInput] = Field(default_factory=list)


class POSModifierInput(BaseModel):
    id: int | None = Field(default=None, gt=0)
    internal_key: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=120)
    price_delta_cents: int = 0
    default_selected: bool = False
    active: bool = True
    display_order: int = Field(default=0, ge=0)
    opens_modifier_group_id: int | None = Field(default=None, gt=0)
    conditional_visibility: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class POSModifierGroupUpsert(BaseModel):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=120)
    prompt: str | None = Field(default=None, max_length=220)
    required: bool = False
    minimum_selections: int = Field(default=0, ge=0, le=50)
    maximum_selections: int = Field(default=1, ge=1, le=50)
    allow_quantities: bool = False
    active: bool = True
    conditional_visibility: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    modifiers: list[POSModifierInput] = Field(default_factory=list)

    @model_validator(mode="after")
    def selection_range(self):
        if self.minimum_selections > self.maximum_selections:
            raise ValueError("minimum_selections cannot exceed maximum_selections")
        if self.required and self.minimum_selections == 0:
            self.minimum_selections = 1
        return self


class POSPromptUpsert(BaseModel):
    slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=240)
    modifier_group_id: int | None = Field(default=None, gt=0)
    required: bool = False
    active: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class POSBehaviorRuleUpsert(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    scope_type: Literal["GLOBAL", "BUTTON", "TAG"] = "GLOBAL"
    scope_id: int | None = Field(default=None, gt=0)
    condition: dict[str, Any]
    action: dict[str, Any]
    priority: int = Field(default=0, ge=-10000, le=10000)
    active: bool = True

    @model_validator(mode="after")
    def valid_scope(self):
        if self.scope_type == "GLOBAL" and self.scope_id is not None:
            raise ValueError("GLOBAL rules cannot have scope_id")
        if self.scope_type != "GLOBAL" and self.scope_id is None:
            raise ValueError("BUTTON and TAG rules require scope_id")
        return self


class POSLayoutEntry(BaseModel):
    button_id: int = Field(gt=0)
    page_id: int = Field(gt=0)
    grid_row: int = Field(ge=1, le=100)
    grid_column: int = Field(ge=1, le=100)
    grid_width: int = Field(default=1, ge=1, le=12)
    grid_height: int = Field(default=1, ge=1, le=12)
    display_order: int = Field(default=0, ge=0)
    revision: int = Field(ge=1)


class POSLayoutUpdate(BaseModel):
    entries: list[POSLayoutEntry] = Field(min_length=1, max_length=500)


class POSTerminalModifierSelection(BaseModel):
    modifier_id: int = Field(gt=0)
    quantity: int = Field(default=1, ge=1, le=50)


class POSTerminalItemCreate(BaseModel):
    button_id: int = Field(gt=0)
    quantity: int = Field(default=1, ge=1, le=99)
    modifiers: list[POSTerminalModifierSelection] = Field(default_factory=list)
    notes: str | None = Field(default=None, max_length=500)


class POSConfigImportRequest(BaseModel):
    config: dict[str, Any]
    preview: bool = True
