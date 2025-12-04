from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import Base, engine
from app.routers import auth, employees, imports, sections, shifts, team_sheets

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
    app.include_router(employees.router)
    app.include_router(sections.router)
    app.include_router(shifts.router)
    app.include_router(team_sheets.router)
    app.include_router(imports.router)

    @app.get("/health")
    def health():
        return {"status": "ok", "app": settings.app_name}

    return app


Base.metadata.create_all(bind=engine)
app = create_app()
