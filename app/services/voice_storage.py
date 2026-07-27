import base64
import hashlib
import hmac
import re
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from app.config import settings


UPLOAD_TTL_SECONDS = 15 * 60
MAX_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024


def _safe_extension(filename: str, content_type: str) -> str:
    extension = Path(filename).suffix.lower().lstrip(".")
    if not re.fullmatch(r"[a-z0-9]{1,8}", extension or ""):
        extension = {
            "audio/webm": "webm",
            "audio/mp4": "m4a",
            "audio/ogg": "ogg",
            "audio/wav": "wav",
        }.get(content_type, "bin")
    return extension


def _signature(object_key: str, expires: int) -> str:
    message = f"{object_key}:{expires}".encode()
    digest = hmac.new(settings.secret_key.encode(), message, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def verify_local_upload(object_key: str, expires: int, signature: str) -> bool:
    return expires >= int(time.time()) and hmac.compare_digest(
        _signature(object_key, expires), signature
    )


def create_upload_target(
    session_id: int, filename: str, content_type: str
) -> dict:
    upload_id = str(uuid.uuid4())
    extension = _safe_extension(filename, content_type)
    object_key = f"sessions/{session_id}/{upload_id}.{extension}"
    expires = int(time.time()) + UPLOAD_TTL_SECONDS
    expires_at = datetime.utcnow() + timedelta(seconds=UPLOAD_TTL_SECONDS)

    if settings.voice_storage_backend.casefold() == "s3":
        if not settings.voice_storage_bucket:
            raise RuntimeError("VOICE_STORAGE_BUCKET is required for S3 voice storage")
        try:
            import boto3
        except ImportError as exc:
            raise RuntimeError("boto3 is required for S3 voice storage") from exc
        client = boto3.client(
            "s3",
            endpoint_url=settings.voice_storage_endpoint,
            region_name=settings.voice_storage_region,
            aws_access_key_id=settings.voice_storage_access_key,
            aws_secret_access_key=settings.voice_storage_secret_key,
        )
        upload_url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.voice_storage_bucket,
                "Key": object_key,
                "ContentType": content_type,
            },
            ExpiresIn=UPLOAD_TTL_SECONDS,
        )
        return {
            "object_key": object_key,
            "upload_url": upload_url,
            "method": "PUT",
            "expires_at": expires_at,
            "headers": {"Content-Type": content_type},
        }

    signature = _signature(object_key, expires)
    upload_url = (
        f"/inventory/voice/sessions/{session_id}/audio/{upload_id}"
        f"?extension={extension}&expires={expires}&signature={signature}"
    )
    return {
        "object_key": object_key,
        "upload_url": upload_url,
        "method": "PUT",
        "expires_at": expires_at,
        "headers": {"Content-Type": content_type},
    }


def put_local_audio(object_key: str, content: bytes) -> None:
    if len(content) > MAX_AUDIO_CHUNK_BYTES:
        raise ValueError("Audio chunk exceeds the 8 MB limit")
    root = Path(settings.voice_storage_local_path).resolve()
    target = (root / object_key).resolve()
    if root != target and root not in target.parents:
        raise ValueError("Invalid audio object key")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)


def delete_audio_object(object_key: str) -> None:
    if settings.voice_storage_backend.casefold() == "s3":
        if not settings.voice_storage_bucket:
            return
        import boto3

        client = boto3.client(
            "s3",
            endpoint_url=settings.voice_storage_endpoint,
            region_name=settings.voice_storage_region,
            aws_access_key_id=settings.voice_storage_access_key,
            aws_secret_access_key=settings.voice_storage_secret_key,
        )
        client.delete_object(Bucket=settings.voice_storage_bucket, Key=object_key)
        return

    root = Path(settings.voice_storage_local_path).resolve()
    target = (root / object_key).resolve()
    if root != target and root not in target.parents:
        return
    if target.is_file():
        target.unlink()
