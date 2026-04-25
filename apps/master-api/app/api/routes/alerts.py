from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from app.api.deps import CurrentAdmin, CurrentOperator, CurrentUser, DB
from app.db.models import AlertChannel, AlertIncident, AlertRule, Node, User
from app.schemas.alerts import (
    AlertChannelCreate,
    AlertChannelOut,
    AlertChannelUpdate,
    AlertIncidentOut,
    AlertIncidentSilenceRequest,
    AlertRuleOut,
    AlertRuleUpdate,
)
from app.services.alerts import (
    RULE_KIND_ORDER,
    ensure_default_alert_rules,
    incident_status_label,
    list_notification_channels,
    notification_payload,
    resolve_rule_incidents,
    silence_until,
)
from app.services.audit import log_action
from app.services.notifications import dispatch_channels
from app.services.realtime import publish_event

router = APIRouter(prefix="/alerts", tags=["alerts"])

SUPPORTED_CHANNEL_TYPES = {"webhook", "telegram", "email"}


@router.get("/rules", response_model=list[AlertRuleOut])
async def list_rules(_: CurrentUser, db: DB):
    await ensure_default_alert_rules(db)
    result = await db.execute(select(AlertRule))
    rules = result.scalars().all()
    order = {kind: idx for idx, kind in enumerate(RULE_KIND_ORDER)}
    return sorted(rules, key=lambda item: order.get(item.kind, len(order)))


@router.patch("/rules/{rule_id}", response_model=AlertRuleOut)
async def update_rule(rule_id: str, body: AlertRuleUpdate, user: CurrentAdmin, db: DB):
    result = await db.execute(select(AlertRule).where(AlertRule.id == rule_id))
    rule = result.scalar_one_or_none()
    if not rule:
        raise HTTPException(status_code=404, detail="Alert rule not found")

    for field in body.model_fields_set:
        setattr(rule, field, getattr(body, field))

    if "enabled" in body.model_fields_set and body.enabled is False:
        await resolve_rule_incidents(db, rule, reason="rule_disabled")

    await log_action(
        db,
        user=user,
        action="alerts.rule.update",
        target_type="alert_rule",
        target_id=str(rule.id),
        message=f"Alert rule {rule.kind} updated",
        details={field: getattr(rule, field) for field in body.model_fields_set},
    )
    await db.commit()
    await db.refresh(rule)
    await publish_event("alerts.rules.changed", {"rule_id": str(rule.id)})
    return rule


@router.get("/incidents", response_model=list[AlertIncidentOut])
async def list_incidents(
    _: CurrentUser,
    db: DB,
    status: str = "active",
    node_id: str | None = None,
    limit: int = 200,
):
    stmt = (
        select(AlertIncident, AlertRule, Node, User)
        .join(AlertRule, AlertRule.id == AlertIncident.rule_id)
        .outerjoin(Node, Node.id == AlertIncident.node_id)
        .outerjoin(User, User.id == AlertIncident.acknowledged_by_user_id)
        .order_by(AlertIncident.created_at.desc())
        .limit(min(max(limit, 1), 500))
    )
    if node_id:
        stmt = stmt.where(AlertIncident.node_id == node_id)
    if status == "active":
        stmt = stmt.where(AlertIncident.resolved_at == None)  # noqa: E711
    elif status == "resolved":
        stmt = stmt.where(AlertIncident.resolved_at != None)  # noqa: E711

    rows = await db.execute(stmt)
    incidents: list[AlertIncidentOut] = []
    for incident, rule, node, ack_user in rows.all():
        incidents.append(
            AlertIncidentOut(
                id=incident.id,
                rule_id=rule.id,
                rule_name=rule.name,
                rule_kind=rule.kind,
                node_id=node.id if node else None,
                node_name=node.name if node else None,
                severity=rule.severity,
                status=incident_status_label(incident),
                message=incident.message,
                current_value=incident.current_value,
                extra=incident.extra or {},
                started_at=incident.started_at,
                last_seen_at=incident.last_seen_at,
                acknowledged_at=incident.acknowledged_at,
                acknowledged_by=ack_user.username if ack_user else None,
                silenced_until=incident.silenced_until,
                resolved_at=incident.resolved_at,
            )
        )
    return incidents


