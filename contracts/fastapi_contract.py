from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import httpx
from fastapi import FastAPI
from fastapi.routing import APIRoute
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.routing import Mount, Route

from app.core.security import create_access_token
from app.database import Base, get_db
from app.main import create_app
from app.models import User, UserRole


CONTRACT_ROOT = Path(__file__).resolve().parent / "fastapi"
OPENAPI_PATH = CONTRACT_ROOT / "openapi.json"
ROUTES_PATH = CONTRACT_ROOT / "routes.json"
ROUTES_MARKDOWN_PATH = CONTRACT_ROOT / "routes.md"
FIXTURES_PATH = CONTRACT_ROOT / "fixtures"
FIXTURE_MANIFEST_PATH = FIXTURES_PATH / "manifest.json"

_DATETIME_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$"
)


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _dependency_names(route: APIRoute) -> set[str]:
    names: set[str] = set()

    def visit(dependant: Any) -> None:
        for dependency in dependant.dependencies:
            call = dependency.call
            name = getattr(call, "__name__", call.__class__.__name__)
            names.add(name)
            visit(dependency)

    visit(route.dependant)
    return names


def _authentication(route: APIRoute) -> dict[str, Any]:
    dependencies = _dependency_names(route)
    if "get_current_manager_or_admin" in dependencies:
        return {
            "mode": "manager_or_admin",
            "credentials": ["authorization_bearer", "tss_access_token_cookie"],
            "roles": ["ADMIN", "MANAGER"],
            "unauthenticated_status": 401,
            "unauthorized_status": 403,
        }
    if "get_current_user" in dependencies:
        return {
            "mode": "authenticated_user",
            "credentials": ["authorization_bearer", "tss_access_token_cookie"],
            "roles": ["ADMIN", "MANAGER", "SERVER"],
            "unauthenticated_status": 401,
        }
    if "get_current_pos_principal" in dependencies:
        return {
            "mode": "pos_session",
            "credentials": ["tss_pos_session_cookie"],
            "roles": ["MANAGER", "SERVER"],
            "unauthenticated_status": 401,
        }
    if route.name == "upload_local_audio":
        return {
            "mode": "signed_upload",
            "credentials": ["expires_query", "signature_query"],
            "unauthenticated_status": 403,
        }
    if route.name == "pos_pin_logout":
        return {
            "mode": "optional_pos_session",
            "credentials": ["tss_pos_session_cookie"],
        }
    return {"mode": "public", "credentials": []}


def _schema_references(value: Any) -> list[str]:
    references: set[str] = set()

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            reference = item.get("$ref")
            if isinstance(reference, str):
                references.add(reference.rsplit("/", 1)[-1])
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)

    visit(value)
    return sorted(references)


def _operation_for(
    openapi: dict[str, Any], path: str, method: str
) -> dict[str, Any] | None:
    return openapi.get("paths", {}).get(path, {}).get(method.lower())


def build_route_inventory(app: FastAPI) -> dict[str, Any]:
    openapi = app.openapi()
    operations: list[dict[str, Any]] = []
    infrastructure: list[dict[str, Any]] = []

    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in sorted(route.methods or []):
                operation = _operation_for(openapi, route.path, method)
                request_contract = (
                    {
                        "parameters": operation.get("parameters", []),
                        "body": operation.get("requestBody"),
                        "schema_refs": _schema_references(
                            {
                                "parameters": operation.get("parameters", []),
                                "body": operation.get("requestBody"),
                            }
                        ),
                    }
                    if operation
                    else {"parameters": [], "body": None, "schema_refs": []}
                )
                responses = operation.get("responses", {}) if operation else {}
                operations.append(
                    {
                        "method": method,
                        "path": route.path,
                        "name": route.name,
                        "tags": list(route.tags or []),
                        "included_in_openapi": bool(route.include_in_schema),
                        "success_status": route.status_code or 200,
                        "authentication": _authentication(route),
                        "request": request_contract,
                        "responses": responses,
                        "response_schema_refs": _schema_references(responses),
                    }
                )
            continue

        if isinstance(route, Mount):
            infrastructure.append(
                {
                    "kind": "mount",
                    "path": route.path,
                    "name": route.name,
                    "methods": ["MOUNT"],
                }
            )
            continue

        if isinstance(route, Route):
            infrastructure.append(
                {
                    "kind": "framework_route",
                    "path": route.path,
                    "name": route.name,
                    "methods": sorted(route.methods or []),
                }
            )

    operations.sort(key=lambda item: (item["path"], item["method"], item["name"]))
    infrastructure.sort(key=lambda item: (item["path"], item["name"] or ""))
    auth_counts = Counter(item["authentication"]["mode"] for item in operations)
    return {
        "format_version": 1,
        "application": app.title,
        "openapi_version": openapi.get("openapi"),
        "operation_count": len(operations),
        "infrastructure_route_count": len(infrastructure),
        "authentication_counts": dict(sorted(auth_counts.items())),
        "operations": operations,
        "infrastructure_routes": infrastructure,
    }


