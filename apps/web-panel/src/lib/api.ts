const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "";

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("token");
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
    throw new Error(err.detail || "Request failed");
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  initAdmin: (username: string, password: string) =>
    request<{ access_token: string }>("/auth/init", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  overview: () => request<Overview>("/overview"),
  version: () => request<VersionInfo>("/version"),
  master: {
    update: () => request<Task>("/master/update", { method: "POST" }),
  },

  nodes: {
    list: () => request<Node[]>("/nodes"),
    get: (id: string) => request<Node>(`/nodes/${id}`),
    create: (data: { name: string; provider?: string; location?: string; group_name?: string }) =>
      request<Node>("/nodes", { method: "POST", body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/nodes/${id}`, { method: "DELETE" }),
    createEnrollToken: (id: string) => request<EnrollToken>(`/nodes/${id}/enroll-token`, { method: "POST" }),
    containers: (id: string) => request<Container[]>(`/nodes/${id}/containers`),
    ports: (id: string) => request<Port[]>(`/nodes/${id}/ports`),
    metricsLatest: (id: string) => request<NodeMetric | null>(`/nodes/${id}/metrics/latest`),
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
  },
};

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

export interface NodeEvent {
  id: string;
  node_id: string | null;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  created_at: string;
}

export interface VersionInfo {
  master_version: string;
  latest_agent_version: string | null;
}

/** Returns true if latestVersion is strictly newer than currentVersion (semver-ish). */
export function isAgentOutdated(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const strip = (v: string) => v.replace(/^[^\d]*/, ""); // strip "v" prefix
  const toNums = (v: string) => strip(v).split(".").map(Number);
  const [ca, cb, cc = 0] = toNums(current);
  const [la, lb, lc = 0] = toNums(latest);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
