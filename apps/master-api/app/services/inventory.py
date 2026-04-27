from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from app.core.config import settings
from app.core.redis import get_redis
from app.db.models import AlertIncident, AlertRule, DockerContainer, Event, Node, NodeMetric, OpenPort, Task
from app.services.alerts import incident_status_label
from app.services.events import is_noisy_port_event

_CACHE_TTL = 5  # seconds


def _f(obj, key):
    """Field access that works for both ORM instances and RowMappings."""
    return obj[key] if isinstance(obj, Mapping) else getattr(obj, key)


def serialize_node(node) -> dict[str, Any]:
    return {
        "id": str(_f(node, "id")),
        "name": _f(node, "name"),
        "status": _f(node, "status"),
        "hostname": _f(node, "hostname"),
        "public_ip": _f(node, "public_ip"),
        "os": _f(node, "os"),
        "arch": _f(node, "arch"),
        "uptime_seconds": _f(node, "uptime_seconds"),
        "kernel": _f(node, "kernel"),
        "cpu_model": _f(node, "cpu_model"),
        "cpu_cores": _f(node, "cpu_cores"),
        "local_ips": _f(node, "local_ips") or [],
        "provider": _f(node, "provider"),
        "location": _f(node, "location"),
        "group_name": _f(node, "group_name"),
        "tags": _f(node, "tags") or [],
        "agent_version": _f(node, "agent_version"),
        "capabilities": _f(node, "capabilities") or [],
        "created_at": _f(node, "created_at"),
        "last_seen_at": _f(node, "last_seen_at"),
    }


def serialize_container(container) -> dict[str, Any]:
    return {
        "id": str(_f(container, "id")),
        "container_id": _f(container, "container_id"),
        "name": _f(container, "name"),
        "image": _f(container, "image"),
        "status": _f(container, "status"),
        "state": _f(container, "state"),
        "ports": _f(container, "ports"),
        "networks": _f(container, "networks"),
        "mounts": _f(container, "mounts"),
        "cpu_percent": _f(container, "cpu_percent"),
        "ram_mb": _f(container, "ram_mb"),
        "restart_count": _f(container, "restart_count"),
        "health_status": _f(container, "health_status"),
        "updated_at": _f(container, "updated_at"),
    }


def serialize_port(port, *, node_status: str) -> dict[str, Any]:
    fresh_after = datetime.now(UTC) - timedelta(seconds=max(settings.node_offline_threshold_seconds * 2, 90))
    last_seen_at = _f(port, "last_seen_at")
    return {
        "id": str(_f(port, "id")),
        "protocol": _f(port, "protocol"),
        "port": _f(port, "port"),
        "listen_ip": _f(port, "listen_ip"),
        "process_name": _f(port, "process_name"),
        "pid": _f(port, "pid"),
        "user_name": _f(port, "user_name"),
        "container_name": _f(port, "container_name"),
        "is_expected": _f(port, "is_expected"),
        "status": "open" if node_status == "online" and last_seen_at and last_seen_at >= fresh_after else "stale",
        "first_seen_at": _f(port, "first_seen_at"),
        "last_seen_at": last_seen_at,
    }


def serialize_metric(metric) -> dict[str, Any] | None:
    if not metric:
        return None
    return {
        "id": str(_f(metric, "id")),
        "cpu_percent": _f(metric, "cpu_percent"),
        "ram_used_mb": _f(metric, "ram_used_mb"),
        "ram_total_mb": _f(metric, "ram_total_mb"),
        "disk_used_gb": _f(metric, "disk_used_gb"),
        "disk_total_gb": _f(metric, "disk_total_gb"),
        "load_1": _f(metric, "load_1"),
        "load_5": _f(metric, "load_5"),
        "load_15": _f(metric, "load_15"),
        "network_rx_bytes": _f(metric, "network_rx_bytes"),
        "network_tx_bytes": _f(metric, "network_tx_bytes"),
        "created_at": _f(metric, "created_at"),
    }


async def load_inventory_snapshot(db, *, limit_events: int = 50) -> dict[str, Any]:
    cache_key = f"inventory:snapshot:{limit_events}"
    redis = None
    try:
        redis = await get_redis()
        cached = await redis.get(cache_key)
        if cached:
            return json.loads(cached)
    except Exception:
        pass

    result = await _build_snapshot(db, limit_events=limit_events)

    if redis is not None:
        try:
            await redis.setex(cache_key, _CACHE_TTL, json.dumps(result, default=str))
        except Exception:
            pass

    return result


