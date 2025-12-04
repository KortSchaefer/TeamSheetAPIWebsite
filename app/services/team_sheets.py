from typing import Iterable, List

from sqlalchemy.orm import Session, selectinload

from app import schemas
from app.models import (
    Employee,
    OutworkAssignment,
    OutworkTask,
    Section,
    SideworkAssignment,
    SideworkTask,
    TeamSheet,
    TeamSheetAssignment,
)


def clone_team_sheet(source: TeamSheet, target: TeamSheet, db: Session):
    target.title = f"{source.title} (copy)"
    target.notes = source.notes
    target.assignments = [
        TeamSheetAssignment(
            employee_id=a.employee_id,
            section_id=a.section_id,
            role_label=a.role_label,
            order_index=a.order_index,
        )
        for a in source.assignments
    ]

    def clone_tasks(tasks: Iterable[SideworkTask | OutworkTask], task_cls, assignment_cls):
        cloned = []
        for task in tasks:
            new_task = task_cls(label=task.label, description=task.description)
            new_task.assignments = [
                assignment_cls(employee_id=assignment.employee_id) for assignment in task.assignments
            ]
            cloned.append(new_task)
        return cloned

    target.sidework_tasks = clone_tasks(source.sidework_tasks, SideworkTask, SideworkAssignment)
    target.outwork_tasks = clone_tasks(source.outwork_tasks, OutworkTask, OutworkAssignment)
    db.add(target)


def replace_assignments(team_sheet: TeamSheet, payloads: List[schemas.TeamSheetAssignmentPayload]):
    team_sheet.assignments = [
        TeamSheetAssignment(
            employee_id=item.employee_id,
            section_id=item.section_id,
            role_label=item.role_label,
            order_index=item.order_index,
        )
        for item in payloads
    ]


def replace_tasks(task_cls, assignment_cls, team_sheet: TeamSheet, payloads: List[schemas.TeamSheetTaskPayload]):
    tasks = []
    for item in payloads:
        task = task_cls(label=item.label, description=item.description)
        task.assignments = [assignment_cls(employee_id=eid) for eid in item.employee_ids]
        tasks.append(task)
    return tasks


def apply_team_sheet_payload(team_sheet: TeamSheet, payload: schemas.TeamSheetCreate | schemas.TeamSheetUpdate):
    if payload.assignments is not None:
        replace_assignments(team_sheet, payload.assignments)
    if payload.sidework is not None:
        team_sheet.sidework_tasks = replace_tasks(SideworkTask, SideworkAssignment, team_sheet, payload.sidework)
    if payload.outwork is not None:
        team_sheet.outwork_tasks = replace_tasks(OutworkTask, OutworkAssignment, team_sheet, payload.outwork)


def serialize_team_sheet(team_sheet: TeamSheet) -> schemas.TeamSheetRead:
    return schemas.TeamSheetRead(
        id=team_sheet.id,
        shift_id=team_sheet.shift_id,
        title=team_sheet.title,
        status=team_sheet.status,
        notes=team_sheet.notes,
        created_by_user_id=team_sheet.created_by_user_id,
        created_at=team_sheet.created_at,
        updated_at=team_sheet.updated_at,
        assignments=[
            schemas.TeamSheetAssignmentRead(
                id=a.id,
                employee_id=a.employee_id,
                section_id=a.section_id,
                role_label=a.role_label,
                order_index=a.order_index,
                employee_name=f"{a.employee.first_name} {a.employee.last_name}" if a.employee else None,
                section_label=a.section.label if a.section else None,
            )
            for a in team_sheet.assignments
        ],
        sidework=[
            schemas.TeamSheetTaskRead(
                id=task.id,
                label=task.label,
                description=task.description,
                employee_ids=[assignment.employee_id for assignment in task.assignments],
            )
            for task in team_sheet.sidework_tasks
        ],
        outwork=[
            schemas.TeamSheetTaskRead(
                id=task.id,
                label=task.label,
                description=task.description,
                employee_ids=[assignment.employee_id for assignment in task.assignments],
            )
            for task in team_sheet.outwork_tasks
        ],
    )


def fetch_team_sheet(db: Session, team_sheet_id: int) -> TeamSheet | None:
    return (
        db.query(TeamSheet)
        .filter(TeamSheet.id == team_sheet_id)
        .options(
            selectinload(TeamSheet.assignments).selectinload(TeamSheetAssignment.employee),
            selectinload(TeamSheet.assignments).selectinload(TeamSheetAssignment.section),
            selectinload(TeamSheet.sidework_tasks).selectinload(SideworkTask.assignments),
            selectinload(TeamSheet.outwork_tasks).selectinload(OutworkTask.assignments),
        )
        .first()
    )
