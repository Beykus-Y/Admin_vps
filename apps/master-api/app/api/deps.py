import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_access_token, hash_token
from app.db.base import AsyncSession, get_db
from app.db.models import Node, NodeCredential, User
from sqlalchemy import select

bearer_scheme = HTTPBearer()
ROLE_LEVEL = {"viewer": 0, "operator": 1, "admin": 2}


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    user = await get_user_by_access_token(credentials.credentials, db)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return user


async def get_user_by_access_token(token: str, db: AsyncSession) -> User | None:
    username = decode_access_token(token)
    if not username:
        return None
    result = await db.execute(select(User).where(User.username == username, User.is_active == True))
    user = result.scalar_one_or_none()
    return user


async def get_agent_node(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> Node:
    token_hash = hash_token(credentials.credentials)
    result = await db.execute(
        select(NodeCredential).where(
            NodeCredential.token_hash == token_hash,
            NodeCredential.revoked_at == None,
        )
    )
    cred = result.scalar_one_or_none()
    if not cred:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid agent token")

    node_result = await db.execute(select(Node).where(Node.id == cred.node_id))
    node = node_result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Node not found")
    return node


def require_role(min_role: str):
    async def dependency(user: Annotated[User, Depends(get_current_user)]) -> User:
        user_level = ROLE_LEVEL.get(user.role or "viewer", 0)
        required_level = ROLE_LEVEL[min_role]
        if user_level < required_level:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")
        return user

    return dependency


CurrentUser = Annotated[User, Depends(get_current_user)]
CurrentOperator = Annotated[User, Depends(require_role("operator"))]
CurrentAdmin = Annotated[User, Depends(require_role("admin"))]
AgentNode = Annotated[Node, Depends(get_agent_node)]
DB = Annotated[AsyncSession, Depends(get_db)]
