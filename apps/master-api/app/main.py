import asyncio

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import agent, alerts, audit, auth, events, inventory, master, nodes, overview, settings as settings_routes, stream, subproxy, terminal, version
from app.core.config import settings
from app.db.base import AsyncSessionLocal
from app.services.alerts import ensure_default_alert_rules
from app.services.node_monitor import run_monitor


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncSessionLocal() as db:
        await ensure_default_alert_rules(db)
    monitor_task = asyncio.create_task(run_monitor())
    yield
    monitor_task.cancel()
    try:
        await monitor_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="FilinControl API", version=settings.app_version, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(alerts.router, prefix="/api")
app.include_router(audit.router, prefix="/api")
app.include_router(events.router, prefix="/api")
app.include_router(inventory.router, prefix="/api")
app.include_router(nodes.router, prefix="/api")
app.include_router(overview.router, prefix="/api")
app.include_router(agent.router, prefix="/api")
app.include_router(version.router, prefix="/api")
app.include_router(master.router, prefix="/api")
app.include_router(settings_routes.router, prefix="/api")
app.include_router(subproxy.router, prefix="/api")
app.include_router(stream.router, prefix="/api")
app.include_router(terminal.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
