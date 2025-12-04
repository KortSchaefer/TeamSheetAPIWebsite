import csv
import io
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.security import get_current_manager_or_admin
from app.database import get_db
from app.models import Employee, EmployeeRole

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


@router.post("/servers", status_code=status.HTTP_201_CREATED)
async def import_servers(
    file: UploadFile = File(..., description="CSV with columns: name, upsell_score, pitty, employment_days, max_guests"),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_manager_or_admin),
):
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames or "name" not in {h.lower() for h in reader.fieldnames}:
        raise HTTPException(status_code=400, detail="CSV must include a 'name' column.")

    created = 0
    updated = 0
    for row in reader:
        name = row.get("name") or row.get("Name")
        if not name:
            continue
        parts = name.strip().split()
        first_name = parts[0]
        last_name = parts[1] if len(parts) > 1 else ""

        upsell_score = _parse_int(row.get("upsell_score") or row.get("Upsell"))
        pitty = _parse_int(row.get("pitty") or row.get("Pitty"))
        employment_days = _parse_int(row.get("employment_days") or row.get("employment"))
        max_guests = _parse_int(row.get("max_guests") or row.get("capacity") or row.get("max_section_load"))
        nickname = row.get("nickname")

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
