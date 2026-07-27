import hashlib
import re
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.core.security import get_current_manager_or_admin
from app.database import get_db
from app.models import (
    InventoryVoiceEntry,
    InventoryVoiceReviewStatus,
    InventoryVoiceSession,
    InventoryVoiceSessionStatus,
    InventoryVoiceUtterance,
    User,
)
from app.schemas.voice_inventory import (
    VoiceAudioUploadRequest,
    VoiceAudioUploadTarget,
    VoiceClarificationCreate,
    VoiceEntryPatch,
    VoiceEntryRead,
    VoiceRealtimeTokenRead,
    VoiceSessionCreate,
    VoiceSessionRead,
    VoiceStateChange,
    VoiceUtteranceCreate,
    VoiceUtteranceRead,
)
from app.services.voice_inventory import (
    cleanup_expired_audio,
    correct_entry,
    create_or_resume_session,
    finish_session,
    get_session_for_user,
    ingest_utterance,
    serialize_entry,
    serialize_session,
    serialize_utterance,
)
from app.services.voice_inventory_exports import csv_bytes, print_html, xlsx_bytes
from app.services.voice_storage import (
    create_upload_target,
    put_local_audio,
    verify_local_upload,
)


router = APIRouter(prefix="/inventory/voice", tags=["voice inventory"])


def _feature_enabled() -> None:
    if not settings.voice_inventory_enabled:
        raise HTTPException(status_code=404, detail="Voice inventory is disabled")


