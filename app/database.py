from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import settings


connect_args = {}
if settings.database_url.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(settings.database_url, future=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def ensure_sqlite_sections_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(sections)"))]
        if "tables" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN tables TEXT"))
        if "tags" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN tags TEXT"))
        if "cut_order" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN cut_order INTEGER"))
        if "sidework" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN sidework TEXT"))
        if "outwork" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN outwork TEXT"))
        if "max_capacity" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN max_capacity INTEGER"))
        if "expected_out_time" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN expected_out_time VARCHAR(50)"))
        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
