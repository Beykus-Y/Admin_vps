import asyncio

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import agent, auth, nodes, overview
from app.services.node_monitor import run_monitor


@asynccontextmanager
async def lifespan(app: FastAPI):
    monitor_task = asyncio.create_task(run_monitor())
    yield
    monitor_task.cancel()
    try:
        await monitor_task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="FilinControl API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(nodes.router, prefix="/api")
app.include_router(overview.router, prefix="/api")
app.include_router(agent.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
