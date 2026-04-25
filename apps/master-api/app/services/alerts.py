from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select

from app.db.models import AlertChannel, AlertIncident, AlertRule, Event, Node, OpenPort, User


RULE_KIND_ORDER = [
    "node.offline",
    "cpu.high",
    "ram.high",
    "disk.high",
    "port.unexpected",
    "container.down",
    "agent.outdated",
]

DEFAULT_ALERT_RULES = {
    "node.offline": {
        "name": "Нода оффлайн",
        "description": "Нода не отвечает дольше заданного порога",
        "severity": "critical",
        "enabled": True,
        "threshold": None,
    },
    "cpu.high": {
        "name": "CPU > 90%",
        "description": "Высокая загрузка CPU на одной или нескольких нодах",
        "severity": "warning",
        "enabled": True,
        "threshold": 90.0,
    },
    "ram.high": {
        "name": "RAM > 85%",
        "description": "Оперативная память близка к пределу",
        "severity": "warning",
        "enabled": True,
        "threshold": 85.0,
    },
    "disk.high": {
        "name": "Диск > 80%",
        "description": "Свободное место заканчивается",
        "severity": "warning",
        "enabled": False,
        "threshold": 80.0,
    },
    "port.unexpected": {
        "name": "Новый открытый порт",
        "description": "Появился порт, который ещё не отмечен как ожидаемый",
        "severity": "warning",
        "enabled": True,
        "threshold": 1.0,
    },
    "container.down": {
        "name": "Контейнер остановлен",
        "description": "Docker-контейнер не находится в состоянии running",
        "severity": "warning",
        "enabled": True,
        "threshold": 1.0,
    },
    "agent.outdated": {
        "name": "Агент устарел",
        "description": "Доступна более новая версия агента",
        "severity": "info",
        "enabled": False,
        "threshold": None,
    },
}


@dataclass
class NotificationEnvelope:
    title: str
    message: str
    severity: str
    status: str
    node_id: str | None
    node_name: str | None
    rule_kind: str
    rule_name: str
    incident_id: str
    extra: dict[str, Any]


async def ensure_default_alert_rules(db) -> None:
    result = await db.execute(select(AlertRule))
    existing = {rule.kind: rule for rule in result.scalars().all()}
    created = False
    for kind, default in DEFAULT_ALERT_RULES.items():
        if kind in existing:
            continue
        db.add(
            AlertRule(
                name=default["name"],
                kind=kind,
                description=default["description"],
                severity=default["severity"],
                enabled=default["enabled"],
                threshold=default["threshold"],
                duration_seconds=0,
                filters={},
            )
        )
        created = True
    if created:
        await db.commit()


async def get_rules_by_kind(db) -> dict[str, AlertRule]:
    result = await db.execute(select(AlertRule).order_by(AlertRule.name))
    return {rule.kind: rule for rule in result.scalars().all()}


async def list_notification_channels(db, severity: str, *, status: str = "open") -> list[AlertChannel]:
    result = await db.execute(select(AlertChannel).where(AlertChannel.enabled == True))  # noqa: E712
    channels = result.scalars().all()
    filtered: list[AlertChannel] = []
    for channel in channels:
        severities = channel.severities or []
        if severity not in severities:
            continue
        if status == "resolved" and not channel.send_resolved:
            continue
        filtered.append(channel)
    return filtered


def incident_is_active(incident: AlertIncident) -> bool:
    return incident.resolved_at is None


async def resolve_rule_incidents(db, rule: AlertRule, *, reason: str | None = None) -> None:
    result = await db.execute(
        select(AlertIncident).where(AlertIncident.rule_id == rule.id, AlertIncident.resolved_at == None)  # noqa: E711
    )
    now = datetime.now(UTC)
    for incident in result.scalars().all():
        incident.resolved_at = now
        incident.status = "resolved"
        incident.last_seen_at = now
        if reason:
            incident.extra = {**(incident.extra or {}), "resolved_reason": reason}


