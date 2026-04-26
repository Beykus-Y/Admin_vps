"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ChevronDown, ChevronUp, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import Layout from "@/components/Layout";
import { Card, Pill, SearchBar, SectionTitle, SoftButton, StatCard } from "@/components/ui";
import {
  api,
  SubProxyNamedConfig,
  SubProxyNodeFilter,
  SubProxySettings,
  SubProxyStatus,
  SubProxyStoredConfig,
  SubProxyUserDetails,
  SubProxyUserSummary,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatBytes, formatDateTime, formatFullDateTime, formatNumber, formatRelativeTime } from "@/lib/format";
import { buildNodeGroups, subscriptionStatusColor, subscriptionStatusLabel } from "@/lib/subproxy";

type UserFilter = "all" | "filtered" | "extra";
type Notice = { type: "ok" | "err"; message: string } | null;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">{label}</span>
      {children}
    </label>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      type={type}
      disabled={disabled}
      className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70 disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}

function unixToIso(value: number | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function limitLabel(bytes: number | null | undefined): string {
  if (!bytes) return "∞";
  return formatBytes(bytes);
}

function expiryBadge(expire: number | null | undefined) {
  const iso = unixToIso(expire);
  if (!iso) return <Pill color="gray">без срока</Pill>;

  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return <Pill color="red">истёк</Pill>;
  const days = Math.ceil(diff / 86_400_000);
  if (days <= 3) return <Pill color="yellow">{days}д</Pill>;
  return <Pill color="green">{days}д</Pill>;
}

function statusDot(status: string) {
  return subscriptionStatusColor(status);
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "operator";

  const [status, setStatus] = useState<SubProxyStatus | null>(null);
  const [users, setUsers] = useState<SubProxyUserSummary[]>([]);
  const [globalConfigs, setGlobalConfigs] = useState<SubProxyStoredConfig[]>([]);
  const [perUserConfigsMap, setPerUserConfigsMap] = useState<Record<string, SubProxyNamedConfig[]>>({});
  const [nodeFilters, setNodeFilters] = useState<Record<string, SubProxyNodeFilter>>({});
  const [settings, setSettings] = useState<SubProxySettings>({ sub_update_interval: null });
  const [settingsInput, setSettingsInput] = useState("");
  const [selectedUsername, setSelectedUsername] = useState("");
  const [selectedDetails, setSelectedDetails] = useState<SubProxyUserDetails | null>(null);
  const [draftFilter, setDraftFilter] = useState<SubProxyNodeFilter>({ all: true, allowed_configs: [] });
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [userFilter, setUserFilter] = useState<UserFilter>("all");
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailsError, setDetailsError] = useState("");
  const [savingFilters, setSavingFilters] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingGlobalConfig, setSavingGlobalConfig] = useState(false);
  const [savingPerUserConfig, setSavingPerUserConfig] = useState(false);
  const [newGlobalName, setNewGlobalName] = useState("");
  const [newGlobalUri, setNewGlobalUri] = useState("");
  const [newGlobalEnabled, setNewGlobalEnabled] = useState(true);
  const [newPerUserName, setNewPerUserName] = useState("");
  const [newPerUserUri, setNewPerUserUri] = useState("");

  const loadAll = useCallback(async (initial = false) => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }

    if (initial) setLoading(true);
    else setRefreshing(true);

    try {
      const [statusData, usersData, configsData, perUserData, nodeFilterData, settingsData] = await Promise.all([
        api.subProxy.status(),
        api.subProxy.users({ limit: 500 }),
        api.subProxy.configs(),
        api.subProxy.perUserConfigs(),
        api.subProxy.nodeFilters(),
        api.subProxy.settings(),
      ]);

      setStatus(statusData);
      setUsers(usersData.items);
      setGlobalConfigs(configsData);
      setPerUserConfigsMap(perUserData);
      setNodeFilters(nodeFilterData);
      setSettings(settingsData);
      setSettingsInput(settingsData.sub_update_interval == null ? "" : String(settingsData.sub_update_interval));
      setSelectedUsername((current) => {
        if (current && usersData.items.some((item) => item.username === current)) return current;
        return usersData.items[0]?.username ?? "";
      });
      setError("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Не удалось загрузить модуль подписок";
      if (/invalid token|unauthorized|not authenticated/i.test(message)) {
        router.push("/login");
        return;
      }
      setError(message);
    } finally {
      if (initial) setLoading(false);
      else setRefreshing(false);
    }
  }, [router]);

  const loadUserDetails = useCallback(async (username: string) => {
    if (!username) {
      setSelectedDetails(null);
      setDetailsError("");
      return;
    }

    setDetailsLoading(true);
    try {
      const details = await api.subProxy.userDetails(username);
      setSelectedDetails(details);
      setDraftFilter({
        all: details.node_filter.all,
        allowed_configs: [...details.node_filter.allowed_configs],
      });
      setDetailsError("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `Не удалось загрузить пользователя ${username}`;
      setSelectedDetails(null);
      setDetailsError(message);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  useEffect(() => {
    void loadUserDetails(selectedUsername);
  }, [loadUserDetails, selectedUsername]);

  useEffect(() => {
    setNewPerUserName("");
    setNewPerUserUri("");
  }, [selectedUsername]);

  const filteredUsers = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return users.filter((item) => {
      if (userFilter === "filtered" && !item.proxy_filtered) return false;
      if (userFilter === "extra" && item.proxy_extra_configs < 1) return false;
      if (!query) return true;
      return [item.username, item.note, item.sub_last_user_agent]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [deferredSearch, userFilter, users]);

  const nodeGroups = useMemo(() => {
    if (!selectedDetails || !status) return [];
    return buildNodeGroups(selectedDetails.user.links || [], status.nodes);
  }, [selectedDetails, status]);

  const allFragments = useMemo(() => nodeGroups.flatMap((group) => group.fragments), [nodeGroups]);
  const allowedSet = useMemo(() => new Set(draftFilter.allowed_configs), [draftFilter.allowed_configs]);

  const selectedPerUserConfigs = selectedUsername ? (perUserConfigsMap[selectedUsername] ?? []) : [];
  const onlineNodes = status?.nodes.filter((node) => node.status === "connected").length ?? 0;
  const reachable = status?.marzban.reachable ?? false;

  function showSuccess(message: string) {
    setNotice({ type: "ok", message });
  }

  function showError(message: string) {
    setNotice({ type: "err", message });
  }

  async function refreshAll() {
    await loadAll(false);
    if (selectedUsername) await loadUserDetails(selectedUsername);
  }

  async function mutatePerUserConfigs(nextMap: Record<string, SubProxyNamedConfig[]>, successMessage: string) {
    setSavingPerUserConfig(true);
    try {
      await api.subProxy.savePerUserConfigs(nextMap);
      setPerUserConfigsMap(nextMap);
      showSuccess(successMessage);
      await loadAll(false);
      if (selectedUsername) await loadUserDetails(selectedUsername);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось сохранить per-user конфиги");
    } finally {
      setSavingPerUserConfig(false);
    }
  }

  async function mutateGlobalConfigs(nextConfigs: SubProxyStoredConfig[], successMessage: string) {
    setSavingGlobalConfig(true);
    try {
      await api.subProxy.reorderConfigs(nextConfigs.map((config) => ({
        id: config.id,
        name: config.name,
        uri: config.uri,
        enabled: config.enabled,
      })));
      setGlobalConfigs(nextConfigs);
      showSuccess(successMessage);
      await loadAll(false);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось сохранить global конфиги");
    } finally {
      setSavingGlobalConfig(false);
    }
  }

  async function addGlobalConfig() {
    if (!newGlobalUri.trim()) {
      showError("URI глобального конфига обязателен");
      return;
    }
    setSavingGlobalConfig(true);
    try {
      await api.subProxy.createConfig({
        name: newGlobalName.trim() || undefined,
        uri: newGlobalUri.trim(),
        enabled: newGlobalEnabled,
      });
      setNewGlobalName("");
      setNewGlobalUri("");
      setNewGlobalEnabled(true);
      showSuccess("Глобальный extra-конфиг добавлен");
      await loadAll(false);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось добавить global конфиг");
    } finally {
      setSavingGlobalConfig(false);
    }
  }

  async function deleteGlobalConfig(config: SubProxyStoredConfig) {
    if (!window.confirm(`Удалить конфиг "${config.name}"?`)) return;
    setSavingGlobalConfig(true);
    try {
      await api.subProxy.deleteConfig(config.id);
      showSuccess("Глобальный extra-конфиг удалён");
      await loadAll(false);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось удалить global конфиг");
    } finally {
      setSavingGlobalConfig(false);
    }
  }

  async function addPerUserConfig() {
    if (!selectedUsername) return;
    if (!newPerUserUri.trim()) {
      showError("URI персонального конфига обязателен");
      return;
    }
    const nextMap = {
      ...perUserConfigsMap,
      [selectedUsername]: [
        ...(perUserConfigsMap[selectedUsername] ?? []),
        {
          name: newPerUserName.trim() || newPerUserUri.trim().slice(0, 30),
          uri: newPerUserUri.trim(),
          enabled: true,
        },
      ],
    };
    setNewPerUserName("");
    setNewPerUserUri("");
    await mutatePerUserConfigs(nextMap, `Конфиг для ${selectedUsername} добавлен`);
  }

  async function togglePerUserConfig(index: number) {
    if (!selectedUsername) return;
    const nextConfigs = [...selectedPerUserConfigs];
    nextConfigs[index] = { ...nextConfigs[index], enabled: !nextConfigs[index].enabled };
    const nextMap = { ...perUserConfigsMap, [selectedUsername]: nextConfigs };
    await mutatePerUserConfigs(nextMap, `Конфиги пользователя ${selectedUsername} обновлены`);
  }

  async function deletePerUserConfig(index: number) {
    if (!selectedUsername) return;
    const nextConfigs = selectedPerUserConfigs.filter((_, current) => current !== index);
    const nextMap = { ...perUserConfigsMap };
    if (nextConfigs.length > 0) nextMap[selectedUsername] = nextConfigs;
    else delete nextMap[selectedUsername];
    await mutatePerUserConfigs(nextMap, `Конфиги пользователя ${selectedUsername} обновлены`);
  }

  function toggleAllFilters(enabled: boolean) {
    if (enabled) {
      setDraftFilter({ all: true, allowed_configs: [] });
      return;
    }
    setDraftFilter({ all: false, allowed_configs: [...allFragments] });
  }

  function toggleGroup(groupFragments: string[], enabled: boolean) {
    const next = new Set(allowedSet);
    groupFragments.forEach((fragment) => {
      if (enabled) next.add(fragment);
      else next.delete(fragment);
    });
    setDraftFilter({ all: false, allowed_configs: Array.from(next) });
  }

  function toggleFragment(fragment: string, enabled: boolean) {
    const next = new Set(allowedSet);
    if (enabled) next.add(fragment);
    else next.delete(fragment);
    setDraftFilter({ all: false, allowed_configs: Array.from(next) });
  }

  async function saveNodeFilter() {
    if (!selectedUsername) return;
    setSavingFilters(true);
    try {
      const nextMap = { ...nodeFilters };
      const normalizedAllowed = Array.from(new Set(draftFilter.allowed_configs));
      const allSelected = allFragments.length > 0 && allFragments.every((fragment) => normalizedAllowed.includes(fragment));
      if (draftFilter.all || allSelected || allFragments.length === 0) {
        delete nextMap[selectedUsername];
      } else {
        nextMap[selectedUsername] = { all: false, allowed_configs: normalizedAllowed };
      }
      await api.subProxy.saveNodeFilters(nextMap);
      setNodeFilters(nextMap);
      showSuccess(`Фильтр пользователя ${selectedUsername} сохранён`);
      await loadAll(false);
      await loadUserDetails(selectedUsername);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось сохранить фильтр нод");
    } finally {
      setSavingFilters(false);
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const raw = settingsInput.trim();
      if (raw !== "") {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isNaN(parsed) || parsed < 1 || parsed > 168) {
          showError("Интервал должен быть числом от 1 до 168 часов");
          return;
        }
      }
      const payload: SubProxySettings = {
        sub_update_interval: raw === "" ? null : Number.parseInt(raw, 10),
      };
      await api.subProxy.saveSettings(payload);
      setSettings(payload);
      showSuccess("Настройки Sub Proxy сохранены");
      await loadAll(false);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось сохранить настройки");
    } finally {
      setSavingSettings(false);
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="p-6 font-mono text-sm text-[#4a5170]">Подключаю модуль подписок...</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        {error && (
          <Card className="border-[#f87171]/20 bg-[#f87171]/[0.07] p-4 font-mono text-xs text-[#f87171]">
            {error}
          </Card>
        )}
        {notice && (
          <Card className={clsx(
            "p-4 font-mono text-xs",
            notice.type === "ok"
              ? "border-[#4ade80]/20 bg-[#4ade80]/[0.07] text-[#4ade80]"
              : "border-[#f87171]/20 bg-[#f87171]/[0.07] text-[#f87171]"
          )}>
            {notice.message}
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <StatCard label="Пользователи" value={formatNumber(users.length)} sub={reachable ? "Marzban доступен" : "Marzban недоступен"} color={reachable ? "#4ade80" : "#f87171"} />
          <StatCard label="Активны" value={formatNumber(users.filter((item) => item.status === "active").length)} sub="по данным Marzban" color="#38bdf8" />
          <StatCard label="С фильтром" value={formatNumber(status?.counts.filtered_users ?? 0)} sub="режим частичной подписки" color="#fbbf24" />
          <StatCard label="Extra конфиги" value={formatNumber(status?.counts.per_user_configs ?? 0)} sub={`${status?.counts.global_enabled_configs ?? 0} глобально включено`} color="#818cf8" />
          <StatCard label="Ноды" value={formatNumber(status?.nodes.length ?? 0)} sub={`${onlineNodes} онлайн`} color={onlineNodes > 0 ? "#4ade80" : "#4a5170"} />
        </div>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setUserFilter("all")}
              className={clsx("rounded-md border px-3 py-1.5 text-xs font-semibold transition", userFilter === "all" ? "border-[#4ade80] bg-[#4ade80] text-[#06110a]" : "border-[#1d2135] text-[#4a5170] hover:border-[#2a3355] hover:text-[#dde2f0]")}
            >
              Все
            </button>
            <button
              onClick={() => setUserFilter("filtered")}
              className={clsx("rounded-md border px-3 py-1.5 text-xs font-semibold transition", userFilter === "filtered" ? "border-[#fbbf24] bg-[#fbbf24] text-[#11110a]" : "border-[#1d2135] text-[#4a5170] hover:border-[#2a3355] hover:text-[#dde2f0]")}
            >
              С фильтром
            </button>
            <button
              onClick={() => setUserFilter("extra")}
              className={clsx("rounded-md border px-3 py-1.5 text-xs font-semibold transition", userFilter === "extra" ? "border-[#818cf8] bg-[#818cf8] text-[#0b1020]" : "border-[#1d2135] text-[#4a5170] hover:border-[#2a3355] hover:text-[#dde2f0]")}
            >
              С extra
            </button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row xl:ml-auto">
            <SearchBar value={search} onChange={setSearch} placeholder="Поиск по username, заметке, клиенту..." className="sm:w-96" />
            <SoftButton onClick={refreshAll} disabled={refreshing} variant="blue">
              {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              Обновить
            </SoftButton>
          </div>
        </div>

        <div className="grid gap-4 2xl:grid-cols-[420px_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#1a1d2e] px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-[#e8eaf6]">Пользователи подписок</div>
                <div className="mt-1 font-mono text-[10px] text-[#4a5170]">{formatNumber(filteredUsers.length)} из {formatNumber(users.length)}</div>
              </div>
              <Pill color={reachable ? "green" : "red"}>{reachable ? "proxy online" : "proxy issue"}</Pill>
            </div>
            <div className="max-h-[820px] overflow-y-auto">
              {filteredUsers.length === 0 ? (
                <div className="p-8 text-center font-mono text-xs text-[#2a3355]">Пользователи не найдены</div>
              ) : filteredUsers.map((item) => {
                const selected = item.username === selectedUsername;
                const expireIso = unixToIso(item.expire);
                return (
                  <button
                    key={item.username}
                    onClick={() => setSelectedUsername(item.username)}
                    className={clsx(
                      "w-full border-b border-[#0f1218] px-4 py-3 text-left transition hover:bg-[#141722]",
                      selected && "bg-[#141722]"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-[#e8eaf6]">{item.username}</span>
                          <Pill color={statusDot(item.status)}>{subscriptionStatusLabel(item.status)}</Pill>
                          {item.proxy_filtered && <Pill color="yellow">фильтр</Pill>}
                          {item.proxy_extra_configs > 0 && <Pill color="purple">+{item.proxy_extra_configs}</Pill>}
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-[#4a5170]">
                          {formatBytes(item.used_traffic)} / {limitLabel(item.data_limit)} · {expireIso ? formatDateTime(expireIso) : "без срока"}
                        </div>
                        {item.sub_last_user_agent && (
                          <div className="mt-2 truncate font-mono text-[10px] text-[#2a3355]">
                            {item.sub_last_user_agent}
                          </div>
                        )}
                      </div>
                      <div className="shrink-0 text-right font-mono text-[10px] text-[#2a3355]">
                        <div>{formatRelativeTime(item.online_at)}</div>
                        <div className="mt-2">{expiryBadge(item.expire)}</div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          <div className="space-y-4">
            <Card className="p-4">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-bold text-[#e8eaf6]">{selectedUsername || "Пользователь не выбран"}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#2a3355]">sub_proxy user detail</div>
                </div>
                {selectedDetails && <Pill color={subscriptionStatusColor(selectedDetails.user.status)}>{subscriptionStatusLabel(selectedDetails.user.status)}</Pill>}
              </div>

              {detailsLoading ? (
                <div className="font-mono text-sm text-[#4a5170]">Загружаю детали пользователя...</div>
              ) : detailsError ? (
                <div className="font-mono text-xs text-[#f87171]">{detailsError}</div>
              ) : !selectedDetails ? (
                <div className="font-mono text-xs text-[#2a3355]">Выбери пользователя слева</div>
              ) : (
                <div className="space-y-5">
                  <div className="grid gap-3 md:grid-cols-3">
                    <Card className="bg-[#0c0e16] p-3">
                      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Трафик</div>
                      <div className="mt-1 text-lg font-bold text-[#38bdf8]">{formatBytes(selectedDetails.user.used_traffic)}</div>
                    </Card>
                    <Card className="bg-[#0c0e16] p-3">
                      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Лимит</div>
                      <div className="mt-1 text-lg font-bold text-[#fbbf24]">{limitLabel(selectedDetails.user.data_limit)}</div>
                    </Card>
                    <Card className="bg-[#0c0e16] p-3">
                      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Истекает</div>
                      <div className="mt-1 text-lg font-bold text-[#4ade80]">{selectedDetails.user.expire ? formatDateTime(unixToIso(selectedDetails.user.expire)) : "без срока"}</div>
                    </Card>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                    <div>
                      <SectionTitle>Фильтр Конфигов</SectionTitle>
                      <Card className="space-y-3 bg-[#0c0e16] p-4">
                        <label className="flex items-center gap-3 text-sm text-[#dde2f0]">
                          <input
                            type="checkbox"
                            checked={draftFilter.all}
                            disabled={!canEdit}
                            onChange={(event) => toggleAllFilters(event.target.checked)}
                            className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                          />
                          Все конфиги без ограничений
                        </label>

                        {nodeGroups.length === 0 ? (
                          <div className="font-mono text-xs text-[#2a3355]">В текущей подписке нет конфигов, подходящих под фильтрацию.</div>
                        ) : (
                          <div className={clsx("space-y-3", draftFilter.all && "opacity-45 pointer-events-none")}>
                            {nodeGroups.map((group) => {
                              const groupChecked = group.fragments.every((fragment) => allowedSet.has(fragment));
                              return (
                                <div key={group.host} className="rounded-lg border border-[#1d2135] bg-[#111420]">
                                  <div className="flex items-center gap-3 border-b border-[#1a1d2e] px-3 py-2">
                                    <input
                                      type="checkbox"
                                      checked={groupChecked}
                                      disabled={!canEdit}
                                      onChange={(event) => toggleGroup(group.fragments, event.target.checked)}
                                      className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-sm font-semibold text-[#e8eaf6]">{group.nodeName ?? "Неизвестная нода"}</div>
                                      <div className="truncate font-mono text-[10px] text-[#2a3355]">{group.host}</div>
                                    </div>
                                    <Pill color="gray">{group.fragments.length} конф.</Pill>
                                  </div>
                                  <div className="grid gap-2 px-3 py-3 md:grid-cols-2">
                                    {group.fragments.map((fragment) => {
                                      const checked = allowedSet.has(fragment);
                                      return (
                                        <label key={fragment} className="flex items-center gap-2 rounded-md bg-[#0c0e16] px-3 py-2 text-xs text-[#8892b0]">
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            disabled={!canEdit}
                                            onChange={(event) => toggleFragment(fragment, event.target.checked)}
                                            className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                                          />
                                          <span className="truncate">{fragment}</span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {canEdit && (
                          <SoftButton onClick={saveNodeFilter} disabled={savingFilters} variant="yellow">
                            {savingFilters ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                            Сохранить фильтр
                          </SoftButton>
                        )}
                      </Card>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <SectionTitle>Трафик По Нодам</SectionTitle>
                        <Card className="bg-[#0c0e16] p-4">
                          {selectedDetails.usage.usages?.length ? (
                            <div className="space-y-2">
                              {selectedDetails.usage.usages.map((row) => (
                                <div key={`${row.node_id ?? "none"}-${row.node_name}`} className="rounded-lg border border-[#1a1d2e] bg-[#111420] px-3 py-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <span className="truncate text-sm text-[#dde2f0]">{row.node_name}</span>
                                    <span className="font-mono text-xs text-[#38bdf8]">{formatBytes(row.used_traffic)}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="font-mono text-xs text-[#2a3355]">Нет usage-данных по нодам.</div>
                          )}
                        </Card>
                      </div>

                      <div>
                        <SectionTitle>История Устройств</SectionTitle>
                        <Card className="bg-[#0c0e16] p-4">
                          {selectedDetails.device_history.length ? (
                            <div className="space-y-2">
                              {selectedDetails.device_history.map((item, index) => (
                                <div key={`${item.ip ?? "ip"}-${item.timestamp}-${index}`} className="rounded-lg border border-[#1a1d2e] bg-[#111420] px-3 py-2">
                                  <div className="truncate text-xs text-[#dde2f0]">{item.user_agent || "unknown user-agent"}</div>
                                  <div className="mt-1 flex items-center justify-between gap-3 font-mono text-[10px] text-[#2a3355]">
                                    <span>{item.ip || "ip неизвестен"}</span>
                                    <span>{formatFullDateTime(new Date(item.timestamp * 1000).toISOString())}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="font-mono text-xs text-[#2a3355]">История устройств пока пуста.</div>
                          )}
                        </Card>
                      </div>
                    </div>
                  </div>

                  <div>
                    <SectionTitle>Per-User Extra Конфиги</SectionTitle>
                    <Card className="space-y-4 bg-[#0c0e16] p-4">
                      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
                        <Field label="Имя">
                          <TextInput value={newPerUserName} onChange={setNewPerUserName} placeholder="Например: backup link" disabled={!canEdit} />
                        </Field>
                        <Field label="URI">
                          <TextInput value={newPerUserUri} onChange={setNewPerUserUri} placeholder="vless://...#backup" disabled={!canEdit} />
                        </Field>
                        <div className="flex items-end">
                          <SoftButton onClick={addPerUserConfig} disabled={!canEdit || savingPerUserConfig} variant="primary" className="w-full lg:w-auto">
                            {savingPerUserConfig ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                            Добавить
                          </SoftButton>
                        </div>
                      </div>

                      {selectedPerUserConfigs.length === 0 ? (
                        <div className="font-mono text-xs text-[#2a3355]">Для пользователя пока нет extra-конфигов.</div>
                      ) : (
                        <div className="space-y-2">
                          {selectedPerUserConfigs.map((config, index) => (
                            <div key={`${config.uri}-${index}`} className="flex items-start gap-3 rounded-lg border border-[#1a1d2e] bg-[#111420] px-3 py-3">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-sm font-semibold text-[#e8eaf6]">{config.name}</span>
                                  <Pill color={config.enabled ? "green" : "red"}>{config.enabled ? "вкл" : "выкл"}</Pill>
                                </div>
                                <div className="mt-1 truncate font-mono text-[10px] text-[#2a3355]">{config.uri}</div>
                              </div>
                              {canEdit && (
                                <div className="flex shrink-0 items-center gap-2">
                                  <SoftButton onClick={() => togglePerUserConfig(index)} disabled={savingPerUserConfig} variant="blue">
                                    {config.enabled ? "Выключить" : "Включить"}
                                  </SoftButton>
                                  <SoftButton onClick={() => deletePerUserConfig(index)} disabled={savingPerUserConfig} variant="danger">
                                    <Trash2 size={14} />
                                  </SoftButton>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  </div>
                </div>
              )}
            </Card>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div>
                <SectionTitle>Global Extra Конфиги</SectionTitle>
                <Card className="space-y-4 p-4">
                  <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto_auto]">
                    <Field label="Имя">
                      <TextInput value={newGlobalName} onChange={setNewGlobalName} placeholder="Например: hysteria fallback" disabled={!canEdit} />
                    </Field>
                    <Field label="URI">
                      <TextInput value={newGlobalUri} onChange={setNewGlobalUri} placeholder="hysteria2://...#global" disabled={!canEdit} />
                    </Field>
                    <label className="flex items-end gap-2 pb-2 text-sm text-[#8892b0]">
                      <input
                        type="checkbox"
                        checked={newGlobalEnabled}
                        disabled={!canEdit}
                        onChange={(event) => setNewGlobalEnabled(event.target.checked)}
                        className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                      />
                      enabled
                    </label>
                    <div className="flex items-end">
                      <SoftButton onClick={addGlobalConfig} disabled={!canEdit || savingGlobalConfig} variant="primary" className="w-full lg:w-auto">
                        {savingGlobalConfig ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                        Добавить
                      </SoftButton>
                    </div>
                  </div>

                  {globalConfigs.length === 0 ? (
                    <div className="font-mono text-xs text-[#2a3355]">Глобальные extra-конфиги ещё не добавлены.</div>
                  ) : (
                    <div className="space-y-2">
                      {globalConfigs.map((config, index) => (
                        <div key={config.id} className="flex items-start gap-3 rounded-lg border border-[#1a1d2e] bg-[#0c0e16] px-3 py-3">
                          <div className="flex shrink-0 flex-col gap-2">
                            <button
                              onClick={() => {
                                if (index === 0) return;
                                const next = [...globalConfigs];
                                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                                void mutateGlobalConfigs(next, "Порядок global-конфигов обновлён");
                              }}
                              disabled={!canEdit || savingGlobalConfig || index === 0}
                              className="rounded border border-[#1d2135] p-1 text-[#4a5170] transition hover:border-[#2a3355] hover:text-[#dde2f0] disabled:opacity-40"
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              onClick={() => {
                                if (index === globalConfigs.length - 1) return;
                                const next = [...globalConfigs];
                                [next[index + 1], next[index]] = [next[index], next[index + 1]];
                                void mutateGlobalConfigs(next, "Порядок global-конфигов обновлён");
                              }}
                              disabled={!canEdit || savingGlobalConfig || index === globalConfigs.length - 1}
                              className="rounded border border-[#1d2135] p-1 text-[#4a5170] transition hover:border-[#2a3355] hover:text-[#dde2f0] disabled:opacity-40"
                            >
                              <ChevronDown size={14} />
                            </button>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-semibold text-[#e8eaf6]">{config.name}</span>
                              <Pill color={config.enabled ? "green" : "red"}>{config.enabled ? "вкл" : "выкл"}</Pill>
                            </div>
                            <div className="mt-1 truncate font-mono text-[10px] text-[#2a3355]">{config.uri}</div>
                          </div>
                          {canEdit && (
                            <div className="flex shrink-0 items-center gap-2">
                              <SoftButton
                                onClick={() => {
                                  const next = [...globalConfigs];
                                  next[index] = { ...config, enabled: !config.enabled };
                                  void mutateGlobalConfigs(next, "Состояние global-конфига обновлено");
                                }}
                                disabled={savingGlobalConfig}
                                variant="blue"
                              >
                                {config.enabled ? "Выключить" : "Включить"}
                              </SoftButton>
                              <SoftButton onClick={() => deleteGlobalConfig(config)} disabled={savingGlobalConfig} variant="danger">
                                <Trash2 size={14} />
                              </SoftButton>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <div>
                <SectionTitle>Настройки</SectionTitle>
                <Card className="space-y-4 p-4">
                  <Field label="Profile Update Interval (часы)">
                    <TextInput value={settingsInput} onChange={setSettingsInput} placeholder="Например: 12" type="number" disabled={!canEdit} />
                  </Field>
                  <div className="font-mono text-[10px] text-[#2a3355]">
                    Текущее значение: {settings.sub_update_interval == null ? "не переопределено" : `${settings.sub_update_interval} ч`}
                  </div>
                  {canEdit && (
                    <SoftButton onClick={saveSettings} disabled={savingSettings} variant="yellow" className="w-full">
                      {savingSettings ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                      Сохранить настройки
                    </SoftButton>
                  )}
                </Card>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
