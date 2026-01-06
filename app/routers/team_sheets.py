import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import HTMLResponse, StreamingResponse
from sqlalchemy.orm import Session, selectinload

from app import schemas
from app.core.security import get_current_manager_or_admin, get_current_user
from app.database import get_db
from app.models import (
    Shift,
    Section,
    TeamSheet,
    TeamSheetAssignment,
    TeamSheetStatus,
    User,
    SideworkTask,
    OutworkTask,
    StorePreference,
)
from app.services import team_sheets as team_sheet_service

router = APIRouter(prefix="/team-sheets", tags=["team_sheets"])


@router.get("", response_model=list[schemas.TeamSheetRead])
def list_team_sheets(
    start_date: date | None = Query(default=None),
    end_date: date | None = Query(default=None),
    status: TeamSheetStatus | None = Query(default=None),
    time_period: str | None = Query(default=None),
    manager_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = db.query(TeamSheet).join(Shift)
    query = query.options(
        selectinload(TeamSheet.assignments).selectinload(TeamSheetAssignment.employee),
        selectinload(TeamSheet.assignments).selectinload(TeamSheetAssignment.section),
        selectinload(TeamSheet.sidework_tasks).selectinload(SideworkTask.assignments),
        selectinload(TeamSheet.outwork_tasks).selectinload(OutworkTask.assignments),
    )
    if start_date:
        query = query.filter(Shift.date >= start_date)
    if end_date:
        query = query.filter(Shift.date <= end_date)
    if status:
        query = query.filter(TeamSheet.status == status)
    if manager_id:
        query = query.filter(TeamSheet.created_by_user_id == manager_id)
    if time_period:
        query = query.filter(Shift.time_period == time_period)
    query = query.order_by(Shift.date.desc())
    results = query.all()
    return [team_sheet_service.serialize_team_sheet(item) for item in results]


@router.post("", response_model=schemas.TeamSheetRead, status_code=status.HTTP_201_CREATED)
def create_team_sheet(
    payload: schemas.TeamSheetCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    shift = db.query(Shift).filter(Shift.id == payload.shift_id).first()
    if not shift:
        raise HTTPException(status_code=404, detail="Shift not found")

    team_sheet = TeamSheet(
        shift_id=payload.shift_id,
        title=payload.title,
        status=payload.status,
        notes=payload.notes,
        created_by_user_id=current_user.id,
    )

    if payload.source_team_sheet_id:
        source = team_sheet_service.fetch_team_sheet(db, payload.source_team_sheet_id)
        if not source:
            raise HTTPException(status_code=404, detail="Source team sheet not found")
        team_sheet_service.clone_team_sheet(source, team_sheet, db)
    else:
        team_sheet_service.apply_team_sheet_payload(team_sheet, payload)
        db.add(team_sheet)

    db.commit()
    db.refresh(team_sheet)
    loaded = team_sheet_service.fetch_team_sheet(db, team_sheet.id)
    return team_sheet_service.serialize_team_sheet(loaded)


@router.get("/{team_sheet_id}", response_model=schemas.TeamSheetRead)
def get_team_sheet(team_sheet_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    team_sheet = team_sheet_service.fetch_team_sheet(db, team_sheet_id)
    if not team_sheet:
        raise HTTPException(status_code=404, detail="Team sheet not found")
    return team_sheet_service.serialize_team_sheet(team_sheet)


@router.put("/{team_sheet_id}", response_model=schemas.TeamSheetRead)
def update_team_sheet(
    team_sheet_id: int,
    payload: schemas.TeamSheetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    team_sheet = team_sheet_service.fetch_team_sheet(db, team_sheet_id)
    if not team_sheet:
        raise HTTPException(status_code=404, detail="Team sheet not found")
    if payload.title is not None:
        team_sheet.title = payload.title
    if payload.status is not None:
        team_sheet.status = payload.status
    if payload.notes is not None:
        team_sheet.notes = payload.notes

    team_sheet_service.apply_team_sheet_payload(team_sheet, payload)
    db.commit()
    db.refresh(team_sheet)
    refreshed = team_sheet_service.fetch_team_sheet(db, team_sheet.id)
    return team_sheet_service.serialize_team_sheet(refreshed)


@router.get("/{team_sheet_id}/export/json", response_model=schemas.TeamSheetRead)
def export_team_sheet_json(
    team_sheet_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    team_sheet = team_sheet_service.fetch_team_sheet(db, team_sheet_id)
    if not team_sheet:
        raise HTTPException(status_code=404, detail="Team sheet not found")
    return team_sheet_service.serialize_team_sheet(team_sheet)


@router.get("/{team_sheet_id}/export/csv")
def export_team_sheet_csv(
    team_sheet_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    team_sheet = team_sheet_service.fetch_team_sheet(db, team_sheet_id)
    if not team_sheet:
        raise HTTPException(status_code=404, detail="Team sheet not found")

    csv_buffer = io.StringIO()
    writer = csv.writer(csv_buffer)
    writer.writerow(["Section", "Employee", "Role", "Sidework", "Outwork", "Notes"])
    for assignment in team_sheet.assignments:
        employee_name = (
            f"{assignment.employee.first_name} {assignment.employee.last_name}" if assignment.employee else "Unassigned"
        )
        section_label = assignment.section.label if assignment.section else "Unassigned"
        sidework_labels = [
            task.label
            for task in team_sheet.sidework_tasks
            if any(a.employee_id == assignment.employee_id for a in task.assignments)
        ]
        outwork_labels = [
            task.label
            for task in team_sheet.outwork_tasks
            if any(a.employee_id == assignment.employee_id for a in task.assignments)
        ]
        writer.writerow(
            [
                section_label,
                employee_name,
                assignment.role_label or "",
                "; ".join(sidework_labels),
                "; ".join(outwork_labels),
                team_sheet.notes or "",
            ]
        )

    csv_buffer.seek(0)
    filename = f"team_sheet_{team_sheet_id}.csv"
    return StreamingResponse(
        csv_buffer,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/{team_sheet_id}/print", response_class=HTMLResponse)
def print_team_sheet(
    team_sheet_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    team_sheet = team_sheet_service.fetch_team_sheet(db, team_sheet_id)
    if not team_sheet:
        raise HTTPException(status_code=404, detail="Team sheet not found")
    data = team_sheet_service.serialize_team_sheet(team_sheet)
    shift = db.query(Shift).filter(Shift.id == team_sheet.shift_id).first()
    in_time = ""
    if shift and shift.store_id:
        store_pref = (
            db.query(StorePreference)
            .filter(StorePreference.store_number == str(shift.store_id))
            .first()
        )
        if store_pref and store_pref.daily_schedule:
            day_name = shift.date.strftime("%A")
            entry = next(
                (item for item in store_pref.daily_schedule if (item.get("day") or "").lower() == day_name.lower()),
                None,
            )
            if entry:
                if shift.time_period.value == "DINNER":
                    in_time = entry.get("second_shift_in") or entry.get("open_time") or ""
                else:
                    in_time = entry.get("first_shift_in") or entry.get("open_time") or ""

    def format_time(value: str) -> str:
        if not value:
            return ""
        parts = value.split(":")
        if len(parts) < 2:
            return value
        try:
            hour = int(parts[0])
            minute = int(parts[1])
        except ValueError:
            return value
        suffix = "AM" if hour < 12 else "PM"
        hour = hour % 12 or 12
        return f"{hour}:{minute:02d} {suffix}"

    def normalize_task_label(label: str) -> str:
        if not label:
            return ""
        prefix = "] "
        if label.startswith("[Section:") and prefix in label:
            return label.split(prefix, 1)[1].strip()
        return label.strip()

    sidework_by_employee = {}
    for task in team_sheet.sidework_tasks:
        label = normalize_task_label(task.label or "")
        for assignment in task.assignments:
            sidework_by_employee.setdefault(assignment.employee_id, []).append(label)

    outwork_by_employee = {}
    for task in team_sheet.outwork_tasks:
        label = normalize_task_label(task.label or "")
        for assignment in task.assignments:
            outwork_by_employee.setdefault(assignment.employee_id, []).append(label)

    section_map = {
        section.id: (section.label or section.name)
        for section in db.query(Section).all()
    }
    rows = "".join(
        "<tr>"
        f"<td>{format_time(in_time)}</td>"
        f"<td>{item.section_label or item.role_label or section_map.get(item.section_id, '')}</td>"
        f"<td>{item.employee_name or ''}</td>"
        f"<td>{'; '.join(sidework_by_employee.get(item.employee_id, []))}</td>"
        f"<td>{'; '.join(outwork_by_employee.get(item.employee_id, []))}</td>"
        "</tr>"
        for item in data.assignments
    )
    shift_label = shift.time_period.value if shift else ""
    shift_date = shift.date.strftime("%Y-%m-%d") if shift else ""
    store_label = f"Store {shift.store_id}" if shift and shift.store_id else ""
    html = f"""
    <html>
    <head>
      <title>{data.title}</title>
      <style>
        body {{ font-family: "Segoe UI", Arial, sans-serif; margin: 24px; color: #111; }}
        h1 {{ margin: 0 0 6px; }}
        .meta {{ color: #444; margin-bottom: 16px; }}
        table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
        th, td {{ border: 1px solid #444; padding: 6px 8px; text-align: left; vertical-align: top; }}
        th {{ background: #efefef; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; }}
      </style>
    </head>
    <body>
      <h1>{data.title}</h1>
      <div class="meta">Status: {data.status} {shift_date} {shift_label} {store_label}</div>
      <div class="meta">Notes: {data.notes or ''}</div>
      <table border="1" cellpadding="4" cellspacing="0">
        <tr>
          <th>In Time</th>
          <th>Section</th>
          <th>Employee</th>
          <th>Sidework</th>
          <th>Outwork</th>
        </tr>
        {rows}
      </table>
    </body></html>
    """
    return HTMLResponse(content=html)
