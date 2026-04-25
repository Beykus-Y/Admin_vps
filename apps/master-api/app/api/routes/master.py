from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import CurrentAdmin, DB
from app.db.models import Event, Node, Task
from app.schemas.task import TaskOutFull
from app.services.audit import log_action
from app.services.realtime import publish_event

router = APIRouter(prefix="/master", tags=["master"])


def is_master_node(node: Node) -> bool:
    tags = node.tags or []
    return "master" in tags or node.group_name == "master" or node.name == "FilinControl Master"


@router.post("/update", response_model=TaskOutFull, status_code=201)
async def update_master(user: CurrentAdmin, db: DB):
    result = await db.execute(select(Node).where(Node.status == "online").order_by(Node.last_seen_at.desc()))
    master_node = next((node for node in result.scalars().all() if is_master_node(node)), None)
    if not master_node:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No online master agent found. Install the agent on the master VPS first.",
        )

    existing_result = await db.execute(
        select(Task).where(
            Task.node_id == master_node.id,
            Task.type == "master.update",
            Task.status.in_(["pending", "running"]),
        )
    )
    existing = existing_result.scalar_one_or_none()
    if existing:
        return existing

    task = Task(
        node_id=master_node.id,
        type="master.update",
        payload={
            "install_dir": "/opt/filincontrol",
            "compose_file": "/opt/filincontrol/docker-compose.yml",
            "override_file": "/opt/filincontrol/docker-compose.override.yml",
            "env_file": "/opt/filincontrol/.env",
        },
    )
    db.add(task)
    db.add(Event(
        node_id=master_node.id,
        severity="info",
        type="master.update_scheduled",
        message="Master update scheduled",
        extra={},
    ))
    await db.commit()
    await db.refresh(task)
    await log_action(
        db,
        user=user,
        action="master.update.schedule",
        target_type="task",
        target_id=str(task.id),
        node_id=master_node.id,
        message="Master update scheduled",
        details=task.payload,
    )
    await db.commit()
    await publish_event("tasks.changed", {"task_id": str(task.id), "node_id": str(master_node.id), "type": task.type})
    return task