def render_route_inventory_markdown(inventory: dict[str, Any]) -> str:
    lines = [
        "# FastAPI route inventory",
        "",
        "This file is generated by `scripts/export_api_contract.py`. It records the",
        "reference FastAPI surface before endpoints are ported to Cloudflare Workers.",
        "",
        f"- API operations: {inventory['operation_count']}",
        f"- Framework/static routes: {inventory['infrastructure_route_count']}",
        "",
        "Authentication modes: `public`, `authenticated_user` (Bearer token or",
        "`tss_access_token` cookie), `manager_or_admin`, `pos_session`",
        "(`tss_pos_session` cookie), `optional_pos_session`, and `signed_upload`.",
        "",
        "| Method | Path | Success | Authentication | Request schemas | Response schemas |",
        "| --- | --- | ---: | --- | --- | --- |",
    ]
    for operation in inventory["operations"]:
        request_refs = ", ".join(operation["request"]["schema_refs"]) or "—"
        response_refs = ", ".join(operation["response_schema_refs"]) or "inline/untyped"
        lines.append(
            "| {method} | `{path}` | {status} | {auth} | {request} | {response} |".format(
                method=operation["method"],
                path=operation["path"].replace("|", "\\|"),
                status=operation["success_status"],
                auth=operation["authentication"]["mode"],
                request=request_refs,
                response=response_refs,
            )
        )
    lines.extend(["", "## Framework and static routes", ""])
    for route in inventory["infrastructure_routes"]:
        lines.append(
            f"- `{', '.join(route['methods'])} {route['path']}` — {route['kind']} "
            f"(`{route['name']}`)"
        )
    return "\n".join(lines) + "\n"


def _normalize_body(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _normalize_body(child) for key, child in sorted(value.items())}
    if isinstance(value, list):
        return [_normalize_body(child) for child in value]
    if isinstance(value, str) and _DATETIME_PATTERN.match(value):
        return "<datetime>"
    return value


def _response_headers(response: httpx.Response) -> dict[str, str]:
    headers: dict[str, str] = {}
    for name in ("allow", "content-type", "www-authenticate"):
        if name not in response.headers:
            continue
        value = response.headers[name]
        if name == "content-type":
            value = value.split(";", 1)[0].strip().lower()
        headers[name] = value
    return headers


def normalize_response(response: httpx.Response) -> dict[str, Any]:
    body: Any = None
    if response.content:
        if response.headers.get("content-type", "").startswith("application/json"):
            body = _normalize_body(response.json())
        else:
            body = response.text
    return {
        "status": response.status_code,
        "headers": _response_headers(response),
        "body": body,
    }


