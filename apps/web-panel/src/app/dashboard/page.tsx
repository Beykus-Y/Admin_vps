"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Layout from "@/components/Layout";
import { api, Overview } from "@/lib/api";
import { Server, Box, AlertTriangle, CheckCircle } from "lucide-react";

function StatCard({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg p-5">
      <div className="text-[#64748b] text-xs mb-1">{label}</div>
      <div className="text-3xl font-bold text-white">{value}</div>
      {sub && <div className="text-xs text-[#64748b] mt-1">{sub}</div>}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const cls = {
    info: "bg-blue-500/10 text-blue-400",
    warning: "bg-yellow-500/10 text-yellow-400",
    critical: "bg-red-500/10 text-red-400",
  }[severity] ?? "bg-gray-500/10 text-gray-400";
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{severity}</span>;
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) { router.push("/login"); return; }
    api.overview().then(setData).catch((e) => {
      if (e.message?.includes("401")) router.push("/login");
      else setError(e.message);
    });
  }, [router]);

  if (error) return <Layout><div className="p-8 text-red-400">{error}</div></Layout>;
  if (!data) return <Layout><div className="p-8 text-[#64748b]">Loading...</div></Layout>;

  return (
    <Layout>
      <div className="p-8">
        <h1 className="text-xl font-bold text-white mb-6">Infrastructure Overview</h1>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <StatCard label="Total Nodes" value={data.nodes.total} />
          <StatCard label="Online" value={data.nodes.online} sub={`${data.nodes.offline} offline`} />
          <StatCard label="Containers" value={data.containers.total} sub={`${data.containers.running} running`} />
          <StatCard label="Open Ports" value={data.ports.total} sub={`${data.ports.unexpected} unexpected`} />
          <StatCard label="Pending Nodes" value={data.nodes.pending} />
        </div>

        <h2 className="text-sm font-semibold text-[#64748b] uppercase tracking-wider mb-3">Recent Events</h2>
        {data.recent_events.length === 0 ? (
          <div className="flex items-center gap-2 text-[#64748b] text-sm">
            <CheckCircle size={16} className="text-green-500" />
            No recent warnings or alerts
          </div>
        ) : (
          <div className="bg-[#1a1d27] border border-[#2a2d3e] rounded-lg divide-y divide-[#2a2d3e]">
            {data.recent_events.map((e) => (
              <div key={e.id} className="flex items-start gap-3 p-4">
                <SeverityBadge severity={e.severity} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{e.message}</div>
                  <div className="text-xs text-[#64748b] mt-0.5">{new Date(e.created_at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
