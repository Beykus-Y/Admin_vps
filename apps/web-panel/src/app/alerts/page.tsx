"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { AlertChannel, AlertIncident, AlertRule, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDateTime, formatNumber, formatRelativeTime, severityLabel, statusLabel } from "@/lib/format";
import { useLiveReload } from "@/lib/live";
import { Card, Pill, SoftButton, StatCard } from "@/components/ui";

const EMPTY_CHANNEL_FORM = {
  id: "",
  name: "",
  type: "webhook",
  enabled: true,
  send_resolved: true,
  severities: ["critical", "warning"],
  configText: '{\n  "url": ""\n}',
};

function SeverityPills({ values, onToggle, disabled }: { values: string[]; onToggle: (value: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {["critical", "warning", "info"].map((severity) => {
        const active = values.includes(severity);
        return (
          <button
            key={severity}
            type="button"
            onClick={() => onToggle(severity)}
            disabled={disabled}
            className={`rounded-md border px-2 py-1 text-xs font-semibold transition ${active ? "border-[#4ade80] bg-[#4ade80] text-[#06110a]" : "border-[#1d2135] text-[#4a5170] hover:text-[#dde2f0]"} disabled:opacity-50`}
          >
            {severityLabel(severity)}
          </button>
        );
      })}
    </div>
  );
}

export default function AlertsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [incidents, setIncidents] = useState<AlertIncident[]>([]);
  const [channels, setChannels] = useState<AlertChannel[]>([]);
  const [thresholdDrafts, setThresholdDrafts] = useState<Record<string, string>>({});
  const [channelForm, setChannelForm] = useState(EMPTY_CHANNEL_FORM);
  const [loading, setLoading] = useState(true);
  const [savingRule, setSavingRule] = useState<string | null>(null);
  const [savingChannel, setSavingChannel] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const canOperate = user?.role === "admin" || user?.role === "operator";
  const canAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    try {
      const [rulesData, incidentsData, channelsData] = await Promise.all([
        api.alerts.rules(),
        api.alerts.incidents({ status: "active", limit: 200 }),
        canAdmin ? api.alerts.channels() : Promise.resolve([] as AlertChannel[]),
      ]);
      setRules(rulesData);
      setIncidents(incidentsData);
      setChannels(channelsData);
      setThresholdDrafts(Object.fromEntries(rulesData.map((rule) => [rule.id, rule.threshold != null ? String(rule.threshold) : ""])));
      setError("");
    } catch (err: unknown) {
      const value = err instanceof Error ? err.message : "Не удалось загрузить алерты";
      if (value.includes("401")) router.push("/login");
      else setError(value);
    } finally {
      setLoading(false);
    }
  }, [canAdmin, router]);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveReload(!loading, load);

  const activeRules = rules.filter((rule) => rule.enabled).length;
  const triggered = incidents.length;
  const critical = incidents.filter((incident) => incident.severity === "critical").length;
  const outdatedRules = rules.filter((rule) => rule.kind === "agent.outdated" && rule.enabled).length;
  const bySeverity = useMemo(
    () => ({
      critical: incidents.filter((incident) => incident.severity === "critical").length,
      warning: incidents.filter((incident) => incident.severity === "warning").length,
      info: incidents.filter((incident) => incident.severity === "info").length,
    }),
    [incidents]
  );

  async function toggleRule(rule: AlertRule) {
    setSavingRule(rule.id);
    try {
      await api.alerts.updateRule(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось обновить правило");
    } finally {
      setSavingRule(null);
    }
  }

  async function saveRule(rule: AlertRule) {
    setSavingRule(rule.id);
    try {
      const draft = thresholdDrafts[rule.id];
      await api.alerts.updateRule(rule.id, {
        threshold: draft === "" ? null : Number(draft),
      });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить порог");
    } finally {
      setSavingRule(null);
    }
  }

  async function acknowledge(incident: AlertIncident) {
    await api.alerts.acknowledgeIncident(incident.id);
    await load();
  }

  async function silence(incident: AlertIncident) {
    const value = window.prompt("Сколько минут держать инцидент приглушённым?", "60");
    if (!value) return;
    await api.alerts.silenceIncident(incident.id, Number(value));
    await load();
  }

  function beginEditChannel(channel: AlertChannel) {
    setChannelForm({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled,
      send_resolved: channel.send_resolved,
      severities: channel.severities,
      configText: JSON.stringify(channel.config, null, 2),
    });
  }

  function resetChannelForm() {
    setChannelForm(EMPTY_CHANNEL_FORM);
  }

  async function saveChannel() {
    setSavingChannel(true);
    setMessage(null);
    try {
      const config = JSON.parse(channelForm.configText);
      const payload = {
        name: channelForm.name,
        type: channelForm.type as "webhook" | "telegram" | "email",
        enabled: channelForm.enabled,
        send_resolved: channelForm.send_resolved,
        severities: channelForm.severities,
        config,
      };
      if (channelForm.id) {
        await api.alerts.updateChannel(channelForm.id, payload);
      } else {
        await api.alerts.createChannel(payload);
      }
      resetChannelForm();
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить канал");
    } finally {
      setSavingChannel(false);
    }
  }

  async function testChannel(id: string) {
    const res = await api.alerts.testChannel(id);
    const first = res.results[0];
    setMessage(first?.status === "ok" ? "Тестовое уведомление отправлено" : first?.error || "Тест не удался");
  }

  async function deleteChannel(id: string) {
    if (!window.confirm("Удалить канал уведомлений?")) return;
    await api.alerts.deleteChannel(id);
    if (channelForm.id === id) resetChannelForm();
    await load();
  }

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Правил" value={formatNumber(rules.length)} sub="серверные правила" color="#dde2f0" />
          <StatCard label="Активных" value={formatNumber(activeRules)} sub="включены сейчас" color="#4ade80" />
          <StatCard label="Инцидентов" value={formatNumber(triggered)} sub={triggered ? "нужна реакция" : "нет"} color={triggered ? "#fbbf24" : "#4ade80"} />
          <StatCard label="Критично" value={formatNumber(critical)} sub={critical ? "срочно" : "нет"} color={critical ? "#f87171" : "#4ade80"} />
          <StatCard label="Устаревший агент" value={formatNumber(outdatedRules)} sub="правил включено" color="#38bdf8" />
        </div>

        {(error || message) && (
          <Card className={`p-3 font-mono text-xs ${error ? "text-[#f87171]" : "text-[#4ade80]"}`}>
            {error || message}
          </Card>
        )}

        {loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю правила и инциденты...</div>
        ) : (
          <>
            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <Card className="overflow-hidden">
                <div className="border-b border-[#1a1d2e] px-4 py-3">
                  <div className="text-sm font-semibold text-[#e8eaf6]">Активные инциденты</div>
                  <div className="mt-1 font-mono text-[10px] text-[#4a5170]">critical {bySeverity.critical} · warning {bySeverity.warning} · info {bySeverity.info}</div>
                </div>
                <div className="divide-y divide-[#0f1218]">
                  {incidents.length === 0 ? (
                    <div className="p-8 text-center font-mono text-xs text-[#2a3355]">Открытых инцидентов нет</div>
                  ) : incidents.map((incident) => (
                    <div key={incident.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Pill color={incident.severity === "critical" ? "red" : incident.severity === "warning" ? "yellow" : "blue"}>{severityLabel(incident.severity)}</Pill>
                          <Pill color="gray">{statusLabel(incident.status)}</Pill>
                          <span className="truncate text-sm font-semibold text-[#e8eaf6]">{incident.rule_name}</span>
                          {incident.node_id && <Link href={`/nodes/${incident.node_id}`} className="text-xs text-[#818cf8] hover:text-[#a5b4fc]">{incident.node_name}</Link>}
                        </div>
                        <div className="mt-2 font-mono text-xs text-[#8892b0]">{incident.message}</div>
                        <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-[#4a5170]">
                          <span>старт {formatDateTime(incident.started_at)}</span>
                          <span>виден {formatRelativeTime(incident.last_seen_at)}</span>
                          {incident.silenced_until && <span>до {formatDateTime(incident.silenced_until)}</span>}
                        </div>
                      </div>
                      {canOperate && (
                        <div className="flex shrink-0 gap-2">
                          {incident.status !== "acknowledged" && (
                            <SoftButton onClick={() => void acknowledge(incident)} variant="blue">Подтвердить</SoftButton>
                          )}
                          <SoftButton onClick={() => void silence(incident)} variant="ghost">Приглушить</SoftButton>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <div className="mb-4 text-sm font-semibold text-[#e8eaf6]">Правила</div>
                <div className="space-y-3">
                  {rules.map((rule) => (
                    <div key={rule.id} className={`rounded-lg border p-3 ${rule.enabled ? "border-[#1d2135] bg-[#0c0e16]" : "border-[#141722] bg-[#0a0c13] opacity-70"}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#e8eaf6]">{rule.name}</div>
                          <div className="mt-1 font-mono text-[10px] text-[#4a5170]">{rule.description}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void toggleRule(rule)}
                          disabled={!canAdmin || savingRule === rule.id}
                          className={`relative h-5 w-9 rounded-full transition ${rule.enabled ? "bg-[#4ade80]" : "bg-[#1d2135]"} disabled:opacity-50`}
                        >
                          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${rule.enabled ? "left-[18px]" : "left-0.5"}`} />
                        </button>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <Pill color={rule.severity === "critical" ? "red" : rule.severity === "warning" ? "yellow" : "blue"}>{severityLabel(rule.severity)}</Pill>
                        {rule.threshold != null && (
                          <>
                            <input
                              value={thresholdDrafts[rule.id] ?? ""}
                              onChange={(event) => setThresholdDrafts((prev) => ({ ...prev, [rule.id]: event.target.value }))}
                              disabled={!canAdmin}
                              className="w-24 rounded-md border border-[#1d2135] bg-[#111420] px-2 py-1 font-mono text-xs text-[#dde2f0] outline-none disabled:opacity-50"
                            />
                            {canAdmin && <SoftButton onClick={() => void saveRule(rule)} disabled={savingRule === rule.id} variant="ghost">Сохранить</SoftButton>}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>

            {canAdmin && (
              <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <Card className="p-4">
                  <div className="mb-4 text-sm font-semibold text-[#e8eaf6]">{channelForm.id ? "Редактирование канала" : "Новый канал"}</div>
                  <div className="space-y-3">
                    <label className="block">
                      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">Имя</span>
                      <input value={channelForm.name} onChange={(event) => setChannelForm((prev) => ({ ...prev, name: event.target.value }))} className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2 text-sm text-[#dde2f0] outline-none" />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">Тип</span>
                        <select value={channelForm.type} onChange={(event) => setChannelForm((prev) => ({ ...prev, type: event.target.value }))} className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2 text-sm text-[#dde2f0] outline-none">
                          <option value="webhook">webhook</option>
                          <option value="telegram">telegram</option>
                          <option value="email">email</option>
                        </select>
                      </label>
                      <div className="flex items-end gap-6 pb-1">
                        <label className="flex items-center gap-2 text-xs text-[#8892b0]"><input type="checkbox" checked={channelForm.enabled} onChange={(event) => setChannelForm((prev) => ({ ...prev, enabled: event.target.checked }))} /> enabled</label>
                        <label className="flex items-center gap-2 text-xs text-[#8892b0]"><input type="checkbox" checked={channelForm.send_resolved} onChange={(event) => setChannelForm((prev) => ({ ...prev, send_resolved: event.target.checked }))} /> resolved</label>
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">Уровни</div>
                      <SeverityPills
                        values={channelForm.severities}
                        onToggle={(severity) =>
                          setChannelForm((prev) => ({
                            ...prev,
                            severities: prev.severities.includes(severity) ? prev.severities.filter((item) => item !== severity) : [...prev.severities, severity],
                          }))
                        }
                      />
                    </div>
                    <label className="block">
                      <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">Config JSON</span>
                      <textarea value={channelForm.configText} onChange={(event) => setChannelForm((prev) => ({ ...prev, configText: event.target.value }))} rows={10} className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2 font-mono text-xs text-[#dde2f0] outline-none" />
                    </label>
                    <div className="flex gap-2">
                      <SoftButton onClick={() => void saveChannel()} disabled={savingChannel} variant="primary">Сохранить</SoftButton>
                      <SoftButton onClick={resetChannelForm} variant="ghost">Сбросить</SoftButton>
                    </div>
                  </div>
                </Card>

                <Card className="overflow-hidden">
                  <div className="border-b border-[#1a1d2e] px-4 py-3">
                    <div className="text-sm font-semibold text-[#e8eaf6]">Каналы уведомлений</div>
                  </div>
                  <div className="divide-y divide-[#0f1218]">
                    {channels.length === 0 ? (
                      <div className="p-8 text-center font-mono text-xs text-[#2a3355]">Каналы пока не настроены</div>
                    ) : channels.map((channel) => (
                      <div key={channel.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-[#e8eaf6]">{channel.name}</span>
                            <Pill color="gray">{channel.type}</Pill>
                            <Pill color={channel.enabled ? "green" : "red"}>{channel.enabled ? "enabled" : "disabled"}</Pill>
                          </div>
                          <div className="mt-2 font-mono text-[10px] text-[#4a5170]">
                            {channel.severities.join(", ")} · updated {formatDateTime(channel.updated_at)}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <SoftButton onClick={() => beginEditChannel(channel)} variant="ghost">Изменить</SoftButton>
                          <SoftButton onClick={() => void testChannel(channel.id)} variant="blue">Тест</SoftButton>
                          <SoftButton onClick={() => void deleteChannel(channel.id)} variant="danger">Удалить</SoftButton>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