async def evaluate_rule(
    db,
    *,
    rule: AlertRule | None,
    node: Node,
    active: bool,
    message: str,
    current_value: float | None = None,
    extra: dict[str, Any] | None = None,
) -> list[NotificationEnvelope]:
    if not rule:
        return []

    notifications: list[NotificationEnvelope] = []
    now = datetime.now(UTC)
    result = await db.execute(
        select(AlertIncident).where(
            AlertIncident.rule_id == rule.id,
            AlertIncident.node_id == node.id,
            AlertIncident.resolved_at == None,  # noqa: E711
        )
    )
    incident = result.scalar_one_or_none()

    if not rule.enabled:
        if incident:
            incident.status = "resolved"
            incident.resolved_at = now
            incident.last_seen_at = now
        return notifications

    if active:
        if incident:
            incident.message = message
            incident.current_value = current_value
            incident.extra = extra or {}
            incident.last_seen_at = now
            if incident.status == "silenced" and incident.silenced_until and incident.silenced_until <= now:
                incident.status = "open"
                incident.silenced_until = None
        else:
            incident = AlertIncident(
                rule_id=rule.id,
                node_id=node.id,
                status="open",
                message=message,
                current_value=current_value,
                extra=extra or {},
                started_at=now,
                last_seen_at=now,
            )
            db.add(incident)
            db.add(
                Event(
                    node_id=node.id,
                    severity=rule.severity,
                    type=f"alert.{rule.kind}.opened",
                    message=message,
                    extra={"rule_kind": rule.kind, **(extra or {})},
                )
            )
            await db.flush()
            notifications.append(
                NotificationEnvelope(
                    title=f"{rule.name}: open",
                    message=message,
                    severity=rule.severity,
                    status="open",
                    node_id=str(node.id),
                    node_name=node.name,
                    rule_kind=rule.kind,
                    rule_name=rule.name,
                    incident_id=str(incident.id),
                    extra=extra or {},
                )
            )
        return notifications

    if not incident:
        return notifications

    incident.status = "resolved"
    incident.resolved_at = now
    incident.last_seen_at = now
    incident.current_value = current_value
    incident.extra = extra or {}
    db.add(
        Event(
            node_id=node.id,
            severity="info",
            type=f"alert.{rule.kind}.resolved",
            message=f"{rule.name}: resolved on {node.name}",
            extra={"rule_kind": rule.kind, **(extra or {})},
        )
    )
    notifications.append(
        NotificationEnvelope(
            title=f"{rule.name}: resolved",
            message=f"{rule.name}: resolved on {node.name}",
            severity=rule.severity,
            status="resolved",
            node_id=str(node.id),
            node_name=node.name,
            rule_kind=rule.kind,
            rule_name=rule.name,
            incident_id=str(incident.id),
            extra=extra or {},
        )
    )
    return notifications


