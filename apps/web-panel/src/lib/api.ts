const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "";
const VERSION_CACHE_TTL_MS = 60_000;

let cachedVersionInfo: VersionInfo | null = null;
let cachedVersionInfoAt = 0;
let versionRequestInFlight: Promise<VersionInfo> | null = null;

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
}

function apiOrigin(): string {
  if (BASE_URL) return BASE_URL;
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

function websocketUrl(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): string | null {
  const token = getToken();
  if (!token) return null;
  const origin = apiOrigin();
  if (!origin) return null;
  const url = new URL(`/api${path}`, origin);
  Object.entries({ ...params, token }).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    search.set(key, String(value));
  });
  const query = search.toString();
  return query ? `?${query}` : "";
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };
  const res = await fetch(`${BASE_URL}/api${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Запрос не выполнен");
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export type UserRole = "viewer" | "operator" | "admin";

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  is_active: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  user?: AuthUser | null;
}

export interface Node {
  id: string;
  name: string;
  status: "pending" | "online" | "offline";
  hostname: string | null;
  public_ip: string | null;
  os: string | null;
  arch: string | null;
  uptime_seconds: number | null;
  kernel: string | null;
  cpu_model: string | null;
  cpu_cores: number | null;
  local_ips: string[];
  provider: string | null;
  location: string | null;
  group_name: string | null;
  tags: string[];
  agent_version: string | null;
  capabilities: string[];
  created_at: string;
  last_seen_at: string | null;
}

export interface Overview {
  nodes: { total: number; online: number; offline: number; pending: number };
  containers: { total: number; running: number };
  ports: { total: number; unexpected: number };
  recent_events: NodeEvent[];
}

export interface Container {
  id: string;
  container_id: string;
  name: string;
  image: string | null;
  status: string | null;
  state: string | null;
  ports: string[];
  networks: string[];
  mounts: string[];
  cpu_percent: number | null;
  ram_mb: number | null;
  restart_count: number | null;
  health_status: string | null;
  updated_at: string | null;
}

export interface Port {
  id: string;
  protocol: string;
  port: number;
  listen_ip: string | null;
  process_name: string | null;
  pid: number | null;
  user_name: string | null;
  container_name: string | null;
  is_expected: boolean;
  status: "open" | "stale";
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface NodeMetric {
  id: string;
  cpu_percent: number | null;
  ram_used_mb: number | null;
  ram_total_mb: number | null;
  disk_used_gb: number | null;
  disk_total_gb: number | null;
  load_1: number | null;
  load_5: number | null;
  load_15: number | null;
  network_rx_bytes: number | null;
  network_tx_bytes: number | null;
  created_at: string;
}

export interface Task {
  id: string;
  node_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EnrollToken {
  install_command: string;
  enroll_token: string;
  expires_at: string;
}

export interface TerminalSession {
  id: string;
  node_id: string;
  created_at: string;
}

export interface NodeEvent {
  id: string;
  node_id: string | null;
  node_name?: string;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  extra?: Record<string, unknown>;
  created_at: string;
}

export interface VersionInfo {
  master_version: string;
  latest_agent_version: string | null;
}

export interface AlertRule {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  severity: "info" | "warning" | "critical";
  enabled: boolean;
  threshold: number | null;
  duration_seconds: number;
  filters: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AlertIncident {
  id: string;
  rule_id: string;
  rule_name: string;
  rule_kind: string;
  node_id: string | null;
  node_name: string | null;
  severity: "info" | "warning" | "critical";
  status: string;
  message: string;
  current_value: number | null;
  extra: Record<string, unknown>;
  started_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  silenced_until: string | null;
  resolved_at: string | null;
}

export interface AlertChannel {
  id: string;
  name: string;
  type: "webhook" | "telegram" | "email";
  enabled: boolean;
  severities: string[];
  send_resolved: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  actor_username: string | null;
  node_id: string | null;
  node_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  message: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface InventoryNode {
  node: Node;
  metrics: NodeMetric | null;
  containers: Container[];
  ports: Port[];
  incidents: AlertIncidentSummary[];
  tasks_pending: number;
}

export interface AlertIncidentSummary {
  id: string;
  rule_id: string;
  rule_name: string;
  rule_kind: string;
  severity: "info" | "warning" | "critical";
  status: string;
  message: string;
  current_value: number | null;
  started_at: string;
  last_seen_at: string;
  node_name: string | null;
}

export interface InventorySnapshot {
  nodes: InventoryNode[];
  recent_events: NodeEvent[];
  summary: {
    nodes: { total: number; online: number; offline: number; pending: number };
    containers: { total: number; running: number };
    ports: { total: number; unexpected: number; public: number };
    incidents: { open: number; critical: number };
  };
}

export interface NodeDetails {
  node: Node;
  containers: Container[];
  ports: Port[];
  metrics: NodeMetric | null;
  history: NodeMetric[];
  tasks: Task[];
  events: NodeEvent[];
}

export interface SubProxyNode {
  id: number | null;
  name: string;
  address: string;
  port: number | null;
  status: string;
  xray_version: string | null;
}

export interface SubProxyStatus {
  service: string;
  marzban: {
    reachable: boolean;
    error?: string | null;
  };
  nodes: SubProxyNode[];
  counts: {
    global_configs: number;
    global_enabled_configs: number;
    per_user_config_users: number;
    per_user_configs: number;
    filtered_users: number;
  };
  settings: {
    sub_update_interval: number | null;
  };
}

export interface SubProxyUserSummary {
  username: string;
  status: string;
  used_traffic: number;
  data_limit: number | null;
  expire: number | null;
  note: string | null;
  online_at: string | null;
  sub_last_user_agent: string | null;
  proxy_filtered: boolean;
  proxy_extra_configs: number;
  proxy_last_device: SubProxyDeviceHistoryItem | null;
}

export interface SubProxyUsersResponse {
  items: SubProxyUserSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface SubProxyNamedConfig {
  name: string;
  uri: string;
  enabled: boolean;
}

export interface SubProxyStoredConfig extends SubProxyNamedConfig {
  id: number;
  sort_order?: number;
}

export interface SubProxyNodeFilter {
  all: boolean;
  allowed_configs: string[];
}

export type SubProxyNodeImportance = "normal" | "core" | "backup" | "test" | "deprecated";

export interface SubProxyNodeSetting {
  node_key?: string;
  node_id: number | null;
  node_name: string;
  node_address: string;
  billing_group: string;
  provider: string;
  location: string;
  monthly_cost: number | null;
  currency: string;
  traffic_included_gb: number | null;
  traffic_price_per_tb: number | null;
  importance: SubProxyNodeImportance;
  can_remove: boolean;
  note: string;
  updated_at?: number;
}

export interface SubProxyUsageRow {
  node_id: number | null;
  node_name: string;
  used_traffic: number;
  uplink?: number;
  downlink?: number;
}

export interface SubProxyDeviceHistoryItem {
  user_agent: string | null;
  ip: string | null;
  timestamp: number;
  device_id?: string | null;
  device_name?: string | null;
  client_name?: string | null;
  client_version?: string | null;
  platform?: string | null;
  os?: string | null;
  fingerprint?: string | null;
  metadata?: {
    headers?: Record<string, string>;
    sources?: Record<string, string>;
  };
}

export interface SubProxyUserRecord {
  username: string;
  status: string;
  used_traffic: number;
  data_limit: number | null;
  expire: number | null;
  note: string | null;
  created_at: string | null;
  online_at: string | null;
  sub_last_user_agent: string | null;
  links: string[];
}

export interface SubProxyUserDetails {
  user: SubProxyUserRecord;
  usage: {
    usages: SubProxyUsageRow[];
  };
  node_filter: SubProxyNodeFilter;
  per_user_configs: SubProxyNamedConfig[];
  device_history: SubProxyDeviceHistoryItem[];
}

export interface SubProxySettings {
  sub_update_interval: number | null;
}

export interface SubProxyInbound {
  tag: string;
  protocol?: string;
  network?: string;
  tls?: string;
  port?: number | string;
}

export type SubProxyInbounds = Record<string, SubProxyInbound[]>;

export interface SubProxyUserCreatePayload {
  username: string;
  note?: string | null;
  data_limit?: number | null;
  expire?: number | null;
  data_limit_reset_strategy?: "no_reset" | "day" | "week" | "month" | "year";
  status?: "active" | "on_hold";
  proxies: Record<string, Record<string, unknown>>;
  inbounds: Record<string, string[]>;
}

export interface SubProxyUserRenewPayload {
  add_days?: number | null;
  expire?: number | null;
  data_limit?: number | null;
  status?: "active" | "disabled" | "on_hold" | null;
}

export interface SubProxyConnectionSettings {
  base_url: string;
  hmac_secret_set: boolean;
  timeout_seconds: number;
  source: "database" | "environment";
}

export interface SubProxyConnectionSettingsUpdate {
  base_url: string;
  hmac_secret?: string | null;
  clear_hmac_secret?: boolean;
  timeout_seconds: number;
}

export interface TelegramBotSettings {
  runner_node_id: string | null;
  bot_token_set: boolean;
  allowed_chat_ids: number[];
}

export interface TelegramBotSettingsUpdate {
  runner_node_id: string | null;
  bot_token?: string | null;
  allowed_chat_ids: number[];
}

export interface LLMSettings {
  base_url: string;
  api_key_set: boolean;
  model: string;
  timeout_seconds: number;
}

export interface LLMSettingsUpdate {
  base_url: string;
  api_key?: string | null;
  clear_api_key?: boolean;
  model: string;
  timeout_seconds: number;
}

export interface LLMAnalysisResponse {
  scope: "infrastructure" | "vpn";
  model: string;
  answer: string;
  sources: string[];
}

export const api = {
  login: (username: string, password: string) =>
    request<TokenResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  initAdmin: (username: string, password: string) =>
    request<TokenResponse>("/auth/init", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  auth: {
    me: () => request<AuthUser>("/auth/me"),
  },

  overview: () => request<Overview>("/overview"),
  inventory: {
    get: () => request<InventorySnapshot>("/inventory"),
  },
  events: {
    list: (params: { severity?: string; node_id?: string; limit?: number } = {}) =>
      request<NodeEvent[]>(`/events${buildQuery(params)}`),
  },
  alerts: {
    rules: () => request<AlertRule[]>("/alerts/rules"),
    updateRule: (id: string, payload: Partial<Pick<AlertRule, "name" | "description" | "severity" | "enabled" | "threshold" | "duration_seconds" | "filters">>) =>
      request<AlertRule>(`/alerts/rules/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    incidents: (params: { status?: string; node_id?: string; limit?: number } = {}) =>
      request<AlertIncident[]>(`/alerts/incidents${buildQuery(params)}`),
    acknowledgeIncident: (id: string) =>
      request<AlertIncident>(`/alerts/incidents/${id}/ack`, { method: "POST" }),
    silenceIncident: (id: string, minutes: number) =>
      request<AlertIncident>(`/alerts/incidents/${id}/silence`, { method: "POST", body: JSON.stringify({ minutes }) }),
    channels: () => request<AlertChannel[]>("/alerts/channels"),
    createChannel: (payload: Omit<AlertChannel, "id" | "created_at" | "updated_at">) =>
      request<AlertChannel>("/alerts/channels", { method: "POST", body: JSON.stringify(payload) }),
    updateChannel: (id: string, payload: Partial<Omit<AlertChannel, "id" | "created_at" | "updated_at">>) =>
      request<AlertChannel>(`/alerts/channels/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteChannel: (id: string) =>
      request<void>(`/alerts/channels/${id}`, { method: "DELETE" }),
    testChannel: (id: string) =>
      request<{ results: Array<{ channel_id: string; status: string; error?: string }> }>(`/alerts/channels/${id}/test`, { method: "POST" }),
  },
  audit: {
    list: (params: { action?: string; target_type?: string; limit?: number } = {}) =>
      request<AuditLog[]>(`/audit${buildQuery(params)}`),
  },
  master: {
    update: () => request<Task>("/master/update", { method: "POST" }),
  },
  subProxy: {
    status: () => request<SubProxyStatus>("/subproxy/status"),
    inbounds: () => request<SubProxyInbounds>("/subproxy/inbounds"),
    users: (params: { limit?: number; offset?: number } = {}) =>
      request<SubProxyUsersResponse>(`/subproxy/users${buildQuery(params)}`),
    userDetails: (username: string) =>
      request<SubProxyUserDetails>(`/subproxy/users/${encodeURIComponent(username)}`),
    createUser: (payload: SubProxyUserCreatePayload) =>
      request<SubProxyUserRecord>("/subproxy/users", { method: "POST", body: JSON.stringify(payload) }),
    renewUser: (username: string, payload: SubProxyUserRenewPayload) =>
      request<SubProxyUserRecord>(`/subproxy/users/${encodeURIComponent(username)}/renew`, { method: "POST", body: JSON.stringify(payload) }),
    deleteUser: (username: string) =>
      request<void>(`/subproxy/users/${encodeURIComponent(username)}`, { method: "DELETE" }),
    configs: () => request<SubProxyStoredConfig[]>("/subproxy/configs"),
    createConfig: (payload: { name?: string | null; uri: string; enabled: boolean }) =>
      request<{ ok: boolean }>("/subproxy/configs", { method: "POST", body: JSON.stringify(payload) }),
    deleteConfig: (configId: number) =>
      request<void>(`/subproxy/configs/${configId}`, { method: "DELETE" }),
    reorderConfigs: (payload: Array<{ id: number; name?: string | null; uri?: string | null; enabled: boolean }>) =>
      request<{ ok: boolean }>("/subproxy/configs/reorder", { method: "POST", body: JSON.stringify(payload) }),
    perUserConfigs: () => request<Record<string, SubProxyNamedConfig[]>>("/subproxy/per-user-configs"),
    savePerUserConfigs: (payload: Record<string, SubProxyNamedConfig[]>) =>
      request<{ ok: boolean }>("/subproxy/per-user-configs", { method: "POST", body: JSON.stringify(payload) }),
    nodeFilters: () => request<Record<string, SubProxyNodeFilter>>("/subproxy/node-filters"),
    saveNodeFilters: (payload: Record<string, SubProxyNodeFilter>) =>
      request<{ ok: boolean }>("/subproxy/node-filters", { method: "POST", body: JSON.stringify(payload) }),
    nodeSettings: () => request<Record<string, SubProxyNodeSetting>>("/subproxy/node-settings"),
    saveNodeSetting: (payload: SubProxyNodeSetting) =>
      request<SubProxyNodeSetting>("/subproxy/node-settings", { method: "POST", body: JSON.stringify(payload) }),
    settings: () => request<SubProxySettings>("/subproxy/settings"),
    saveSettings: (payload: SubProxySettings) =>
      request<{ ok: boolean }>("/subproxy/settings", { method: "POST", body: JSON.stringify(payload) }),
  },

  settings: {
    subProxy: () => request<SubProxyConnectionSettings>("/settings/sub-proxy"),
    saveSubProxy: (payload: SubProxyConnectionSettingsUpdate) =>
      request<SubProxyConnectionSettings>("/settings/sub-proxy", { method: "PUT", body: JSON.stringify(payload) }),
    testSubProxy: () =>
      request<{ ok: boolean; status: SubProxyStatus }>("/settings/sub-proxy/test", { method: "POST" }),
    llm: () => request<LLMSettings>("/settings/llm"),
    saveLLM: (payload: LLMSettingsUpdate) =>
      request<LLMSettings>("/settings/llm", { method: "PUT", body: JSON.stringify(payload) }),
    testLLM: () =>
      request<{ ok: boolean; model: string; answer: string }>("/settings/llm/test", { method: "POST" }),
    telegramBot: () => request<TelegramBotSettings>("/settings/telegram-bot"),
    saveTelegramBot: (payload: TelegramBotSettingsUpdate) =>
      request<TelegramBotSettings>("/settings/telegram-bot", { method: "PUT", body: JSON.stringify(payload) }),
  },

  nodes: {
    list: () => request<Node[]>("/nodes"),
    get: (id: string) => request<Node>(`/nodes/${id}`),
    details: (id: string, range = "24h", points = 48) =>
      request<NodeDetails>(`/nodes/${id}/details${buildQuery({ range, points })}`),
    create: (data: { name: string; provider?: string; location?: string; group_name?: string; tags?: string[] }) =>
      request<Node>("/nodes", { method: "POST", body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/nodes/${id}`, { method: "DELETE" }),
    createEnrollToken: (id: string) => request<EnrollToken>(`/nodes/${id}/enroll-token`, { method: "POST" }),
    containers: (id: string) => request<Container[]>(`/nodes/${id}/containers`),
    ports: (id: string) => request<Port[]>(`/nodes/${id}/ports`),
    metricsLatest: (id: string) => request<NodeMetric | null>(`/nodes/${id}/metrics/latest`),
    metricsHistory: (id: string, range = "24h", points = 48) =>
      request<NodeMetric[]>(`/nodes/${id}/metrics/history${buildQuery({ range, points })}`),
    tasks: (id: string) => request<Task[]>(`/nodes/${id}/tasks`),
    createTask: (id: string, type: string, payload: Record<string, unknown>) =>
      request<Task>(`/nodes/${id}/tasks`, { method: "POST", body: JSON.stringify({ type, payload }) }),
    events: (id: string) => request<NodeEvent[]>(`/nodes/${id}/events`),
    markPortExpected: (nodeId: string, portId: string, expected: boolean) =>
      request<void>(`/nodes/${nodeId}/ports/${portId}/expected?expected=${expected}`, { method: "PATCH" }),
    updateAgent: (id: string) =>
      request<Task>(`/nodes/${id}/update-agent`, { method: "POST" }),
    updateOutdatedAgents: () =>
      request<Task[]>("/nodes/update-agents", { method: "POST" }),
    createTerminalSession: (id: string) =>
      request<TerminalSession>(`/nodes/${id}/terminal/sessions`, { method: "POST", body: JSON.stringify({}) }),
  },

  llm: {
    infrastructure: (payload: { question: string }) =>
      request<LLMAnalysisResponse>("/llm/infrastructure", { method: "POST", body: JSON.stringify(payload) }),
    vpn: (payload: { question: string; period: string; deep_user_usage: boolean }) =>
      request<LLMAnalysisResponse>("/llm/vpn", { method: "POST", body: JSON.stringify(payload) }),
  },
  version: async () => {
    const now = Date.now();
    if (cachedVersionInfo && (now - cachedVersionInfoAt) < VERSION_CACHE_TTL_MS) {
      return cachedVersionInfo;
    }
    if (versionRequestInFlight) {
      return versionRequestInFlight;
    }
    versionRequestInFlight = request<VersionInfo>("/version")
      .then((versionInfo) => {
        cachedVersionInfo = versionInfo;
        cachedVersionInfoAt = Date.now();
        versionRequestInFlight = null;
        return versionInfo;
      })
      .catch((error) => {
        versionRequestInFlight = null;
        throw error;
      });
    return versionRequestInFlight;
  },
  streamUrl: () => {
    const token = getToken();
    const origin = apiOrigin();
    if (!token || !origin) return null;
    const url = new URL("/api/stream", origin);
    url.searchParams.set("token", token);
    return url.toString();
  },
  terminalWebSocketUrl: (sessionId: string) => {
    return websocketUrl(`/terminal/sessions/${sessionId}`);
  },
} as const;

/** Returns true if latestVersion is strictly newer than currentVersion (semver-ish). */
export function isAgentOutdated(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const strip = (v: string) => v.replace(/^[^\d]*/, "");
  const toNums = (v: string) => strip(v).split(".").map(Number);
  const [ca, cb, cc = 0] = toNums(current);
  const [la, lb, lc = 0] = toNums(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
