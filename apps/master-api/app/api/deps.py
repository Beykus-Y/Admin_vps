import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_access_token, hash_token
from app.db.base import AsyncSession, get_db
from app.db.models import Node, NodeCredential, User
from sqlalchemy import select

bearer_scheme = HTTPBearer()


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer_scheme)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    username = decode_access_token(credentials.credentials)
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    result = await db.execute(select(User).where(User.username == username, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
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


CurrentUser = Annotated[User, Depends(get_current_user)]
AgentNode = Annotated[Node, Depends(get_agent_node)]
DB = Annotated[AsyncSession, Depends(get_db)]
