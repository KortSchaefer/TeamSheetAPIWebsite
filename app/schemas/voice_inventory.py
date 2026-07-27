from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models import (
    InventoryVoiceEntryAction,
    InventoryVoiceReviewStatus,
    InventoryVoiceSessionStatus,
    InventoryVoiceUtteranceStatus,
)


class VoiceSessionCreate(BaseModel):
    client_session_id: str = Field(min_length=8, max_length=36)
    initial_location_id: int
    device_metadata: dict[str, Any] | None = None


class VoiceAudioUploadRequest(BaseModel):
    content_type: str = Field(default="audio/webm", max_length=100)
    filename: str = Field(default="chunk.webm", max_length=150)


class VoiceAudioUploadTarget(BaseModel):
    object_key: str
    upload_url: str
    method: str = "PUT"
    expires_at: datetime
    headers: dict[str, str] = Field(default_factory=dict)


class VoiceUtteranceCreate(BaseModel):
    client_event_id: str = Field(min_length=8, max_length=36)
    sequence: int = Field(ge=1)
    transcript: str = Field(min_length=1, max_length=4000)
    realtime_item_id: str | None = Field(default=None, max_length=100)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    audio_object_key: str | None = Field(default=None, max_length=500)


class VoiceEntryPatch(BaseModel):
    inventory_item_id: int | None = None
    location_id: int | None = None
    quantity: Decimal | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=50)
    review_status: InventoryVoiceReviewStatus | None = None


class VoiceClarificationCreate(BaseModel):
    utterance_id: int
    selected_inventory_item_id: int | None = None
    selected_location_id: int | None = None
    quantity: Decimal | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=50)
    reject: bool = False


class VoiceEntryRead(BaseModel):
    id: int
    utterance_id: int
    location_id: int
    location_name: str
    inventory_item_id: int | None
    item_name: str | None
    action: InventoryVoiceEntryAction
    spoken_item: str | None
    spoken_quantity: Decimal | None
    spoken_unit: str | None
    normalized_quantity: Decimal | None
    base_unit: str | None
    evidence: str
    ambiguity_reason: str | None
    review_status: InventoryVoiceReviewStatus
    supersedes_entry_id: int | None
    created_at: datetime


class VoiceFeedback(BaseModel):
    tone: str | None = None
    speak: str | None = None
    clarification_needed: bool = False
    options: list[dict[str, Any]] = Field(default_factory=list)


class VoiceUtteranceRead(BaseModel):
    id: int
    client_event_id: str
    sequence: int
    transcript: str
    status: InventoryVoiceUtteranceStatus
    normalized_payload: dict[str, Any] | None
    entries: list[VoiceEntryRead] = Field(default_factory=list)
    feedback: VoiceFeedback = Field(default_factory=VoiceFeedback)
    created_at: datetime


class VoiceEffectiveCountRead(BaseModel):
    location_id: int
    location_name: str
    inventory_item_id: int
    item_name: str
    quantity: Decimal
    base_unit: str
    source_entry_ids: list[int] = Field(default_factory=list)


class VoiceDraftCountRead(BaseModel):
    location_id: int
    location_name: str
    inventory_count_id: int
    status: str


class VoiceSessionRead(BaseModel):
    id: int
    client_session_id: str
    manager_user_id: int
    status: InventoryVoiceSessionStatus
    current_location_id: int
    current_location_name: str
    started_at: datetime
    finished_at: datetime | None
    last_client_sequence: int
    transcription_model: str
    normalization_model: str
    prompt_version: str
    blocking_review_count: int
    entries: list[VoiceEntryRead] = Field(default_factory=list)
    effective_counts: list[VoiceEffectiveCountRead] = Field(default_factory=list)
    draft_counts: list[VoiceDraftCountRead] = Field(default_factory=list)
    model_config = ConfigDict(from_attributes=True)


class VoiceRealtimeTokenRead(BaseModel):
    value: str
    expires_at: int
    session: dict[str, Any]


class VoiceStateChange(BaseModel):
    status: InventoryVoiceSessionStatus