def _safe_filename(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-") or "voice-inventory"


@router.post(
    "/sessions",
    response_model=VoiceSessionRead,
    status_code=status.HTTP_201_CREATED,
)
def start_session(
    payload: VoiceSessionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    cleanup_expired_audio(db)
    session = create_or_resume_session(
        db,
        current_user,
        payload.client_session_id,
        payload.initial_location_id,
        payload.device_metadata,
    )
    return serialize_session(db, session)


@router.get("/sessions/active", response_model=VoiceSessionRead | None)
def active_session(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    session = (
        db.query(InventoryVoiceSession)
        .filter(
            InventoryVoiceSession.manager_user_id == current_user.id,
            InventoryVoiceSession.status.in_(
                {
                    InventoryVoiceSessionStatus.CREATED,
                    InventoryVoiceSessionStatus.LISTENING,
                    InventoryVoiceSessionStatus.PAUSED,
                    InventoryVoiceSessionStatus.OFFLINE,
                    InventoryVoiceSessionStatus.NEEDS_REVIEW,
                }
            ),
        )
        .order_by(InventoryVoiceSession.created_at.desc())
        .first()
    )
    return serialize_session(db, session) if session else None


@router.get("/sessions/{session_id}", response_model=VoiceSessionRead)
def read_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    return serialize_session(
        db, get_session_for_user(db, session_id, current_user)
    )


@router.post(
    "/sessions/{session_id}/realtime-token",
    response_model=VoiceRealtimeTokenRead,
)
def realtime_token(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    session = get_session_for_user(db, session_id, current_user)
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "OPENAI_NOT_CONFIGURED",
                "message": "Realtime transcription is unavailable; use browser fallback.",
            },
        )
    safety_id = hashlib.sha256(
        f"inventory-manager:{current_user.id}".encode()
    ).hexdigest()
    payload = {
        "expires_after": {"anchor": "created_at", "seconds": 600},
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "transcription": {
                        "model": settings.openai_transcription_model,
                        "language": "en",
                        "delay": settings.openai_realtime_delay,
                    }
                }
            },
        },
    }
    try:
        response = httpx.post(
            "https://api.openai.com/v1/realtime/client_secrets",
            headers={
                "Authorization": f"Bearer {settings.openai_api_key}",
                "Content-Type": "application/json",
                "OpenAI-Safety-Identifier": safety_id,
            },
            json=payload,
            timeout=20,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        session.error_message = f"Realtime token request failed ({exc.response.status_code})"
        db.commit()
        raise HTTPException(
            status_code=502, detail="OpenAI rejected the realtime session request"
        ) from exc
    except httpx.HTTPError as exc:
        session.error_message = "Realtime token request could not reach OpenAI"
        db.commit()
        raise HTTPException(
            status_code=502, detail="Realtime transcription is temporarily unavailable"
        ) from exc
    session.status = InventoryVoiceSessionStatus.LISTENING
    db.commit()
    return response.json()


@router.post(
    "/sessions/{session_id}/audio-upload",
    response_model=VoiceAudioUploadTarget,
)
def audio_upload_target(
    session_id: int,
    payload: VoiceAudioUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    get_session_for_user(db, session_id, current_user)
    try:
        return create_upload_target(
            session_id, payload.filename, payload.content_type
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/sessions/{session_id}/audio/{upload_id}", status_code=204)
async def upload_local_audio(
    session_id: int,
    upload_id: str,
    request: Request,
    extension: str = Query(pattern=r"^[a-z0-9]{1,8}$"),
    expires: int = Query(),
    signature: str = Query(min_length=20, max_length=100),
):
    if settings.voice_storage_backend.casefold() != "local":
        raise HTTPException(status_code=404, detail="Local audio upload is disabled")
    object_key = f"sessions/{session_id}/{upload_id}.{extension}"
    if not verify_local_upload(object_key, expires, signature):
        raise HTTPException(status_code=403, detail="Audio upload target expired or invalid")
    try:
        put_local_audio(object_key, await request.body())
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    return Response(status_code=204)


@router.post(
    "/sessions/{session_id}/utterances",
    response_model=VoiceUtteranceRead,
    status_code=status.HTTP_201_CREATED,
)
def create_utterance(
    session_id: int,
    payload: VoiceUtteranceCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    session = get_session_for_user(db, session_id, current_user)
    utterance = ingest_utterance(
        db,
        session,
        client_event_id=payload.client_event_id,
        sequence=payload.sequence,
        transcript=payload.transcript,
        realtime_item_id=payload.realtime_item_id,
        started_at=payload.started_at,
        ended_at=payload.ended_at,
        audio_object_key=payload.audio_object_key,
    )
    return serialize_utterance(utterance)


@router.patch(
    "/sessions/{session_id}/entries/{entry_id}",
    response_model=VoiceEntryRead,
)
def patch_entry(
    session_id: int,
    entry_id: int,
    payload: VoiceEntryPatch,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    session = get_session_for_user(db, session_id, current_user)
    entry = (
        db.query(InventoryVoiceEntry)
        .filter(
            InventoryVoiceEntry.id == entry_id,
            InventoryVoiceEntry.session_id == session.id,
        )
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Voice inventory entry not found")
    corrected = correct_entry(
        db,
        session,
        entry,
        inventory_item_id=payload.inventory_item_id,
        location_id=payload.location_id,
        quantity=payload.quantity,
        unit=payload.unit,
        review_status=payload.review_status,
    )
    if (
        session.finished_at
        and not serialize_session(db, session)["blocking_review_count"]
    ):
        session.status = InventoryVoiceSessionStatus.FINISHED
        db.commit()
    return serialize_entry(corrected)


@router.post(
    "/sessions/{session_id}/clarifications",
    response_model=VoiceEntryRead,
)
def resolve_clarification(
    session_id: int,
    payload: VoiceClarificationCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    _feature_enabled()
    session = get_session_for_user(db, session_id, current_user)
    utterance = (
        db.query(InventoryVoiceUtterance)
        .filter(
            InventoryVoiceUtterance.id == payload.utterance_id,
            InventoryVoiceUtterance.session_id == session.id,
        )
        .first()
    )
    if not utterance:
        raise HTTPException(status_code=404, detail="Voice utterance not found")
    unresolved = next(
        (
            entry
            for entry in utterance.entries
            if entry.review_status == InventoryVoiceReviewStatus.NEEDS_REVIEW
        ),
        None,
    )
    if not unresolved:
        raise HTTPException(status_code=409, detail="This utterance is already resolved")
    corrected = correct_entry(
        db,
        session,
        unresolved,
        inventory_item_id=payload.selected_inventory_item_id,
        location_id=payload.selected_location_id,
        quantity=payload.quantity,
        unit=payload.unit,
        review_status=(
            InventoryVoiceReviewStatus.REJECTED if payload.reject else None
        ),
    )
    return serialize_entry(corrected)


def _change_state(
    db: Session,
    session: InventoryVoiceSession,
    state: InventoryVoiceSessionStatus,
) -> dict:
    session.status = state
    db.commit()
    return {"status": session.status}


@router.post("/sessions/{session_id}/pause", response_model=VoiceStateChange)
def pause_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    return _change_state(
        db,
        get_session_for_user(db, session_id, current_user),
        InventoryVoiceSessionStatus.PAUSED,
    )


@router.post("/sessions/{session_id}/resume", response_model=VoiceStateChange)
def resume_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    session = get_session_for_user(db, session_id, current_user)
    if session.status in {
        InventoryVoiceSessionStatus.FINISHED,
        InventoryVoiceSessionStatus.ABANDONED,
    }:
        raise HTTPException(status_code=409, detail="This voice session is closed")
    return _change_state(db, session, InventoryVoiceSessionStatus.LISTENING)


@router.post("/sessions/{session_id}/offline", response_model=VoiceStateChange)
def mark_offline(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    return _change_state(
        db,
        get_session_for_user(db, session_id, current_user),
        InventoryVoiceSessionStatus.OFFLINE,
    )


@router.post("/sessions/{session_id}/finish", response_model=VoiceSessionRead)
def finish(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    session = get_session_for_user(db, session_id, current_user)
    finish_session(db, session)
    return serialize_session(db, session)


@router.post("/sessions/{session_id}/abandon", response_model=VoiceStateChange)
def abandon(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    session = get_session_for_user(db, session_id, current_user)
    if any(link.inventory_count.status.value != "DRAFT" for link in session.count_links):
        raise HTTPException(
            status_code=409, detail="A session with submitted counts cannot be abandoned"
        )
    session.status = InventoryVoiceSessionStatus.ABANDONED
    session.finished_at = datetime.utcnow()
    db.commit()
    return {"status": session.status}


@router.get("/sessions/{session_id}/export.csv")
def export_csv(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    session = get_session_for_user(db, session_id, current_user)
    filename = _safe_filename(f"voice-inventory-{session.id}.csv")
    return StreamingResponse(
        iter([csv_bytes(db, session)]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/sessions/{session_id}/export.xlsx")
def export_xlsx(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    session = get_session_for_user(db, session_id, current_user)
    filename = _safe_filename(f"voice-inventory-{session.id}.xlsx")
    return StreamingResponse(
        iter([xlsx_bytes(db, session)]),
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/sessions/{session_id}/print", response_class=HTMLResponse)
def printable(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    return print_html(db, get_session_for_user(db, session_id, current_user))


@router.post("/maintenance/cleanup-audio")
def cleanup_audio(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    return {"removed_audio_objects": cleanup_expired_audio(db)}
