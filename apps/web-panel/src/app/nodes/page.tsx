"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Layout from "@/components/Layout";
import { api, Node, EnrollToken, VersionInfo, isAgentOutdated } from "@/lib/api";
import { Plus, Circle, Copy, X, AlertTriangle } from "lucide-react";

function StatusDot({ status }: { status: string }) {
  const color = { online: "text-green-500", offline: "text-red-500", pending: "text-yellow-500" }[status] ?? "text-gray-500";
  return <Circle size={8} className={`${color} fill-current`} />;
}

function AgentVersionBadge({ version, latestVersion }: { version: string | null; latestVersion: string | null }) {
  if (!version) return <span className="text-xs text-[#475569]">no agent</span>;
  const outdated = isAgentOutdated(version, latestVersion);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded ${
        outdated
          ? "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20"
          : "bg-[#1e2433] text-[#64748b]"
      }`}
      title={outdated ? `Outdated — latest: ${latestVersion}` : "Up to date"}
    >
      {outdated && <AlertTriangle size={10} />}
      {version}
    </span>
  );
}

function NodeCard({ node, latestAgentVersion }: { node: Node; latestAgentVersion: string | null }) {
  return (
    <Link href={`/nodes/${node.id}`} className="block bg-[#1a1d27] border border-[#2a2d3e] rounded-lg p-5 hover:border-[#0ea5e9]/40 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <span className="font-semibold text-white text-sm">{node.name}</span>
        <div className="flex items-center gap-1.5">
          <StatusDot status={node.status} />
          <span className="text-xs text-[#64748b] capitalize">{node.status}</span>
        </div>
      </div>
      <div className="space-y-1 text-xs text-[#64748b]">
        {node.public_ip && <div>IP: <span className="text-white">{node.public_ip}</span></div>}
        {node.os && <div>OS: <span className="text-white">{node.os}</span></div>}
        {node.hostname && <div>Host: <span className="text-white">{node.hostname}</span></div>}
        {node.location && <div>Location: <span className="text-white">{node.location}</span></div>}
        <div className="flex items-center gap-1.5">
          <span>Agent:</span>
          <AgentVersionBadge version={node.agent_version} latestVersion={latestAgentVersion} />
        </div>
        {node.last_seen_at && (
          <div>Last seen: <span className="text-white">{new Date(node.last_seen_at).toLocaleString()}</span></div>
        )}
      </div>
    </Link>
  );
}

function AddNodeModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [location, setLocation] = useState("");
  const [enrollToken, setEnrollToken] = useState<EnrollToken | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const node = await api.nodes.create({ name, provider: provider || undefined, location: location || undefined });
      const token = await api.nodes.createEnrollToken(node.id);
      setEnrollToken(token);
      onCreated();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function copyCmd() {
    if (enrollToken) {
      navigator.clipboard.writeText(enrollToken.install_command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg w-full max-w-lg p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-[#64748b] hover:text-white">
          <X size={18} />
        </button>
        <h2 className="text-white font-semibold mb-4">Add Node</h2>

        {!enrollToken ? (
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-xs text-[#64748b] mb-1">Node Name *</label>
              <input value={name} onChange={(e) => setName(e.target.value)} required
                className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#0ea5e9]" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#64748b] mb-1">Provider</label>
                <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Hetzner, DO..."
                  className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#0ea5e9]" />
              </div>
              <div>
                <label className="block text-xs text-[#64748b] mb-1">Location</label>
                <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Frankfurt, NYC..."
                  className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-[#0ea5e9]" />
              </div>
            </div>
            <button type="submit" disabled={loading}
              className="w-full bg-[#0ea5e9] hover:bg-[#0284c7] text-white py-2 rounded text-sm font-medium transition-colors disabled:opacity-50">
              {loading ? "Creating..." : "Create & Get Install Command"}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="bg-green-500/10 border border-green-500/20 rounded p-3 text-green-400 text-sm">
              Node created! Run this command on your VPS:
            </div>
            <div className="relative">
              <pre className="bg-[#0f1117] border border-[#2a2d3e] rounded p-3 text-xs text-[#e2e8f0] whitespace-pre-wrap break-all">
                {enrollToken.install_command}
              </pre>
              <button onClick={copyCmd}
                className="absolute top-2 right-2 bg-[#2a2d3e] hover:bg-[#0ea5e9]/20 text-[#64748b] hover:text-[#0ea5e9] p-1.5 rounded transition-colors">
                <Copy size={13} />
              </button>
            </div>
            {copied && <p className="text-green-400 text-xs">Copied to clipboard!</p>}
            <p className="text-[#64748b] text-xs">
              Token expires at: {new Date(enrollToken.expires_at).toLocaleString()}
            </p>
            <button onClick={onClose}
              className="w-full border border-[#2a2d3e] text-[#64748b] hover:text-white py-2 rounded text-sm transition-colors">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function NodesPage() {
  const router = useRouter();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  async function load() {
    const token = localStorage.getItem("token");
    if (!token) { router.push("/login"); return; }
    try {
      const [nodeList, versionInfo] = await Promise.all([
        api.nodes.list(),
        api.version().catch(() => null as VersionInfo | null),
      ]);
      setNodes(nodeList);
      setLatestAgentVersion(versionInfo?.latest_agent_version ?? null);
    } catch {
      router.push("/login");
    }
  }

  useEffect(() => { load(); }, []);

  const outdatedCount = nodes.filter(
    (n) => n.status === "online" && isAgentOutdated(n.agent_version, latestAgentVersion)
  ).length;

  return (
    <Layout>
      <div className="p-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-white">Nodes</h1>
            {outdatedCount > 0 && (
              <span className="flex items-center gap-1 text-xs bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 px-2 py-0.5 rounded">
                <AlertTriangle size={11} />
                {outdatedCount} agent{outdatedCount > 1 ? "s" : ""} outdated
              </span>
            )}
          </div>
          <button onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 bg-[#0ea5e9] hover:bg-[#0284c7] text-white px-4 py-2 rounded text-sm font-medium transition-colors">
            <Plus size={15} />
            Add Node
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="text-[#64748b] text-sm">No nodes yet. Add your first VPS.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {nodes.map((n) => <NodeCard key={n.id} node={n} latestAgentVersion={latestAgentVersion} />)}
          </div>
        )}
      </div>

      {showModal && (
        <AddNodeModal
          onClose={() => setShowModal(false)}
          onCreated={load}
        />
      )}
    </Layout>
  );
}
