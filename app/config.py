from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Team Sheet Studio API"
    # Default to SQLite for local development; override via .env for PostgreSQL
    database_url: str = "sqlite:///./team_sheet.db"
    secret_key: str = "change-me"
    access_token_expire_minutes: int = 60
    refresh_token_expire_minutes: int = 60 * 24 * 7
    algorithm: str = "HS256"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
