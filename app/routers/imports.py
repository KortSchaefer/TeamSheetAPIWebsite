import csv
import io
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.core.security import get_current_manager_or_admin
from app.database import get_db
from app.models import DailyRoster, Employee, EmployeeRole

router = APIRouter(prefix="/imports", tags=["imports"])


def _parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def _normalize_header(value: str) -> str:
    characters = (character.lower() if character.isalnum() else "_" for character in value)
    return "_".join(filter(None, "".join(characters).split("_")))


def _row_value(row: dict[str, str | None], *aliases: str) -> str | None:
    expected = {_normalize_header(alias) for alias in aliases}
    for key, value in row.items():
        if key and _normalize_header(key) in expected and value and value.strip():
            return value.strip()
    return None


def _parse_blast(value: str | None) -> int | None:
    return _parse_int(value.strip().removesuffix("%").strip()) if value is not None else None


@router.post("/servers", status_code=status.HTTP_201_CREATED)
async def import_servers(
    file: UploadFile = File(
        ...,
        description="CSV with columns: name, upsell_score, pitty, employment_days, max_guests",
    ),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_manager_or_admin),
):
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "name" not in {_normalize_header(header) for header in reader.fieldnames}:
        raise HTTPException(status_code=400, detail="CSV must include a 'name' column.")

    created = 0
    updated = 0
    for row in reader:
        name = _row_value(row, "name")
        if not name:
            continue
        parts = name.strip().split()
        first_name = parts[0]
        last_name = parts[1] if len(parts) > 1 else ""

        upsell_score = _parse_blast(
            _row_value(
                row,
                "upsell_score",
                "upsell",
                "blast",
                "blast_percent",
                "blast_percentage",
                "blast_score",
            )
        )
        pitty = _parse_int(_row_value(row, "pitty", "pity"))
        employment_days = _parse_int(_row_value(row, "employment_days", "employment"))
        max_guests = _parse_int(_row_value(row, "max_guests", "capacity", "max_section_load"))
        nickname = _row_value(row, "nickname")

        employee = (
            db.query(Employee)
            .filter(Employee.first_name == first_name, Employee.last_name == last_name)
            .first()
        )
        if not employee:
            employee = Employee(
                first_name=first_name,
                last_name=last_name,
                nickname=nickname,
                role=EmployeeRole.SERVER,
                employment_start_date=date.today(),
                active=True,
            )
            db.add(employee)
            created += 1
        else:
            updated += 1

        if nickname:
            employee.nickname = nickname
        if upsell_score is not None:
            employee.upsell_score = upsell_score
        if pitty is not None:
            employee.pitty_score = pitty
        if employment_days is not None:
            employee.employment_days = employment_days
            employee.employment_start_date = date.today() - timedelta(days=employment_days)
        if max_guests is not None:
            employee.max_section_load = max_guests

    db.commit()
    return {"created": created, "updated": updated}


@router.post("/daily-roster", status_code=status.HTTP_201_CREATED)
async def import_daily_roster(
    roster_date: date = Query(..., alias="date"),
    store_id: int | None = Query(default=None),
    file: UploadFile = File(..., description="CSV with column: name"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_manager_or_admin),
):
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV must include a header row.")

    headers = {_normalize_header(header) for header in reader.fieldnames}
    if "name" not in headers:
        raise HTTPException(status_code=400, detail="CSV must include a 'name' column.")

    entries = []
    for row in reader:
        name = _row_value(row, "name")
        if not name:
            continue
        entry = {"name": name.strip()}
        in_time = _row_value(row, "in_time")
        if in_time:
            entry["in_time"] = in_time
        entries.append(entry)

    roster = (
        db.query(DailyRoster)
        .filter(DailyRoster.date == roster_date, DailyRoster.store_id == store_id)
        .first()
    )
    if roster:
        roster.entries = entries
    else:
        roster = DailyRoster(date=roster_date, store_id=store_id, entries=entries)
        db.add(roster)

    db.commit()
    db.refresh(roster)
    return {"date": roster.date.isoformat(), "store_id": roster.store_id, "count": len(entries)}
