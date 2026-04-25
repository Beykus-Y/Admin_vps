from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DB
from app.core.security import create_access_token, hash_password, verify_password
from app.db.models import User
from app.schemas.auth import LoginRequest, TokenResponse, UserOut
from app.services.audit import log_action

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: DB):
    result = await db.execute(select(User).where(User.username == body.username, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = create_access_token(user.username)
    await log_action(
        db,
        user=user,
        action="auth.login",
        target_type="user",
        target_id=str(user.id),
        message=f"User {user.username} logged in",
        details={"role": user.role},
    )
    await db.commit()
    return TokenResponse(
        access_token=token,
        user=UserOut(id=str(user.id), username=user.username, role=user.role, is_active=user.is_active),
    )


@router.post("/init", response_model=TokenResponse, include_in_schema=False)
async def init_admin(body: LoginRequest, db: DB):
    """Bootstrap endpoint: creates first admin user if no users exist."""
    count_result = await db.execute(select(User))
    existing = count_result.scalars().all()
    if existing:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin already exists")
    user = User(username=body.username, password_hash=hash_password(body.password), role="admin")
    db.add(user)
    await db.commit()
    await log_action(
        db,
        user=user,
        action="auth.init",
        target_type="user",
        target_id=str(user.id),
        message=f"Bootstrap admin {user.username} created",
        details={"role": user.role},
    )
    await db.commit()
    token = create_access_token(user.username)
    return TokenResponse(
        access_token=token,
        user=UserOut(id=str(user.id), username=user.username, role=user.role, is_active=user.is_active),
    )


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser):
    return UserOut(id=str(user.id), username=user.username, role=user.role, is_active=user.is_active)