async def capture_representative_fixtures() -> list[dict[str, Any]]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session = sessionmaker(
        bind=engine, autoflush=False, autocommit=False, future=True
    )
    Base.metadata.create_all(bind=engine)

    def override_database():
        session = testing_session()
        try:
            yield session
        finally:
            session.close()

    with testing_session() as session:
        manager = User(
            id=1001,
            email="manager.contract@example.com",
            password_hash="contract-fixture-not-for-login",
            full_name="Contract Manager",
            role=UserRole.MANAGER,
            created_at=datetime(2024, 1, 2, 3, 4, 5),
            updated_at=datetime(2024, 1, 2, 3, 4, 5),
        )
        server = User(
            id=1002,
            email="server.contract@example.com",
            password_hash="contract-fixture-not-for-login",
            full_name="Contract Server",
            role=UserRole.SERVER,
            created_at=datetime(2024, 1, 2, 3, 4, 5),
            updated_at=datetime(2024, 1, 2, 3, 4, 5),
        )
        session.add_all([manager, server])
        session.commit()

    manager_headers = {"Authorization": f"Bearer {create_access_token(1001)}"}
    server_headers = {"Authorization": f"Bearer {create_access_token(1002)}"}
    app = create_app()
    app.dependency_overrides[get_db] = override_database

    scenarios = [
        {
            "id": "health_success",
            "description": "Public health check succeeds.",
            "request": {"method": "GET", "path": "/health", "auth": "public"},
        },
        {
            "id": "auth_me_success",
            "description": "A valid application token resolves the current user.",
            "request": {"method": "GET", "path": "/auth/me", "auth": "manager"},
        },
        {
            "id": "inventory_location_create_success",
            "description": "A manager can create an inventory location.",
            "request": {
                "method": "POST",
                "path": "/inventory/locations",
                "auth": "manager",
                "json": {
                    "name": "Contract Walk-In",
                    "description": "Fixture location",
                    "active": True,
                },
            },
        },
        {
            "id": "inventory_locations_success",
            "description": "An authenticated user can list active inventory locations.",
            "request": {
                "method": "GET",
                "path": "/inventory/locations",
                "auth": "manager",
            },
        },
        {
            "id": "authentication_required_error",
            "description": "A protected route rejects a missing application token.",
            "request": {
                "method": "GET",
                "path": "/inventory/locations",
                "auth": "public",
            },
        },
        {
            "id": "manager_role_required_error",
            "description": "A server cannot call a manager-only route.",
            "request": {
                "method": "POST",
                "path": "/inventory/locations",
                "auth": "server",
                "json": {"name": "Forbidden Location", "active": True},
            },
        },
        {
            "id": "request_validation_error",
            "description": "Invalid request data uses FastAPI's 422 error envelope.",
            "request": {
                "method": "POST",
                "path": "/inventory/locations",
                "auth": "manager",
                "json": {"name": "", "active": True},
            },
        },
        {
            "id": "resource_not_found_error",
            "description": "A missing employee returns the endpoint-specific 404 detail.",
            "request": {
                "method": "GET",
                "path": "/employees/999999",
                "auth": "manager",
            },
        },
        {
            "id": "invalid_login_error",
            "description": "Invalid JSON login credentials return the authentication error.",
            "request": {
                "method": "POST",
                "path": "/auth/login",
                "auth": "public",
                "json": {
                    "email": "missing.contract@example.com",
                    "password": "<invalid-fixture-value>",
                },
            },
        },
        {
            "id": "method_not_allowed_error",
            "description": "An unsupported method returns FastAPI's 405 envelope.",
            "request": {"method": "POST", "path": "/health", "auth": "public"},
        },
        {
            "id": "unknown_route_error",
            "description": "An unknown API path returns FastAPI's default 404 envelope.",
            "request": {
                "method": "GET",
                "path": "/contract-route-that-does-not-exist",
                "auth": "public",
            },
        },
    ]

    headers_by_auth = {
        "public": {},
        "manager": manager_headers,
        "server": server_headers,
    }
    captured: list[dict[str, Any]] = []
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://fastapi.contract.test"
    ) as client:
        for scenario in scenarios:
            request = scenario["request"]
            response = await client.request(
                request["method"],
                request["path"],
                headers=headers_by_auth[request["auth"]],
                json=request.get("json"),
            )
            captured.append({**scenario, "response": normalize_response(response)})

    app.dependency_overrides.clear()
    engine.dispose()
    return captured


def fixture_filename(fixture_id: str) -> str:
    return f"{fixture_id}.json"


def write_contract_artifacts(
    app: FastAPI, fixtures: Iterable[dict[str, Any]], root: Path = CONTRACT_ROOT
) -> None:
    root.mkdir(parents=True, exist_ok=True)
    fixtures_path = root / "fixtures"
    fixtures_path.mkdir(parents=True, exist_ok=True)
    openapi = app.openapi()
    inventory = build_route_inventory(app)
    (root / "openapi.json").write_text(canonical_json(openapi), encoding="utf-8")
    (root / "routes.json").write_text(canonical_json(inventory), encoding="utf-8")
    (root / "routes.md").write_text(
        render_route_inventory_markdown(inventory), encoding="utf-8"
    )

    manifest = []
    for fixture in fixtures:
        filename = fixture_filename(fixture["id"])
        (fixtures_path / filename).write_text(
            canonical_json(fixture), encoding="utf-8"
        )
        manifest.append(
            {
                "id": fixture["id"],
                "file": filename,
                "description": fixture["description"],
            }
        )
    (fixtures_path / "manifest.json").write_text(
        canonical_json({"format_version": 1, "fixtures": manifest}),
        encoding="utf-8",
    )


def load_fixtures(root: Path = CONTRACT_ROOT) -> list[dict[str, Any]]:
    fixture_root = root / "fixtures"
    manifest = json.loads((fixture_root / "manifest.json").read_text(encoding="utf-8"))
    return [
        json.loads((fixture_root / entry["file"]).read_text(encoding="utf-8"))
        for entry in manifest["fixtures"]
    ]
