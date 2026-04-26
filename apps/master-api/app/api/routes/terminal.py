import asyncio
import json
import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentOperator, DB, ROLE_LEVEL, get_agent_node_by_token, get_user_by_access_token
from app.db.base import AsyncSessionLocal
from app.db.models import Event, Node, Task
from app.services.audit import log_action
from app.services.realtime import publish_event
from app.services.terminal import TerminalSession, terminal_hub

router = APIRouter(tags=["terminal"])

BROWSER_TERMINAL_MESSAGE_TYPES = {"input", "resize", "close"}
AGENT_TERMINAL_MESSAGE_TYPES = {"output", "status", "exit", "error", "close"}


class TerminalSessionCreate(BaseModel):
    shell: str | None = None


class TerminalSessionOut(BaseModel):
    id: str
    node_id: uuid.UUID
    created_at: datetime


async def _send_queue_to_websocket(queue: asyncio.Queue[str], websocket: WebSocket) -> None:
    while True:
        message = await queue.get()
        await websocket.send_text(message)
        try:
            parsed = json.loads(message)
        except json.JSONDecodeError:
            parsed = {}
        if parsed.get("type") == "close":
            return


async def _receive_websocket_to_queue(websocket: WebSocket, queue: asyncio.Queue[str], allowed_types: set[str]) -> None:
    while True:
        raw = await websocket.receive_text()
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            continue
        message_type = message.get("type")
        if message_type not in allowed_types:
            continue
        await queue.put(json.dumps(message))
        if message_type == "close":
            return


async def _bridge_session(session: TerminalSession, websocket: WebSocket, *, from_browser: bool) -> None:
    incoming = session.browser_to_agent if from_browser else session.agent_to_browser
    outgoing = session.agent_to_browser if from_browser else session.browser_to_agent
    allowed_types = BROWSER_TERMINAL_MESSAGE_TYPES if from_browser else AGENT_TERMINAL_MESSAGE_TYPES
    reader = asyncio.create_task(_receive_websocket_to_queue(websocket, incoming, allowed_types))
    writer = asyncio.create_task(_send_queue_to_websocket(outgoing, websocket))
    done, pending = await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in done:
        task.result()


def _bearer_token(websocket: WebSocket) -> str | None:
    auth = websocket.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        return None
    return auth.split(" ", 1)[1].strip()


@router.post("/nodes/{node_id}/terminal/sessions", response_model=TerminalSessionOut, status_code=201)
async def create_terminal_session(node_id: uuid.UUID, user: CurrentOperator, db: DB, body: TerminalSessionCreate | None = None):
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if node.status != "online":
        raise HTTPException(status_code=400, detail="Node is not online")
    if "terminal.session" not in (node.capabilities or []):
        raise HTTPException(status_code=400, detail="Node agent does not advertise browser terminal capability")

    session = await terminal_hub.create(node_id=str(node.id), created_by=user.username)
    task = Task(
        node_id=node.id,
        type="terminal.open",
        payload={"session_id": session.id, "shell": (body.shell if body else None) or "/bin/bash"},
    )
    db.add(task)
    db.add(Event(
        node_id=node.id,
        severity="info",
        type="terminal.session_requested",
        message=f"Browser terminal session requested for {node.name}",
        extra={"session_id": session.id, "user": user.username},
    ))
    await db.flush()
    await log_action(
        db,
        user=user,
        action="terminal.session.create",
        target_type="terminal_session",
        target_id=session.id,
        node_id=node.id,
        message=f"Browser terminal session opened for {node.name}",
        details={"task_id": str(task.id)},
    )
    await db.commit()
    await publish_event("tasks.changed", {"task_id": str(task.id), "node_id": str(node.id), "type": task.type})
    return TerminalSessionOut(id=session.id, node_id=node.id, created_at=session.created_at)


@router.websocket("/terminal/sessions/{session_id}")
async def browser_terminal_ws(websocket: WebSocket, session_id: str, token: str):
    await websocket.accept()
    async with AsyncSessionLocal() as db:
        user = await get_user_by_access_token(token, db)
        if not user or ROLE_LEVEL.get(user.role or "viewer", 0) < ROLE_LEVEL["operator"]:
            await websocket.send_text(json.dumps({"type": "error", "message": "Not enough permissions"}))
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

    session = await terminal_hub.get(session_id)
    if not session:
        await websocket.send_text(json.dumps({"type": "error", "message": "Terminal session not found or expired"}))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    if session.agent_connected:
        await websocket.send_text(json.dumps({"type": "status", "status": "connected", "message": "Reconnected to agent"}))
    else:
        await websocket.send_text(json.dumps({"type": "status", "status": "waiting", "message": "Waiting for agent"}))
    try:
        await _bridge_session(session, websocket, from_browser=True)
    except (WebSocketDisconnect, RuntimeError):
        pass
    # Session is kept alive so browser can reconnect after a page refresh.
    # Only agent disconnect or TTL expiry will close the session.


@router.websocket("/agent/terminal/{session_id}")
async def agent_terminal_ws(websocket: WebSocket, session_id: str):
    token = _bearer_token(websocket)
    await websocket.accept()
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    async with AsyncSessionLocal() as db:
        node = await get_agent_node_by_token(token, db)

    session = await terminal_hub.get(session_id)
    if not node or not session or str(node.id) != session.node_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    session.agent_connected = True
    await session.agent_to_browser.put(json.dumps({"type": "status", "status": "connected", "message": "Agent connected"}))
    try:
        await _bridge_session(session, websocket, from_browser=False)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        session.agent_connected = False
        await session.agent_to_browser.put(json.dumps({"type": "status", "status": "closed", "message": "Agent disconnected"}))
        await terminal_hub.close(session_id, reason="agent_disconnected")
