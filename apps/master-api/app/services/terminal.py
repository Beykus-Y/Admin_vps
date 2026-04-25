from __future__ import annotations

import asyncio
import json
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta


TERMINAL_SESSION_TTL = timedelta(minutes=30)


@dataclass
class TerminalSession:
    id: str
    node_id: str
    created_by: str
    created_at: datetime
    browser_to_agent: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=500))
    agent_to_browser: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(maxsize=500))
    closed: bool = False
    agent_connected: bool = False


class TerminalHub:
    def __init__(self) -> None:
        self._sessions: dict[str, TerminalSession] = {}
        self._lock = asyncio.Lock()

    async def create(self, *, node_id: str, created_by: str) -> TerminalSession:
        await self.cleanup()
        session = TerminalSession(
            id=secrets.token_urlsafe(24),
            node_id=node_id,
            created_by=created_by,
            created_at=datetime.now(UTC),
        )
        async with self._lock:
            self._sessions[session.id] = session
        return session

    async def get(self, session_id: str) -> TerminalSession | None:
        async with self._lock:
            session = self._sessions.get(session_id)
        if not session or session.closed:
            return None
        if session.created_at < datetime.now(UTC) - TERMINAL_SESSION_TTL:
            await self.close(session_id, reason="expired")
            return None
        return session

    async def close(self, session_id: str, *, reason: str = "closed") -> None:
        async with self._lock:
            session = self._sessions.pop(session_id, None)
        if not session or session.closed:
            return

        session.closed = True
        message = json.dumps({"type": "close", "reason": reason})
        for queue in (session.browser_to_agent, session.agent_to_browser):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def cleanup(self) -> None:
        cutoff = datetime.now(UTC) - TERMINAL_SESSION_TTL
        stale: list[str] = []
        async with self._lock:
            stale = [session_id for session_id, session in self._sessions.items() if session.created_at < cutoff or session.closed]
        for session_id in stale:
            await self.close(session_id, reason="expired")


terminal_hub = TerminalHub()