@router.post("/incidents/{incident_id}/ack", response_model=AlertIncidentOut)
async def acknowledge_incident(incident_id: str, user: CurrentOperator, db: DB):
    stmt = (
        select(AlertIncident, AlertRule, Node)
        .join(AlertRule, AlertRule.id == AlertIncident.rule_id)
        .outerjoin(Node, Node.id == AlertIncident.node_id)
        .where(AlertIncident.id == incident_id)
    )
    row = (await db.execute(stmt)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Alert incident not found")
    incident, rule, node = row
    if incident.resolved_at:
        raise HTTPException(status_code=400, detail="Incident is already resolved")

    now = datetime.now(UTC)
    incident.status = "acknowledged"
    incident.acknowledged_at = now
    incident.acknowledged_by_user_id = user.id
    incident.last_seen_at = now
    await log_action(
        db,
        user=user,
        action="alerts.incident.ack",
        target_type="alert_incident",
        target_id=str(incident.id),
        node_id=node.id if node else None,
        message=f"Incident {incident.id} acknowledged",
        details={"rule_kind": rule.kind},
    )
    await db.commit()
    await publish_event("alerts.incidents.changed", {"incident_id": str(incident.id), "status": "acknowledged"})
    return AlertIncidentOut(
        id=incident.id,
        rule_id=rule.id,
        rule_name=rule.name,
        rule_kind=rule.kind,
        node_id=node.id if node else None,
        node_name=node.name if node else None,
        severity=rule.severity,
        status=incident.status,
        message=incident.message,
        current_value=incident.current_value,
        extra=incident.extra or {},
        started_at=incident.started_at,
        last_seen_at=incident.last_seen_at,
        acknowledged_at=incident.acknowledged_at,
        acknowledged_by=user.username,
        silenced_until=incident.silenced_until,
        resolved_at=incident.resolved_at,
    )


@router.post("/incidents/{incident_id}/silence", response_model=AlertIncidentOut)
async def silence_incident(incident_id: str, body: AlertIncidentSilenceRequest, user: CurrentOperator, db: DB):
    stmt = (
        select(AlertIncident, AlertRule, Node)
        .join(AlertRule, AlertRule.id == AlertIncident.rule_id)
        .outerjoin(Node, Node.id == AlertIncident.node_id)
        .where(AlertIncident.id == incident_id)
    )
    row = (await db.execute(stmt)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Alert incident not found")
    incident, rule, node = row
    if incident.resolved_at:
        raise HTTPException(status_code=400, detail="Incident is already resolved")

    incident.status = "silenced"
    incident.silenced_until = silence_until(body.minutes)
    incident.last_seen_at = datetime.now(UTC)
    await log_action(
        db,
        user=user,
        action="alerts.incident.silence",
        target_type="alert_incident",
        target_id=str(incident.id),
        node_id=node.id if node else None,
        message=f"Incident {incident.id} silenced",
        details={"minutes": body.minutes, "rule_kind": rule.kind},
    )
    await db.commit()
    await publish_event("alerts.incidents.changed", {"incident_id": str(incident.id), "status": "silenced"})
    return AlertIncidentOut(
        id=incident.id,
        rule_id=rule.id,
        rule_name=rule.name,
        rule_kind=rule.kind,
        node_id=node.id if node else None,
        node_name=node.name if node else None,
        severity=rule.severity,
        status=incident.status,
        message=incident.message,
        current_value=incident.current_value,
        extra=incident.extra or {},
        started_at=incident.started_at,
        last_seen_at=incident.last_seen_at,
        acknowledged_at=incident.acknowledged_at,
        acknowledged_by=None,
        silenced_until=incident.silenced_until,
        resolved_at=incident.resolved_at,
    )


@router.get("/channels", response_model=list[AlertChannelOut])
async def list_channels(_: CurrentAdmin, db: DB):
    result = await db.execute(select(AlertChannel).order_by(AlertChannel.name))
    return result.scalars().all()


@router.post("/channels", response_model=AlertChannelOut, status_code=201)
async def create_channel(body: AlertChannelCreate, user: CurrentAdmin, db: DB):
    if body.type not in SUPPORTED_CHANNEL_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported channel type")
    channel = AlertChannel(
        name=body.name,
        type=body.type,
        enabled=body.enabled,
        severities=body.severities,
        send_resolved=body.send_resolved,
        config=body.config,
    )
    db.add(channel)
    await log_action(
        db,
        user=user,
        action="alerts.channel.create",
        target_type="alert_channel",
        message=f"Notification channel {body.name} created",
        details={"type": body.type, "severities": body.severities},
    )
    await db.commit()
    await db.refresh(channel)
    await publish_event("alerts.channels.changed", {"channel_id": str(channel.id)})
    return channel


@router.patch("/channels/{channel_id}", response_model=AlertChannelOut)
async def update_channel(channel_id: str, body: AlertChannelUpdate, user: CurrentAdmin, db: DB):
    result = await db.execute(select(AlertChannel).where(AlertChannel.id == channel_id))
    channel = result.scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=404, detail="Notification channel not found")
    if "type" in body.model_fields_set and body.type not in SUPPORTED_CHANNEL_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported channel type")
    for field in body.model_fields_set:
        setattr(channel, field, getattr(body, field))
    await log_action(
        db,
        user=user,
        action="alerts.channel.update",
        target_type="alert_channel",
        target_id=str(channel.id),
        message=f"Notification channel {channel.name} updated",
        details={field: getattr(channel, field) for field in body.model_fields_set},
    )
    await db.commit()
    await db.refresh(channel)
    await publish_event("alerts.channels.changed", {"channel_id": str(channel.id)})
    return channel


@router.delete("/channels/{channel_id}", status_code=204)
async def delete_channel(channel_id: str, user: CurrentAdmin, db: DB):
    result = await db.execute(select(AlertChannel).where(AlertChannel.id == channel_id))
    channel = result.scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=404, detail="Notification channel not found")
    await log_action(
        db,
        user=user,
        action="alerts.channel.delete",
        target_type="alert_channel",
        target_id=str(channel.id),
        message=f"Notification channel {channel.name} deleted",
        details={"type": channel.type},
    )
    await db.delete(channel)
    await db.commit()
    await publish_event("alerts.channels.changed", {"channel_id": channel_id, "deleted": True})


@router.post("/channels/{channel_id}/test")
async def test_channel(channel_id: str, _: CurrentAdmin, db: DB):
    result = await db.execute(select(AlertChannel).where(AlertChannel.id == channel_id))
    channel = result.scalar_one_or_none()
    if not channel:
        raise HTTPException(status_code=404, detail="Notification channel not found")

    payload = {
        "title": "Test notification",
        "message": f"FilinControl test message for channel {channel.name}",
        "severity": "info",
        "status": "test",
        "node_id": None,
        "node_name": None,
        "rule_kind": "test",
        "rule_name": "Test",
        "incident_id": "test",
        "extra": {},
    }
    results = await dispatch_channels(
        [
            {
                "id": channel.id,
                "name": channel.name,
                "type": channel.type,
                "config": channel.config or {},
                "send_resolved": channel.send_resolved,
            }
        ],
        payload,
        test=True,
    )
    return {"results": results}
