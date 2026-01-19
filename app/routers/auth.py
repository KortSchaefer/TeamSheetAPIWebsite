from fastapi import APIRouter, Depends, HTTPException, status, Response, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app import schemas
from app.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    get_current_user,
    get_password_hash,
    verify_password,
)
from app.database import get_db
from app.models import User


router = APIRouter(prefix="/auth", tags=["auth"])


def set_auth_cookies(response: Response, access_token: str, refresh_token: str, request: Request) -> None:
    secure_cookie = request.url.scheme == "https"
    response.set_cookie(
        "tss_access_token",
        access_token,
        max_age=settings.access_token_expire_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=secure_cookie,
        path="/",
    )
    response.set_cookie(
        "tss_refresh_token",
        refresh_token,
        max_age=settings.refresh_token_expire_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=secure_cookie,
        path="/",
    )


@router.post("/register", response_model=schemas.UserRead, status_code=status.HTTP_201_CREATED)
def register(
    user_in: schemas.UserCreate,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
):
    existing = db.query(User).filter(User.email == user_in.email).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        email=user_in.email,
        password_hash=get_password_hash(user_in.password),
        full_name=user_in.full_name,
        role=user_in.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token(user.id)
    set_auth_cookies(response, access_token, refresh_token, request)
    return user


@router.post("/login", response_model=schemas.TokenResponse)
def login(form_data: schemas.LoginRequest, response: Response, request: Request, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == form_data.email).first()
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token(user.id)
    set_auth_cookies(response, access_token, refresh_token, request)
    return schemas.TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.post("/token", response_model=schemas.TokenResponse)
def login_token(
    response: Response,
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """OAuth2 password flow support for the Swagger Authorize modal."""
    user = db.query(User).filter(User.email == form_data.username).first()
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    access_token = create_access_token(user.id)
    refresh_token = create_refresh_token(user.id)
    set_auth_cookies(response, access_token, refresh_token, request)
    return schemas.TokenResponse(access_token=access_token, refresh_token=refresh_token)


@router.get("/me", response_model=schemas.UserRead)
def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.post("/link-employee/{user_id}", response_model=schemas.UserRead)
def link_employee(
    user_id: int,
    payload: schemas.UserEmployeeLink,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_manager_or_admin),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    from app.models import Employee

    employee = db.query(Employee).filter(Employee.id == payload.employee_id).first()
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    user.employee_id = employee.id
    db.commit()
    db.refresh(user)
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, request: Request):
    secure_cookie = request.url.scheme == "https"
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie("tss_access_token", path="/", samesite="lax", secure=secure_cookie)
    response.delete_cookie("tss_refresh_token", path="/", samesite="lax", secure=secure_cookie)
    return response
