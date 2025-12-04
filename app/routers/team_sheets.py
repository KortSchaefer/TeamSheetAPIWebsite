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
    TeamSheet,
    TeamSheetAssignment,
    TeamSheetStatus,
    User,
    SideworkTask,
    OutworkTask,
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
    rows = "".join(
        f"<tr><td>{item.section_label or ''}</td><td>{item.employee_name or ''}</td><td>{item.role_label or ''}</td></tr>"
        for item in data.assignments
    )
    html = f"""
    <html><head><title>{data.title}</title></head>
    <body>
      <h1>{data.title}</h1>
      <p>Status: {data.status}</p>
      <p>Notes: {data.notes or ''}</p>
      <table border="1" cellpadding="4" cellspacing="0">
        <tr><th>Section</th><th>Employee</th><th>Role</th></tr>
        {rows}
      </table>
    </body></html>
    """
    return HTMLResponse(content=html)
