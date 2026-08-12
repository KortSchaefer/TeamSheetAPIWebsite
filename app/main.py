from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import Base, engine, ensure_sqlite_catalog_columns, ensure_sqlite_count_sheet_columns, ensure_sqlite_inventory_columns, ensure_sqlite_pos_columns, ensure_sqlite_sections_columns, ensure_sqlite_store_preference_columns, ensure_sqlite_user_columns
from app.routers import agm_floor, auth, employees, imports, sections, shifts, team_sheets, cobrands, gift_tracker, payouts, seasons, store_preferences, pos, pos_configuration, inventory, ingredient_catalog, daily_rosters, teamsheet_presets, pyos, voice_inventory

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"

def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if PUBLIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=PUBLIC_DIR), name="static")

        @app.get("/", include_in_schema=False)
        def serve_index():
            return FileResponse(PUBLIC_DIR / "index.html")

    app.include_router(auth.router)
    app.include_router(agm_floor.router)
    app.include_router(employees.router)
    app.include_router(sections.router)
    app.include_router(shifts.router)
    app.include_router(team_sheets.router)
    app.include_router(cobrands.router)
    app.include_router(gift_tracker.router)
    app.include_router(payouts.router)
    app.include_router(seasons.router)
    app.include_router(imports.router)
    app.include_router(store_preferences.router)
    app.include_router(pos.router)
    app.include_router(pos_configuration.router)
    app.include_router(inventory.router)
    app.include_router(voice_inventory.router)
    app.include_router(ingredient_catalog.router)
    app.include_router(daily_rosters.router)
    app.include_router(teamsheet_presets.router)
    app.include_router(pyos.router)

    @app.get("/health")
    def health():
        return {"status": "ok", "app": settings.app_name}

    return app


Base.metadata.create_all(bind=engine)
ensure_sqlite_sections_columns()
ensure_sqlite_user_columns()
ensure_sqlite_store_preference_columns()
ensure_sqlite_inventory_columns()
ensure_sqlite_catalog_columns()
ensure_sqlite_count_sheet_columns()
ensure_sqlite_pos_columns()
app = create_app()
