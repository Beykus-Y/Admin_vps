from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from app.core.config import settings
from app.db.models import AlertIncident, AlertRule, DockerContainer, Event, Node, NodeMetric, OpenPort, Task
from app.services.alerts import incident_status_label
from app.services.events import is_noisy_port_event


def serialize_node(node: Node) -> dict[str, Any]:
    return {
        "id": str(node.id),
        "name": node.name,
        "status": node.status,
        "hostname": node.hostname,
        "public_ip": node.public_ip,
        "os": node.os,
        "arch": node.arch,
        "uptime_seconds": node.uptime_seconds,
        "kernel": node.kernel,
        "cpu_model": node.cpu_model,
        "cpu_cores": node.cpu_cores,
        "local_ips": node.local_ips or [],
        "provider": node.provider,
        "location": node.location,
        "group_name": node.group_name,
        "tags": node.tags or [],
        "agent_version": node.agent_version,
        "capabilities": node.capabilities or [],
        "created_at": node.created_at,
        "last_seen_at": node.last_seen_at,
    }


def serialize_container(container: DockerContainer) -> dict[str, Any]:
    return {
        "id": str(container.id),
        "container_id": container.container_id,
        "name": container.name,
        "image": container.image,
        "status": container.status,
        "state": container.state,
        "ports": container.ports,
        "networks": container.networks,
        "mounts": container.mounts,
        "cpu_percent": container.cpu_percent,
        "ram_mb": container.ram_mb,
        "restart_count": container.restart_count,
        "health_status": container.health_status,
        "updated_at": container.updated_at,
    }


def serialize_port(port: OpenPort, *, node_status: str) -> dict[str, Any]:
    fresh_after = datetime.now(UTC) - timedelta(seconds=max(settings.node_offline_threshold_seconds * 2, 90))
    return {
        "id": str(port.id),
        "protocol": port.protocol,
        "port": port.port,
        "listen_ip": port.listen_ip,
        "process_name": port.process_name,
        "pid": port.pid,
        "user_name": port.user_name,
        "container_name": port.container_name,
        "is_expected": port.is_expected,
        "status": "open" if node_status == "online" and port.last_seen_at and port.last_seen_at >= fresh_after else "stale",
        "first_seen_at": port.first_seen_at,
        "last_seen_at": port.last_seen_at,
    }


def serialize_metric(metric: NodeMetric | None) -> dict[str, Any] | None:
    if not metric:
        return None
    return {
        "id": str(metric.id),
        "cpu_percent": metric.cpu_percent,
        "ram_used_mb": metric.ram_used_mb,
        "ram_total_mb": metric.ram_total_mb,
        "disk_used_gb": metric.disk_used_gb,
        "disk_total_gb": metric.disk_total_gb,
        "load_1": metric.load_1,
        "load_5": metric.load_5,
        "load_15": metric.load_15,
        "network_rx_bytes": metric.network_rx_bytes,
        "network_tx_bytes": metric.network_tx_bytes,
        "created_at": metric.created_at,
    }


async def load_inventory_snapshot(db, *, limit_events: int = 50) -> dict[str, Any]:
    nodes_result = await db.execute(select(Node).order_by(Node.created_at.desc()))
    nodes = nodes_result.scalars().all()
    node_ids = [node.id for node in nodes]

    containers_by_node: dict[Any, list[DockerContainer]] = defaultdict(list)
    ports_by_node: dict[Any, list[OpenPort]] = defaultdict(list)
    metrics_by_node: dict[Any, NodeMetric] = {}
    incidents_by_node: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    pending_tasks_by_node: dict[Any, int] = defaultdict(int)

    if node_ids:
        containers_result = await db.execute(select(DockerContainer).where(DockerContainer.node_id.in_(node_ids)).order_by(DockerContainer.name))
        for container in containers_result.scalars().all():
            containers_by_node[container.node_id].append(container)

        ports_result = await db.execute(select(OpenPort).where(OpenPort.node_id.in_(node_ids)).order_by(OpenPort.port))
        for port in ports_result.scalars().all():
            ports_by_node[port.node_id].append(port)

        metrics_result = await db.execute(
            select(NodeMetric)
            .distinct(NodeMetric.node_id)
            .where(NodeMetric.node_id.in_(node_ids))
            .order_by(NodeMetric.node_id, NodeMetric.created_at.desc())
        )
        for metric in metrics_result.scalars().all():
            metrics_by_node[metric.node_id] = metric

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
        node_containers = containers_by_node[node.id]
        node_ports = [serialize_port(port, node_status=node.status) for port in ports_by_node[node.id]]
        metric = metrics_by_node.get(node.id)
        incidents = incidents_by_node[node.id]
        snapshot_nodes.append(
            {
                "node": serialize_node(node),
                "metrics": serialize_metric(metric),
                "containers": [serialize_container(container) for container in node_containers],
                "ports": node_ports,
                "incidents": incidents,
                "tasks_pending": pending_tasks_by_node[node.id],
            }
        )

        summary["nodes"][node.status] = summary["nodes"].get(node.status, 0) + 1
        summary["containers"]["total"] += len(node_containers)
        summary["containers"]["running"] += sum(1 for container in node_containers if container.state == "running")
        summary["ports"]["total"] += len([port for port in node_ports if port["status"] == "open"])
        summary["ports"]["unexpected"] += len([port for port in node_ports if port["status"] == "open" and not port["is_expected"]])
        summary["ports"]["public"] += len(
            [port for port in node_ports if port["status"] == "open" and (not port["listen_ip"] or port["listen_ip"] in {"0.0.0.0", "::"})]
        )
        summary["incidents"]["open"] += len(incidents)
        summary["incidents"]["critical"] += len([incident for incident in incidents if incident["severity"] == "critical"])

    return {"nodes": snapshot_nodes, "recent_events": recent_events, "summary": summary}