async def _build_snapshot(db, *, limit_events: int = 50) -> dict[str, Any]:
    nodes_result = await db.execute(
        select(*Node.__table__.columns).order_by(Node.__table__.c.created_at.desc())
    )
    nodes = nodes_result.mappings().all()
    node_ids = [node["id"] for node in nodes]

    containers_by_node: dict[Any, list] = defaultdict(list)
    ports_by_node: dict[Any, list] = defaultdict(list)
    metrics_by_node: dict[Any, Any] = {}
    incidents_by_node: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    pending_tasks_by_node: dict[Any, int] = defaultdict(int)

    if node_ids:
        containers_result = await db.execute(
            select(*DockerContainer.__table__.columns)
            .where(DockerContainer.node_id.in_(node_ids))
            .order_by(DockerContainer.__table__.c.name)
        )
        for container in containers_result.mappings().all():
            containers_by_node[container["node_id"]].append(container)

        ports_result = await db.execute(
            select(*OpenPort.__table__.columns)
            .where(OpenPort.node_id.in_(node_ids))
            .order_by(OpenPort.__table__.c.port)
        )
        for port in ports_result.mappings().all():
            ports_by_node[port["node_id"]].append(port)

        metrics_result = await db.execute(
            select(*NodeMetric.__table__.columns)
            .distinct(NodeMetric.node_id)
            .where(NodeMetric.node_id.in_(node_ids))
            .order_by(NodeMetric.node_id, NodeMetric.__table__.c.created_at.desc())
        )
        for metric in metrics_result.mappings().all():
            metrics_by_node[metric["node_id"]] = metric

        incidents_result = await db.execute(
            select(AlertIncident, AlertRule, Node.name)
            .join(AlertRule, AlertRule.id == AlertIncident.rule_id)
            .outerjoin(Node, Node.id == AlertIncident.node_id)
            .where(AlertIncident.node_id.in_(node_ids), AlertIncident.resolved_at == None)  # noqa: E711
            .order_by(AlertIncident.created_at.desc())
        )
        for incident, rule, node_name in incidents_result.all():
            incidents_by_node[incident.node_id].append(
                {
                    "id": str(incident.id),
                    "rule_id": str(rule.id),
                    "rule_name": rule.name,
                    "rule_kind": rule.kind,
                    "severity": rule.severity,
                    "status": incident_status_label(incident),
                    "message": incident.message,
                    "current_value": incident.current_value,
                    "started_at": incident.started_at,
                    "last_seen_at": incident.last_seen_at,
                    "node_name": node_name,
                }
            )

        pending_result = await db.execute(
            select(Task.node_id, func.count(Task.id))
            .where(Task.node_id.in_(node_ids), Task.status.in_(["pending", "running"]))
            .group_by(Task.node_id)
        )
        for node_id, count in pending_result.all():
            pending_tasks_by_node[node_id] = count

    events_result = await db.execute(select(Event).order_by(Event.created_at.desc()).limit(max(limit_events * 2, 50)))
    recent_events = []
    for event in events_result.scalars().all():
        if is_noisy_port_event(event):
            continue
        recent_events.append(
            {
                "id": str(event.id),
                "node_id": str(event.node_id) if event.node_id else None,
                "severity": event.severity,
                "type": event.type,
                "message": event.message,
                "created_at": event.created_at,
            }
        )
        if len(recent_events) >= limit_events:
            break

    snapshot_nodes = []
    summary = {
        "nodes": {"total": len(nodes), "online": 0, "offline": 0, "pending": 0},
        "containers": {"total": 0, "running": 0},
        "ports": {"total": 0, "unexpected": 0, "public": 0},
        "incidents": {"open": 0, "critical": 0},
    }

    for node in nodes:
        node_containers = containers_by_node[node["id"]]
        node_ports = [serialize_port(port, node_status=node["status"]) for port in ports_by_node[node["id"]]]
        metric = metrics_by_node.get(node["id"])
        incidents = incidents_by_node[node["id"]]
        snapshot_nodes.append(
            {
                "node": serialize_node(node),
                "metrics": serialize_metric(metric),
                "containers": [serialize_container(container) for container in node_containers],
                "ports": node_ports,
                "incidents": incidents,
                "tasks_pending": pending_tasks_by_node[node["id"]],
            }
        )

        summary["nodes"][node["status"]] = summary["nodes"].get(node["status"], 0) + 1
        summary["containers"]["total"] += len(node_containers)
        summary["containers"]["running"] += sum(1 for c in node_containers if c["state"] == "running")
        summary["ports"]["total"] += len([p for p in node_ports if p["status"] == "open"])
        summary["ports"]["unexpected"] += len([p for p in node_ports if p["status"] == "open" and not p["is_expected"]])
        summary["ports"]["public"] += len(
            [p for p in node_ports if p["status"] == "open" and (not p["listen_ip"] or p["listen_ip"] in {"0.0.0.0", "::"})]
        )
        summary["incidents"]["open"] += len(incidents)
        summary["incidents"]["critical"] += len([i for i in incidents if i["severity"] == "critical"])

    return {"nodes": snapshot_nodes, "recent_events": recent_events, "summary": summary}
