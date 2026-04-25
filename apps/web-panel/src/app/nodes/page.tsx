"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowUpCircle, Copy, Loader2, Plus, X } from "lucide-react";
import Layout from "@/components/Layout";
import { api, EnrollToken, isAgentOutdated, Node, VersionInfo } from "@/lib/api";
import { formatFullDateTime, formatNumber, formatRelativeTime, statusLabel } from "@/lib/format";
import { isMasterNode, primaryNodeIP } from "@/lib/inventory";
import { Card, FilterChip, Pill, SearchBar, SoftButton, StatCard, StatusDot } from "@/components/ui";

type Filter = "all" | "online" | "offline" | "pending";

function AgentVersionBadge({ version, latestVersion }: { version: string | null; latestVersion: string | null }) {
  if (!version) return <Pill color="gray">агент не подключён</Pill>;
  const outdated = isAgentOutdated(version, latestVersion);

  return (
    <Pill color={outdated ? "yellow" : "gray"}>
      {outdated && <AlertTriangle size={10} className="mr-1" />}
      {version}
      {outdated && latestVersion && <span className="ml-1 text-[#8f7840]">→ {latestVersion}</span>}
    </Pill>
  );
}

function NodeCard({ node, latestAgentVersion }: { node: Node; latestAgentVersion: string | null }) {
  const ip = primaryNodeIP(node);
  const master = isMasterNode(node);

  return (
    <Link href={`/nodes/${node.id}`} className="group block">
      <Card className="h-full p-5 transition duration-200 group-hover:-translate-y-0.5 group-hover:border-[#2a3355] group-hover:shadow-[0_22px_70px_rgba(0,0,0,0.28)]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold text-[#e8eaf6]">{node.name}</div>
              {master && <Pill color="purple">МАСТЕР</Pill>}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-[#2a3355]">{ip ?? "IP не определён"}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-[#4a5170]">
            <StatusDot status={node.status} />
            {statusLabel(node.status)}
          </div>
        </div>

        <div className="space-y-2 font-mono text-xs text-[#4a5170]">
          {node.hostname && <div>Host: <span className="text-[#dde2f0]">{node.hostname}</span></div>}
          {node.os && <div>OS: <span className="text-[#dde2f0]">{node.os}</span></div>}
          {(node.provider || node.location) && <div>Где: <span className="text-[#dde2f0]">{[node.provider, node.location].filter(Boolean).join(" · ")}</span></div>}
          <div className="flex items-center gap-2">
            <span>Агент:</span>
            <AgentVersionBadge version={node.agent_version} latestVersion={latestAgentVersion} />
          </div>
          <div>Последний сигнал: <span className="text-[#dde2f0]">{formatRelativeTime(node.last_seen_at)}</span></div>
        </div>
      </Card>
    </Link>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#4a5170]">{label}</span>
      {children}
    </label>
  );
}

function TextInput({ value, onChange, required, placeholder }: { value: string; onChange: (value: string) => void; required?: boolean; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      required={required}
      placeholder={placeholder}
      className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-2.5 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70"
    />
  );
}

function AddNodeModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [location, setLocation] = useState("");
  const [enrollToken, setEnrollToken] = useState<EnrollToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const node = await api.nodes.create({ name, provider: provider || undefined, location: location || undefined });
      const token = await api.nodes.createEnrollToken(node.id);
      setEnrollToken(token);
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось создать ноду");
    } finally {
      setLoading(false);
    }
  }

  function copyCommand() {
    if (!enrollToken) return;
    navigator.clipboard.writeText(enrollToken.install_command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <Card className="relative w-full max-w-xl overflow-hidden border-[#1d2135] bg-[#131620] shadow-[0_24px_90px_rgba(0,0,0,0.65)]">
        <div className="flex items-center justify-between border-b border-[#1a1d2e] px-6 py-5">
          <div>
            <div className="text-lg font-bold text-[#e8eaf6]">Добавить ноду</div>
            <div className="mt-1 font-mono text-[10px] text-[#4a5170]">создание VPS-агента и команды установки</div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-[#4a5170] transition hover:bg-[#1a1d2e] hover:text-[#dde2f0]">
            <X size={18} />
          </button>
        </div>

        {!enrollToken ? (
          <form onSubmit={handleCreate} className="space-y-4 p-6">
            <Field label="Имя ноды *">
              <TextInput value={name} onChange={setName} required placeholder="Например: vpn-frankfurt-01" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Провайдер">
                <TextInput value={provider} onChange={setProvider} placeholder="Hetzner, DigitalOcean..." />
              </Field>
              <Field label="Локация">
                <TextInput value={location} onChange={setLocation} placeholder="Frankfurt, Amsterdam..." />
              </Field>
            </div>
            {error && <div className="font-mono text-xs text-[#f87171]">{error}</div>}
            <SoftButton type="submit" variant="primary" disabled={loading} className="w-full py-3">
              {loading ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Создать и получить команду установки
            </SoftButton>
          </form>
        ) : (
          <div className="space-y-4 p-6">
            <div className="rounded-lg border border-[#4ade80]/20 bg-[#4ade80]/10 p-3 font-mono text-xs text-[#4ade80]">
              Нода создана. Выполните команду ниже на VPS от root.
            </div>
            <div className="relative rounded-lg border border-[#1d2135] bg-[#0a0c13] p-4">
              <pre className="whitespace-pre-wrap break-all pr-10 font-mono text-xs leading-6 text-[#4ade80]">{enrollToken.install_command}</pre>
              <button onClick={copyCommand} className="absolute right-3 top-3 rounded-md border border-[#252a40] bg-[#1d2135] p-2 text-[#4a5170] transition hover:text-[#4ade80]">
                <Copy size={14} />
              </button>
            </div>
            {copied && <div className="font-mono text-xs text-[#4ade80]">Команда скопирована</div>}
            <div className="font-mono text-xs text-[#4a5170]">Токен истекает: {formatFullDateTime(enrollToken.expires_at)}</div>
            <SoftButton onClick={onClose} variant="ghost" className="w-full">Закрыть</SoftButton>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function NodesPage() {
  const router = useRouter();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [bulkUpdateLoading, setBulkUpdateLoading] = useState(false);
  const [bulkUpdateMsg, setBulkUpdateMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
      return;
    }
    try {
      const [nodeList, versionInfo] = await Promise.all([
        api.nodes.list(),
        api.version().catch(() => null as VersionInfo | null),
      ]);
      setNodes(nodeList);
      setLatestAgentVersion(versionInfo?.latest_agent_version ?? null);
    } catch {
      router.push("/login");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleUpdateOutdatedAgents() {
    setBulkUpdateLoading(true);
    setBulkUpdateMsg(null);
    try {
      const tasks = await api.nodes.updateOutdatedAgents();
      setBulkUpdateMsg(`Создано задач обновления: ${tasks.length}`);
      await load();
    } catch (err: unknown) {
      setBulkUpdateMsg(err instanceof Error ? err.message : "Не удалось обновить агентов");
    } finally {
      setBulkUpdateLoading(false);
    }
  }

  const online = nodes.filter((node) => node.status === "online").length;
  const offline = nodes.filter((node) => node.status === "offline").length;
  const pending = nodes.filter((node) => node.status === "pending").length;
  const outdatedCount = nodes.filter((node) => node.status === "online" && isAgentOutdated(node.agent_version, latestAgentVersion)).length;
  const filtered = nodes.filter((node) => {
    if (filter !== "all" && node.status !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [node.name, node.hostname, node.public_ip, node.provider, node.location, node.os]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  return (
    <Layout>
      <div className="space-y-6 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Всего" value={formatNumber(nodes.length)} sub="зарегистрировано" color="#818cf8" />
          <StatCard label="Онлайн" value={formatNumber(online)} sub="агенты на связи" color="#4ade80" />
          <StatCard label="Оффлайн" value={formatNumber(offline)} sub={offline ? "нужна проверка" : "нет"} color={offline ? "#f87171" : "#4ade80"} />
          <StatCard label="Ожидают" value={formatNumber(pending)} sub="после создания" color="#fbbf24" />
          <StatCard label="Устарели" value={formatNumber(outdatedCount)} sub={latestAgentVersion ? `последняя ${latestAgentVersion}` : "последняя неизвестна"} color={outdatedCount ? "#fbbf24" : "#4ade80"} />
        </div>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="flex flex-wrap gap-2">
            <FilterChip label="Все" active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterChip label="Онлайн" active={filter === "online"} onClick={() => setFilter("online")} />
            <FilterChip label="Оффлайн" active={filter === "offline"} onClick={() => setFilter("offline")} />
            <FilterChip label="Ожидают" active={filter === "pending"} onClick={() => setFilter("pending")} />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row xl:ml-auto">
            <SearchBar value={search} onChange={setSearch} placeholder="Имя, IP, провайдер или локация..." className="sm:w-80" />
            {outdatedCount > 0 && (
              <SoftButton onClick={handleUpdateOutdatedAgents} disabled={bulkUpdateLoading} variant="yellow">
                {bulkUpdateLoading ? <Loader2 size={15} className="animate-spin" /> : <ArrowUpCircle size={15} />}
                Обновить устаревших
              </SoftButton>
            )}
            <SoftButton onClick={() => setShowModal(true)} variant="primary">
              <Plus size={15} />
              Добавить ноду
            </SoftButton>
          </div>
        </div>

        {bulkUpdateMsg && <Card className="p-3 font-mono text-xs text-[#8892b0]">{bulkUpdateMsg}</Card>}

        {loading ? (
          <div className="font-mono text-sm text-[#4a5170]">Загружаю ноды...</div>
        ) : filtered.length === 0 ? (
          <Card className="p-8 text-center font-mono text-sm text-[#4a5170]">Ноды не найдены. Измените фильтр или добавьте первый VPS.</Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((node) => <NodeCard key={node.id} node={node} latestAgentVersion={latestAgentVersion} />)}
          </div>
        )}
      </div>

      {showModal && <AddNodeModal onClose={() => setShowModal(false)} onCreated={load} />}
    </Layout>
  );
}