async def evaluate_node_inventory_alerts(
    db,
    *,
    node: Node,
    metrics,
    containers: list[Any] | None,
    containers_collected: bool,
    ports_collected: bool,
    latest_agent_version: str | None = None,
) -> list[NotificationEnvelope]:
    rules = await get_rules_by_kind(db)
    notifications: list[NotificationEnvelope] = []

    notifications.extend(
        await evaluate_rule(
            db,
            rule=rules.get("node.offline"),
            node=node,
            active=False,
            message=f"Node {node.name} is online",
        )
    )

    if metrics is not None:
        cpu_threshold = rules.get("cpu.high").threshold if rules.get("cpu.high") else None
        cpu_value = metrics.cpu_percent
        notifications.extend(
            await evaluate_rule(
                db,
                rule=rules.get("cpu.high"),
                node=node,
                active=cpu_value is not None and cpu_threshold is not None and cpu_value >= cpu_threshold,
                message=f"CPU on {node.name} is {cpu_value:.1f}%" if cpu_value is not None else f"CPU alert on {node.name}",
                current_value=cpu_value,
                extra={"metric": "cpu_percent", "threshold": cpu_threshold},
            )
        )

        ram_pct = None
        if metrics.ram_used_mb is not None and metrics.ram_total_mb:
            ram_pct = (metrics.ram_used_mb / metrics.ram_total_mb) * 100
        ram_threshold = rules.get("ram.high").threshold if rules.get("ram.high") else None
        notifications.extend(
            await evaluate_rule(
                db,
                rule=rules.get("ram.high"),
                node=node,
                active=ram_pct is not None and ram_threshold is not None and ram_pct >= ram_threshold,
                message=f"RAM on {node.name} is {ram_pct:.1f}%" if ram_pct is not None else f"RAM alert on {node.name}",
                current_value=ram_pct,
                extra={"metric": "ram_percent", "threshold": ram_threshold},
            )
        )

        disk_pct = None
        if metrics.disk_used_gb is not None and metrics.disk_total_gb:
            disk_pct = (metrics.disk_used_gb / metrics.disk_total_gb) * 100
        disk_threshold = rules.get("disk.high").threshold if rules.get("disk.high") else None
        notifications.extend(
            await evaluate_rule(
                db,
                rule=rules.get("disk.high"),
                node=node,
                active=disk_pct is not None and disk_threshold is not None and disk_pct >= disk_threshold,
                message=f"Disk usage on {node.name} is {disk_pct:.1f}%" if disk_pct is not None else f"Disk alert on {node.name}",
                current_value=disk_pct,
                extra={"metric": "disk_percent", "threshold": disk_threshold},
            )
        )

    if containers_collected:
        down = [container for container in (containers or []) if (container.state or "").lower() != "running"]
        notifications.extend(
            await evaluate_rule(
                db,
                rule=rules.get("container.down"),
                node=node,
                active=bool(down),
                message=f"{len(down)} containers not running on {node.name}",
                current_value=float(len(down)),
                extra={"containers": [container.name for container in down[:10]]},
            )
        )

    if ports_collected:
        ports_result = await db.execute(select(OpenPort).where(OpenPort.node_id == node.id))
        current_ports = ports_result.scalars().all()
        fresh_after = datetime.now(UTC) - timedelta(seconds=90)
        unexpected = [
            port for port in current_ports
            if not port.is_expected and port.last_seen_at and port.last_seen_at >= fresh_after
        ]
        notifications.extend(
            await evaluate_rule(
                db,
                rule=rules.get("port.unexpected"),
                node=node,
                active=bool(unexpected),
                message=f"{len(unexpected)} unexpected ports on {node.name}",
                current_value=float(len(unexpected)),
                extra={
                    "ports": [
                        {
                            "protocol": port.protocol,
                            "port": port.port,
                            "listen_ip": port.listen_ip,
                            "process_name": port.process_name,
                        }
                        for port in unexpected[:10]
                    ]
                },
            )
        )

    if latest_agent_version and node.status == "online":
        current = normalize_agent_version(node.agent_version)
        latest = normalize_agent_version(latest_agent_version)
        outdated = bool(current and latest and current < latest)
        notifications.extend(
            await evaluate_rule(
                db,
                rule=rules.get("agent.outdated"),
                node=node,
                active=outdated,
                message=f"Agent on {node.name} is outdated ({node.agent_version} < {latest_agent_version})",
                extra={"current_version": node.agent_version, "latest_version": latest_agent_version},
            )
        )

    return notifications


async def evaluate_offline_alert(db, *, node: Node, active: bool) -> list[NotificationEnvelope]:
    rules = await get_rules_by_kind(db)
    return await evaluate_rule(
        db,
        rule=rules.get("node.offline"),
        node=node,
        active=active,
        message=f"Node {node.name} went offline",
        extra={"last_seen_at": node.last_seen_at.isoformat() if node.last_seen_at else None},
    )


def normalize_agent_version(version: str | None) -> tuple[int, int, int] | None:
    if not version:
        return None
    cleaned = version.removeprefix("agent/").lstrip("v")
    parts = cleaned.split(".")
    values: list[int] = []
    for part in parts[:3]:
        if not part.isdigit():
            return None
        values.append(int(part))
    while len(values) < 3:
        values.append(0)
    return values[0], values[1], values[2]


def notification_payload(envelope: NotificationEnvelope) -> dict[str, Any]:
    return {
        "title": envelope.title,
        "message": envelope.message,
        "severity": envelope.severity,
        "status": envelope.status,
        "node_id": envelope.node_id,
        "node_name": envelope.node_name,
        "rule_kind": envelope.rule_kind,
        "rule_name": envelope.rule_name,
        "incident_id": envelope.incident_id,
        "extra": envelope.extra,
    }


async def serialize_channels(channels: list[AlertChannel], *, include_resolved: bool = False) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for channel in channels:
        items.append(
            {
                "id": channel.id,
                "type": channel.type,
                "name": channel.name,
                "config": channel.config or {},
                "send_resolved": channel.send_resolved or include_resolved,
            }
        )
    return items


def incident_status_label(incident: AlertIncident, now: datetime | None = None) -> str:
    current = now or datetime.now(UTC)
    if incident.resolved_at:
        return "resolved"
    if incident.status == "silenced" and incident.silenced_until and incident.silenced_until <= current:
        return "open"
    return incident.status


def silence_until(minutes: int) -> datetime:
    return datetime.now(UTC) + timedelta(minutes=max(1, minutes))
