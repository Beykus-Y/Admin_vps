"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import {
  ChevronDown,
  ChevronUp,
  Bot,
  CalendarPlus,
  Clock3,
  Database,
  Loader2,
  MonitorSmartphone,
  Network,
  Plus,
  RefreshCw,
  Save,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  UserPlus,
  X,
  type LucideIcon,
} from "lucide-react";
import Layout from "@/components/Layout";
import MarkdownAnswer from "@/components/MarkdownAnswer";
import { Card, Pill, SearchBar, SectionTitle, SoftButton, StatCard } from "@/components/ui";
import {
  api,
  SubProxyNamedConfig,
  SubProxyNode,
  SubProxyInbounds,
  SubProxyNodeFilter,
  SubProxyNodeSetting,
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

function gbInputToBytes(value: string): number | null {
  const parsed = Number.parseFloat(value.replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 1024 * 1024 * 1024);
}

function nullableNumberInput(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function moneyLabel(value: number | null | undefined, currency = "USD"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${currency || "USD"}`;
}

function nodeSettingKey(nodeId: number | null | undefined): string {
  return nodeId == null ? "null" : String(nodeId);
}

function defaultNodeSetting(node: SubProxyNode): SubProxyNodeSetting {
  return {
    node_id: node.id,
    node_name: node.name,
    node_address: node.address,
    billing_group: "",
    provider: "",
    location: "",
    monthly_cost: null,
    currency: "USD",
    traffic_included_gb: null,
    traffic_price_per_tb: null,
    importance: "normal",
    can_remove: true,
    note: "",
  };
}

function importanceLabel(value: SubProxyNodeSetting["importance"]): string {
  return {
    normal: "обычная",
    core: "важная",
    backup: "backup",
    test: "test",
    deprecated: "к выводу",
  }[value];
}

function dateInputToUnix(value: string): number | null {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59`);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
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

type DeviceRecord = SubProxyUserSummary["proxy_last_device"];

function shortValue(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function userAgentClient(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const firstToken = userAgent.split(" ", 1)[0];
  const [name, version] = firstToken.split("/");
  if (!name) return null;
  return version ? `${name} ${version}` : name;
}

function deviceClientLabel(device: DeviceRecord | null | undefined, fallbackUserAgent?: string | null): string {
  const name = device?.client_name || userAgentClient(device?.user_agent || fallbackUserAgent) || "unknown client";
  if (device?.client_name && device.client_version) return `${device.client_name} ${device.client_version}`;
  return name;
}

function deviceContextLine(device: DeviceRecord | null | undefined): string {
  return [device?.device_name, device?.platform, device?.os].filter(Boolean).join(" · ");
}

function deviceSearchText(device: DeviceRecord | null | undefined): string {
  if (!device) return "";
  return [
    device.user_agent,
    device.device_id,
    device.device_name,
    device.client_name,
    device.client_version,
    device.platform,
    device.os,
    device.fingerprint,
  ].filter(Boolean).join(" ");
}

function InfoTile({
  label,
  value,
  icon: Icon,
  color = "#38bdf8",
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-3">
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">
        <Icon size={13} style={{ color }} />
        {label}
      </div>
      <div className="mt-2 truncate text-lg font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function DeviceHistoryRow({ item }: { item: NonNullable<DeviceRecord> }) {
  const context = deviceContextLine(item);
  const sources = item.metadata?.sources ?? {};

  return (
    <div className="rounded-lg border border-[#1a1d2e] bg-[#111420] px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MonitorSmartphone size={15} className="text-[#38bdf8]" />
            <span className="truncate text-sm font-semibold text-[#e8eaf6]">{deviceClientLabel(item)}</span>
            {item.device_id && <Pill color="purple">HWID</Pill>}
            {item.fingerprint && <Pill color="gray">fp {shortValue(item.fingerprint, 6, 4)}</Pill>}
          </div>
          {context && <div className="mt-1 truncate font-mono text-[10px] text-[#5c6687]">{context}</div>}
        </div>
        <div className="shrink-0 text-right font-mono text-[10px] text-[#4a5170]">
          <div>{formatRelativeTime(new Date(item.timestamp * 1000).toISOString())}</div>
          <div className="mt-1 text-[#2a3355]">{formatFullDateTime(new Date(item.timestamp * 1000).toISOString())}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-2">
        <div className="rounded-md bg-[#0c0e16] px-2.5 py-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#2a3355]">IP</div>
          <div className="mt-1 font-mono text-[#8892b0]">{item.ip || "неизвестен"}</div>
        </div>
        <div className="rounded-md bg-[#0c0e16] px-2.5 py-2">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[#2a3355]">HWID / fingerprint</div>
          <div className="mt-1 font-mono text-[#8892b0]" title={item.device_id || item.fingerprint || undefined}>
            {item.device_id ? shortValue(item.device_id) : shortValue(item.fingerprint)}
          </div>
        </div>
      </div>

      {item.user_agent && (
        <div className="mt-2 truncate font-mono text-[10px] text-[#3a4460]" title={item.user_agent}>
          {item.user_agent}
        </div>
      )}
      {sources.device_id && (
        <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-[#2a3355]">
          источник HWID: {sources.device_id}
        </div>
      )}
    </div>
  );
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.role === "operator";

  const [status, setStatus] = useState<SubProxyStatus | null>(null);
  const [users, setUsers] = useState<SubProxyUserSummary[]>([]);
  const [globalConfigs, setGlobalConfigs] = useState<SubProxyStoredConfig[]>([]);
  const [inbounds, setInbounds] = useState<SubProxyInbounds>({});
  const [perUserConfigsMap, setPerUserConfigsMap] = useState<Record<string, SubProxyNamedConfig[]>>({});
  const [nodeFilters, setNodeFilters] = useState<Record<string, SubProxyNodeFilter>>({});
  const [nodeSettings, setNodeSettings] = useState<Record<string, SubProxyNodeSetting>>({});
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
  const [savingNodeSetting, setSavingNodeSetting] = useState(false);
  const [savingUserAction, setSavingUserAction] = useState(false);
  const [vpnAiQuestion, setVpnAiQuestion] = useState("Какие VPN-ноды требуют внимания и есть ли кандидаты на удаление?");
  const [vpnAiPeriod, setVpnAiPeriod] = useState("7d");
  const [vpnAiDeep, setVpnAiDeep] = useState(false);
  const [vpnAiAnswer, setVpnAiAnswer] = useState("");
  const [vpnAiError, setVpnAiError] = useState("");
  const [vpnAiLoading, setVpnAiLoading] = useState(false);
  const [inboundsLoading, setInboundsLoading] = useState(false);
  const [savingGlobalConfig, setSavingGlobalConfig] = useState(false);
  const [savingPerUserConfig, setSavingPerUserConfig] = useState(false);
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [renewUserOpen, setRenewUserOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newUserNote, setNewUserNote] = useState("");
  const [newUserLimitGb, setNewUserLimitGb] = useState("");
  const [newUserExpireDate, setNewUserExpireDate] = useState("");
  const [inboundSelection, setInboundSelection] = useState<Record<string, boolean>>({});
  const [renewDays, setRenewDays] = useState("30");
  const [renewLimitGb, setRenewLimitGb] = useState("");
  const [renewActivate, setRenewActivate] = useState(true);
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
      const [statusData, usersData, configsData, perUserData, nodeFilterData, nodeSettingsData, settingsData] = await Promise.all([
        api.subProxy.status(),
        api.subProxy.users({ limit: 500 }),
        api.subProxy.configs(),
        api.subProxy.perUserConfigs(),
        api.subProxy.nodeFilters(),
        api.subProxy.nodeSettings(),
        api.subProxy.settings(),
      ]);

      setStatus(statusData);
      setUsers(usersData.items);
      setGlobalConfigs(configsData);
      setPerUserConfigsMap(perUserData);
      setNodeFilters(nodeFilterData);
      setNodeSettings(nodeSettingsData);
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
      return [item.username, item.note, item.sub_last_user_agent, deviceSearchText(item.proxy_last_device)]
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
  const selectedLastDevice = selectedDetails?.device_history[0] ?? null;
  const activeUsers = users.filter((item) => item.status === "active").length;
  const usersWithKnownHwid = users.filter((item) => item.proxy_last_device?.device_id).length;

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

  function inboundKey(protocol: string, tag: string) {
    return `${protocol}::${tag}`;
  }

  async function ensureInbounds() {
    if (Object.keys(inbounds).length > 0) return inbounds;
    setInboundsLoading(true);
    try {
      const data = await api.subProxy.inbounds();
      setInbounds(data);
      const nextSelection: Record<string, boolean> = {};
      Object.entries(data).forEach(([protocol, items]) => {
        items.forEach((item) => {
          nextSelection[inboundKey(protocol, item.tag)] = true;
        });
      });
      setInboundSelection(nextSelection);
      return data;
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось загрузить inbounds");
      return {};
    } finally {
      setInboundsLoading(false);
    }
  }

  async function openCreateUser() {
    setCreateUserOpen(true);
    await ensureInbounds();
  }

  function selectedInboundsPayload() {
    const selected: Record<string, string[]> = {};
    Object.entries(inbounds).forEach(([protocol, items]) => {
      items.forEach((item) => {
        if (inboundSelection[inboundKey(protocol, item.tag)]) {
          selected[protocol] = [...(selected[protocol] ?? []), item.tag];
        }
      });
    });
    return selected;
  }

  async function createSubscriptionUser() {
    const username = newUsername.trim();
    if (!username) {
      showError("Username обязателен");
      return;
    }
    const selectedInbounds = selectedInboundsPayload();
    if (Object.keys(selectedInbounds).length === 0) {
      showError("Выбери хотя бы один inbound");
      return;
    }

    const proxies = Object.fromEntries(Object.keys(selectedInbounds).map((protocol) => [protocol, {}]));
    setSavingUserAction(true);
    try {
      await api.subProxy.createUser({
        username,
        note: newUserNote.trim() || null,
        data_limit: gbInputToBytes(newUserLimitGb),
        expire: dateInputToUnix(newUserExpireDate),
        data_limit_reset_strategy: "no_reset",
        status: "active",
        proxies,
        inbounds: selectedInbounds,
      });
      setCreateUserOpen(false);
      setNewUsername("");
      setNewUserNote("");
      setNewUserLimitGb("");
      setNewUserExpireDate("");
      setSelectedUsername(username);
      showSuccess(`Подписка ${username} создана`);
      await loadAll(false);
      await loadUserDetails(username);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось создать подписку");
    } finally {
      setSavingUserAction(false);
    }
  }

  async function renewSubscriptionUser() {
    if (!selectedUsername) return;
    const parsedDays = renewDays.trim() ? Number.parseInt(renewDays.trim(), 10) : null;
    if (parsedDays != null && (Number.isNaN(parsedDays) || parsedDays < 1 || parsedDays > 3650)) {
      showError("Срок продления должен быть от 1 до 3650 дней");
      return;
    }
    const dataLimit = gbInputToBytes(renewLimitGb);
    if (parsedDays == null && dataLimit == null && !renewActivate) {
      showError("Нет изменений для продления");
      return;
    }

    setSavingUserAction(true);
    try {
      await api.subProxy.renewUser(selectedUsername, {
        add_days: parsedDays,
        data_limit: dataLimit,
        status: renewActivate ? "active" : null,
      });
      setRenewUserOpen(false);
      setRenewDays("30");
      setRenewLimitGb("");
      setRenewActivate(true);
      showSuccess(`Подписка ${selectedUsername} продлена`);
      await loadAll(false);
      await loadUserDetails(selectedUsername);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось продлить подписку");
    } finally {
      setSavingUserAction(false);
    }
  }

  async function deleteSubscriptionUser() {
    if (!selectedUsername) return;
    if (!window.confirm(`Удалить подписку "${selectedUsername}"?`)) return;

    setSavingUserAction(true);
    try {
      await api.subProxy.deleteUser(selectedUsername);
      showSuccess(`Подписка ${selectedUsername} удалена`);
      setSelectedUsername("");
      setSelectedDetails(null);
      await loadAll(false);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось удалить подписку");
    } finally {
      setSavingUserAction(false);
    }
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

  function nodeSettingFor(node: SubProxyNode): SubProxyNodeSetting {
    return { ...defaultNodeSetting(node), ...(nodeSettings[nodeSettingKey(node.id)] ?? {}) };
  }

  function updateNodeSettingDraft(node: SubProxyNode, patch: Partial<SubProxyNodeSetting>) {
    const key = nodeSettingKey(node.id);
    setNodeSettings((current) => ({
      ...current,
      [key]: {
        ...defaultNodeSetting(node),
        ...(current[key] ?? {}),
        ...patch,
        node_id: node.id,
        node_name: node.name,
        node_address: node.address,
      },
    }));
  }

  async function saveNodeSetting(node: SubProxyNode) {
    const setting = nodeSettingFor(node);
    setSavingNodeSetting(true);
    try {
      const saved = await api.subProxy.saveNodeSetting({
        ...setting,
        currency: (setting.currency || "USD").trim().toUpperCase(),
      });
      setNodeSettings((current) => ({ ...current, [nodeSettingKey(node.id)]: saved }));
      showSuccess(`Настройки ноды ${node.name} сохранены`);
    } catch (err: unknown) {
      showError(err instanceof Error ? err.message : "Не удалось сохранить настройки ноды");
    } finally {
      setSavingNodeSetting(false);
    }
  }

  async function askVpnAI() {
    const question = vpnAiQuestion.trim();
    if (!question) return;
    setVpnAiLoading(true);
    setVpnAiError("");
    try {
      const result = await api.llm.vpn({
        question,
        period: vpnAiPeriod,
        deep_user_usage: vpnAiDeep,
      });
      setVpnAiAnswer(result.answer);
    } catch (err: unknown) {
      setVpnAiError(err instanceof Error ? err.message : "LLM-анализ VPN не удался");
    } finally {
      setVpnAiLoading(false);
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

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="rounded-lg border border-[#1d2135] bg-[#10131d] p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck size={17} className={reachable ? "text-[#4ade80]" : "text-[#f87171]"} />
                  <span className="text-sm font-semibold text-[#e8eaf6]">Sub Proxy</span>
                  <Pill color={reachable ? "green" : "red"}>{reachable ? "Marzban доступен" : "Marzban недоступен"}</Pill>
                </div>
                <div className="mt-1 font-mono text-[11px] text-[#5c6687]">
                  {formatNumber(users.length)} пользователей · {formatNumber(status?.counts.global_enabled_configs ?? 0)} глобальных конфигов включено
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                <Pill color="blue">{formatNumber(usersWithKnownHwid)} HWID</Pill>
                <Pill color="purple">{formatNumber(status?.counts.per_user_configs ?? 0)} extra</Pill>
                <Pill color="yellow">{formatNumber(status?.counts.filtered_users ?? 0)} фильтров</Pill>
                <Pill color={onlineNodes > 0 ? "green" : "gray"}>{formatNumber(onlineNodes)} нод онлайн</Pill>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-[#1d2135] bg-[#10131d] p-4">
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">
              <Settings2 size={13} className="text-[#818cf8]" />
              Интервал обновления
            </div>
            <div className="mt-2 text-xl font-bold text-[#e8eaf6]">
              {settings.sub_update_interval == null ? "по Marzban" : `${settings.sub_update_interval} ч`}
            </div>
            <div className="mt-1 font-mono text-[10px] text-[#2a3355]">profile-update-interval</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          <StatCard label="Пользователи" value={formatNumber(users.length)} sub={reachable ? "Marzban доступен" : "Marzban недоступен"} color={reachable ? "#4ade80" : "#f87171"} />
          <StatCard label="Активны" value={formatNumber(activeUsers)} sub="по данным Marzban" color="#38bdf8" />
          <StatCard label="С фильтром" value={formatNumber(status?.counts.filtered_users ?? 0)} sub="режим частичной подписки" color="#fbbf24" />
          <StatCard label="Extra конфиги" value={formatNumber(status?.counts.per_user_configs ?? 0)} sub={`${status?.counts.global_enabled_configs ?? 0} глобально включено`} color="#818cf8" />
          <StatCard label="Ноды" value={formatNumber(status?.nodes.length ?? 0)} sub={`${onlineNodes} онлайн`} color={onlineNodes > 0 ? "#4ade80" : "#4a5170"} />
        </div>

        <div>
          <SectionTitle>LLM-анализ VPN</SectionTitle>
          <Card className="p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#1d2135] bg-[#10131d] text-[#a78bfa]">
                <Bot size={18} />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <textarea
                  value={vpnAiQuestion}
                  onChange={(event) => setVpnAiQuestion(event.target.value)}
                  spellCheck={false}
                  className="min-h-[84px] w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#a78bfa]/70"
                  placeholder="Спроси про VPN: активных клиентов, лишние ноды, средний расход, группы тарификации..."
                />
                <div className="flex flex-col gap-2 md:flex-row md:items-center">
                  <select
                    value={vpnAiPeriod}
                    onChange={(event) => setVpnAiPeriod(event.target.value)}
                    className="rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2 text-sm text-[#dde2f0] outline-none focus:border-[#a78bfa]/70"
                  >
                    <option value="24h">24 часа</option>
                    <option value="7d">7 дней</option>
                    <option value="30d">30 дней</option>
                    <option value="current_month">С 1 числа</option>
                    <option value="previous_month">Прошлый месяц</option>
                    <option value="all">Все время</option>
                  </select>
                  <label className="flex items-center gap-2 text-sm text-[#8892b0]">
                    <input
                      type="checkbox"
                      checked={vpnAiDeep}
                      onChange={(event) => setVpnAiDeep(event.target.checked)}
                      className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                    />
                    глубокий анализ пользователей (медленнее)
                  </label>
                  <SoftButton onClick={askVpnAI} disabled={vpnAiLoading} variant="primary">
                    {vpnAiLoading ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                    Спросить по VPN
                  </SoftButton>
                </div>
                <div className="font-mono text-[10px] text-[#2a3355]">Контекст: Marzban users/nodes/usage, MGBoost фильтры, устройства и настройки тарификации нод.</div>
                {vpnAiError && <div className="rounded-lg border border-[#f87171]/20 bg-[#f87171]/[0.07] p-3 font-mono text-xs text-[#f87171]">{vpnAiError}</div>}
                {vpnAiAnswer && <MarkdownAnswer>{vpnAiAnswer}</MarkdownAnswer>}
              </div>
            </div>
          </Card>
        </div>

        <div>
          <SectionTitle>Настройки нод и тарификации</SectionTitle>
          <Card className="p-4">
            {!status?.nodes.length ? (
              <div className="font-mono text-xs text-[#2a3355]">Marzban ноды не найдены.</div>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {status.nodes.map((node) => {
                  const setting = nodeSettingFor(node);
                  return (
                    <div key={node.id ?? node.name} className="rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-4">
                      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Server size={14} className={node.status === "connected" ? "text-[#4ade80]" : "text-[#f87171]"} />
                            <span className="truncate text-sm font-semibold text-[#e8eaf6]">{node.name}</span>
                            <Pill color={node.status === "connected" ? "green" : "red"}>{node.status}</Pill>
                            <Pill color={setting.can_remove ? "green" : "red"}>{setting.can_remove ? "можно убрать" : "не трогать"}</Pill>
                          </div>
                          <div className="mt-1 font-mono text-[10px] text-[#2a3355]">{node.address}:{node.port ?? "?"}</div>
                        </div>
                        <div className="text-right font-mono text-xs text-[#dde2f0]">
                          <div>{moneyLabel(setting.monthly_cost, setting.currency)} / мес</div>
                          <div className="mt-1 text-[10px] text-[#4a5170]">{setting.traffic_price_per_tb == null ? "трафик неизвестен" : `${moneyLabel(setting.traffic_price_per_tb, setting.currency)} / TB`}</div>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        <Field label="Провайдер">
                          <TextInput value={setting.provider} onChange={(value) => updateNodeSettingDraft(node, { provider: value })} placeholder="Yandex Cloud" disabled={!canEdit} />
                        </Field>
                        <Field label="Локация">
                          <TextInput value={setting.location} onChange={(value) => updateNodeSettingDraft(node, { location: value })} placeholder="RU, Moscow" disabled={!canEdit} />
                        </Field>
                        <Field label="Группа тарификации">
                          <TextInput value={setting.billing_group} onChange={(value) => updateNodeSettingDraft(node, { billing_group: value })} placeholder="Yandex Cloud" disabled={!canEdit} />
                        </Field>
                        <Field label="VPS / месяц">
                          <TextInput value={setting.monthly_cost == null ? "" : String(setting.monthly_cost)} onChange={(value) => updateNodeSettingDraft(node, { monthly_cost: nullableNumberInput(value) })} placeholder="435" type="number" disabled={!canEdit} />
                        </Field>
                        <Field label="Валюта">
                          <TextInput value={setting.currency} onChange={(value) => updateNodeSettingDraft(node, { currency: value.toUpperCase() })} placeholder="RUB" disabled={!canEdit} />
                        </Field>
                        <Field label="Цена / TB">
                          <TextInput value={setting.traffic_price_per_tb == null ? "" : String(setting.traffic_price_per_tb)} onChange={(value) => updateNodeSettingDraft(node, { traffic_price_per_tb: nullableNumberInput(value) })} placeholder="1370" type="number" disabled={!canEdit} />
                        </Field>
                        <Field label="Включено, GB">
                          <TextInput value={setting.traffic_included_gb == null ? "" : String(setting.traffic_included_gb)} onChange={(value) => updateNodeSettingDraft(node, { traffic_included_gb: nullableNumberInput(value) })} placeholder="пусто = неизвестно" type="number" disabled={!canEdit} />
                        </Field>
                        <Field label="Роль">
                          <select
                            value={setting.importance}
                            disabled={!canEdit}
                            onChange={(event) => updateNodeSettingDraft(node, { importance: event.target.value as SubProxyNodeSetting["importance"] })}
                            className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition focus:border-[#4ade80]/70 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <option value="normal">{importanceLabel("normal")}</option>
                            <option value="core">{importanceLabel("core")}</option>
                            <option value="backup">{importanceLabel("backup")}</option>
                            <option value="test">{importanceLabel("test")}</option>
                            <option value="deprecated">{importanceLabel("deprecated")}</option>
                          </select>
                        </Field>
                        <label className="flex items-end gap-2 pb-2 text-sm text-[#8892b0]">
                          <input
                            type="checkbox"
                            checked={setting.can_remove}
                            disabled={!canEdit}
                            onChange={(event) => updateNodeSettingDraft(node, { can_remove: event.target.checked })}
                            className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                          />
                          можно рассматривать к удалению
                        </label>
                      </div>

                      <div className="mt-3">
                        <Field label="Заметка">
                          <TextInput value={setting.note} onChange={(value) => updateNodeSettingDraft(node, { note: value })} placeholder="например: Yandex считает трафик общей группой" disabled={!canEdit} />
                        </Field>
                      </div>

                      {canEdit && (
                        <div className="mt-4 flex justify-end">
                          <SoftButton onClick={() => saveNodeSetting(node)} disabled={savingNodeSetting} variant="primary">
                            {savingNodeSetting ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                            Сохранить ноду
                          </SoftButton>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
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
            {canEdit && (
              <SoftButton onClick={openCreateUser} disabled={savingUserAction} variant="primary">
                <UserPlus size={15} />
                Создать
              </SoftButton>
            )}
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
              <Pill color={reachable ? "green" : "red"}>{reachable ? "proxy онлайн" : "proxy ошибка"}</Pill>
            </div>
            <div className="max-h-[820px] overflow-y-auto">
              {filteredUsers.length === 0 ? (
                <div className="p-8 text-center font-mono text-xs text-[#2a3355]">Пользователи не найдены</div>
              ) : filteredUsers.map((item) => {
                const selected = item.username === selectedUsername;
                const expireIso = unixToIso(item.expire);
                const lastDevice = item.proxy_last_device;
                const deviceContext = deviceContextLine(lastDevice);
                return (
                  <button
                    key={item.username}
                    onClick={() => setSelectedUsername(item.username)}
                    className={clsx(
                      "w-full border-b border-[#0f1218] px-4 py-3 text-left transition hover:bg-[#141722]",
                      selected && "bg-[#141722] shadow-[inset_3px_0_0_#4ade80]"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-semibold text-[#e8eaf6]">{item.username}</span>
                          <Pill color={statusDot(item.status)}>{subscriptionStatusLabel(item.status)}</Pill>
                          {item.proxy_filtered && <Pill color="yellow">фильтр</Pill>}
                          {item.proxy_extra_configs > 0 && <Pill color="purple">+{item.proxy_extra_configs}</Pill>}
                          {lastDevice?.device_id && <Pill color="blue">HWID</Pill>}
                        </div>
                        <div className="mt-1 font-mono text-[10px] text-[#4a5170]">
                          {formatBytes(item.used_traffic)} / {limitLabel(item.data_limit)} · {expireIso ? formatDateTime(expireIso) : "без срока"}
                        </div>
                        {(lastDevice || item.sub_last_user_agent) && (
                          <div className="mt-2 min-w-0">
                            <div className="flex items-center gap-1.5 font-mono text-[10px] text-[#5c6687]">
                              <MonitorSmartphone size={12} className="shrink-0 text-[#38bdf8]" />
                              <span className="truncate">{deviceClientLabel(lastDevice, item.sub_last_user_agent)}</span>
                            </div>
                            {deviceContext && (
                              <div className="mt-1 truncate font-mono text-[10px] text-[#2a3355]">{deviceContext}</div>
                            )}
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
              <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-lg font-bold text-[#e8eaf6]">{selectedUsername || "Пользователь не выбран"}</div>
                    {selectedDetails && <Pill color={subscriptionStatusColor(selectedDetails.user.status)}>{subscriptionStatusLabel(selectedDetails.user.status)}</Pill>}
                  </div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[#2a3355]">профиль подписки</div>
                  {selectedLastDevice && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Pill color="blue">{deviceClientLabel(selectedLastDevice)}</Pill>
                      {deviceContextLine(selectedLastDevice) && <Pill color="gray">{deviceContextLine(selectedLastDevice)}</Pill>}
                      {selectedLastDevice.device_id && <Pill color="purple">HWID {shortValue(selectedLastDevice.device_id, 6, 4)}</Pill>}
                    </div>
                  )}
                </div>
                {canEdit && selectedDetails && (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <SoftButton onClick={() => setRenewUserOpen(true)} disabled={savingUserAction} variant="yellow">
                      <CalendarPlus size={15} />
                      Продлить
                    </SoftButton>
                    <SoftButton onClick={deleteSubscriptionUser} disabled={savingUserAction} variant="danger">
                      <Trash2 size={15} />
                      Удалить
                    </SoftButton>
                  </div>
                )}
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
                    <InfoTile icon={Network} label="Трафик" value={formatBytes(selectedDetails.user.used_traffic)} color="#38bdf8" />
                    <InfoTile icon={Database} label="Лимит" value={limitLabel(selectedDetails.user.data_limit)} color="#fbbf24" />
                    <InfoTile icon={Clock3} label="Истекает" value={selectedDetails.user.expire ? formatDateTime(unixToIso(selectedDetails.user.expire)) : "без срока"} color="#4ade80" />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                    <div>
                      <SectionTitle>Фильтр конфигов</SectionTitle>
                      <div className="space-y-3 rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-4">
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
                      </div>
                    </div>

                    <div className="space-y-4">
                      <div>
                        <SectionTitle>Трафик по нодам</SectionTitle>
                        <div className="rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-4">
                          {selectedDetails.usage.usages?.length ? (
                            <div className="space-y-2">
                              {selectedDetails.usage.usages.map((row) => (
                                <div key={`${row.node_id ?? "none"}-${row.node_name}`} className="rounded-lg border border-[#1a1d2e] bg-[#111420] px-3 py-2">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <Server size={13} className="shrink-0 text-[#4a5170]" />
                                      <span className="truncate text-sm text-[#dde2f0]">{row.node_name}</span>
                                    </div>
                                    <span className="font-mono text-xs text-[#38bdf8]">{formatBytes(row.used_traffic)}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="font-mono text-xs text-[#2a3355]">Нет usage-данных по нодам.</div>
                          )}
                        </div>
                      </div>

                      <div>
                        <SectionTitle>История устройств</SectionTitle>
                        <div className="rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-4">
                          {selectedDetails.device_history.length ? (
                            <div className="space-y-2">
                              {selectedDetails.device_history.map((item, index) => (
                                <DeviceHistoryRow key={`${item.ip ?? "ip"}-${item.timestamp}-${index}`} item={item} />
                              ))}
                            </div>
                          ) : (
                            <div className="font-mono text-xs text-[#2a3355]">История устройств пока пуста.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <SectionTitle>Персональные extra-конфиги</SectionTitle>
                    <div className="space-y-4 rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-4">
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
                    </div>
                  </div>
                </div>
              )}
            </Card>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div>
                <SectionTitle>Глобальные extra-конфиги</SectionTitle>
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
                      включен
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

        {createUserOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-[#1d2135] bg-[#111420] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
              <div className="flex items-center justify-between border-b border-[#1a1d2e] px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-[#e8eaf6]">Новая подписка</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">Marzban user</div>
                </div>
                <button onClick={() => setCreateUserOpen(false)} className="rounded border border-[#1d2135] p-2 text-[#4a5170] hover:text-[#dde2f0]">
                  <X size={15} />
                </button>
              </div>

              <div className="space-y-4 p-4">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <Field label="Username">
                    <TextInput value={newUsername} onChange={setNewUsername} placeholder="client_001" disabled={savingUserAction} />
                  </Field>
                  <Field label="Лимит, ГБ">
                    <TextInput value={newUserLimitGb} onChange={setNewUserLimitGb} placeholder="0 = без лимита" type="number" disabled={savingUserAction} />
                  </Field>
                  <Field label="Истекает">
                    <TextInput value={newUserExpireDate} onChange={setNewUserExpireDate} type="date" disabled={savingUserAction} />
                  </Field>
                  <Field label="Заметка">
                    <TextInput value={newUserNote} onChange={setNewUserNote} placeholder="комментарий" disabled={savingUserAction} />
                  </Field>
                </div>

                <div>
                  <SectionTitle>Inbounds</SectionTitle>
                  <div className="rounded-lg border border-[#1a1d2e] bg-[#0c0e16] p-4">
                    {inboundsLoading ? (
                      <div className="flex items-center gap-2 font-mono text-xs text-[#4a5170]">
                        <Loader2 size={14} className="animate-spin" />
                        Загружаю inbounds...
                      </div>
                    ) : Object.keys(inbounds).length === 0 ? (
                      <div className="font-mono text-xs text-[#2a3355]">Inbounds не найдены</div>
                    ) : (
                      <div className="grid gap-3 lg:grid-cols-2">
                        {Object.entries(inbounds).map(([protocol, items]) => (
                          <div key={protocol} className="rounded-lg border border-[#1a1d2e] bg-[#111420] p-3">
                            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">{protocol}</div>
                            <div className="grid gap-2">
                              {items.map((item) => {
                                const key = inboundKey(protocol, item.tag);
                                return (
                                  <label key={key} className="flex items-center gap-2 rounded-md bg-[#0c0e16] px-3 py-2 text-xs text-[#8892b0]">
                                    <input
                                      type="checkbox"
                                      checked={Boolean(inboundSelection[key])}
                                      onChange={(event) => setInboundSelection((current) => ({ ...current, [key]: event.target.checked }))}
                                      className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                                    />
                                    <span className="truncate">{item.tag}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <SoftButton onClick={() => setCreateUserOpen(false)} disabled={savingUserAction} variant="ghost">Отмена</SoftButton>
                  <SoftButton onClick={createSubscriptionUser} disabled={savingUserAction || inboundsLoading} variant="primary">
                    {savingUserAction ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
                    Создать
                  </SoftButton>
                </div>
              </div>
            </div>
          </div>
        )}

        {renewUserOpen && selectedDetails && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-xl rounded-lg border border-[#1d2135] bg-[#111420] shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
              <div className="flex items-center justify-between border-b border-[#1a1d2e] px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-[#e8eaf6]">Продлить {selectedUsername}</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#2a3355]">
                    текущий срок: {selectedDetails.user.expire ? formatDateTime(unixToIso(selectedDetails.user.expire)) : "без срока"}
                  </div>
                </div>
                <button onClick={() => setRenewUserOpen(false)} className="rounded border border-[#1d2135] p-2 text-[#4a5170] hover:text-[#dde2f0]">
                  <X size={15} />
                </button>
              </div>
              <div className="space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Добавить дней">
                    <TextInput value={renewDays} onChange={setRenewDays} type="number" disabled={savingUserAction} />
                  </Field>
                  <Field label="Новый лимит, ГБ">
                    <TextInput value={renewLimitGb} onChange={setRenewLimitGb} placeholder="пусто = не менять" type="number" disabled={savingUserAction} />
                  </Field>
                </div>
                <label className="flex items-center gap-2 text-sm text-[#8892b0]">
                  <input
                    type="checkbox"
                    checked={renewActivate}
                    onChange={(event) => setRenewActivate(event.target.checked)}
                    className="h-4 w-4 rounded border-[#252a40] bg-[#111420] text-[#4ade80]"
                  />
                  активировать пользователя
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <SoftButton onClick={() => setRenewUserOpen(false)} disabled={savingUserAction} variant="ghost">Отмена</SoftButton>
                  <SoftButton onClick={renewSubscriptionUser} disabled={savingUserAction} variant="yellow">
                    {savingUserAction ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
                    Продлить
                  </SoftButton>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
