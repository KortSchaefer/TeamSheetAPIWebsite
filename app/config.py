from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Team Sheet Studio API"
    # Default to SQLite for local development; override via .env for PostgreSQL
    database_url: str = "sqlite:///./team_sheet.db"
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60
    refresh_token_expire_minutes: int = 60 * 24 * 7
    pos_idle_timeout_seconds: int = 45
    pos_session_expire_hours: int = 12
    pos_login_max_attempts: int = 5
    pos_login_lock_minutes: int = 5
    algorithm: str = "HS256"
    openai_api_key: str | None = None
    openai_transcription_model: str = "gpt-realtime-whisper"
    openai_normalization_model: str = "gpt-5.6-luna"
    openai_realtime_delay: str = "medium"
    voice_inventory_enabled: bool = True
    voice_prompt_version: str = "voice-inventory-v1"
    voice_audio_retention_hours: int = 24
    voice_storage_backend: str = "local"
    voice_storage_local_path: str = "./voice_audio"
    voice_storage_bucket: str | None = None
    voice_storage_endpoint: str | None = None
    voice_storage_region: str | None = None
    voice_storage_access_key: str | None = None
    voice_storage_secret_key: str | None = None

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
