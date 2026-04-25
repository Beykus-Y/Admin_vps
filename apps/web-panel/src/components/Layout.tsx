"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { LayoutDashboard, Server, LogOut, ArrowUpCircle, Loader2 } from "lucide-react";
import clsx from "clsx";
import { api, VersionInfo } from "@/lib/api";

export default function Layout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [masterUpdateLoading, setMasterUpdateLoading] = useState(false);
  const [masterUpdateMsg, setMasterUpdateMsg] = useState<string | null>(null);

  useEffect(() => {
    api.version().then(setVersionInfo).catch(() => null);
  }, []);

  function logout() {
    localStorage.removeItem("token");
    router.push("/login");
  }

  async function updateMaster() {
    if (!window.confirm("Schedule master update now?")) return;
    setMasterUpdateLoading(true);
    setMasterUpdateMsg(null);
    try {
      const task = await api.master.update();
      setMasterUpdateMsg(`task ${task.id.slice(0, 8)} created`);
    } catch (err: unknown) {
      setMasterUpdateMsg(err instanceof Error ? err.message : "update failed");
    } finally {
      setMasterUpdateLoading(false);
    }
  }

  const nav = [
    { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
    { href: "/nodes", label: "Nodes", icon: Server },
  ];

  return (
    <div className="flex h-screen bg-[#0f1117]">
      <aside className="w-52 border-r border-[#2a2d3e] flex flex-col">
        <div className="p-4 border-b border-[#2a2d3e]">
          <span className="text-white font-bold text-sm tracking-wide">FilinControl</span>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors",
                pathname === href || pathname.startsWith(href + "/")
                  ? "bg-[#0ea5e9]/10 text-[#0ea5e9]"
                  : "text-[#64748b] hover:text-white hover:bg-[#1a1d27]"
              )}
            >
              <Icon size={15} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-[#2a2d3e]">
          {versionInfo && (
            <div className="px-4 py-2 space-y-0.5">
              <div className="flex justify-between text-[10px] text-[#475569]">
                <span>master</span>
                <span className="font-mono">{versionInfo.master_version}</span>
              </div>
              {versionInfo.latest_agent_version && (
                <div className="flex justify-between text-[10px] text-[#475569]">
                  <span>agent latest</span>
                  <span className="font-mono">{versionInfo.latest_agent_version}</span>
                </div>
              )}
            </div>
          )}
          <div className="px-3 pb-2">
            <button
              onClick={updateMaster}
              disabled={masterUpdateLoading}
              className="flex items-center gap-2 px-3 py-2 rounded text-sm text-[#64748b] hover:text-[#0ea5e9] hover:bg-[#0ea5e9]/10 w-full transition-colors disabled:opacity-50"
              title="Pull latest master images and restart the master stack through the master agent"
            >
              {masterUpdateLoading ? <Loader2 size={15} className="animate-spin" /> : <ArrowUpCircle size={15} />}
              Update Master
            </button>
            {masterUpdateMsg && <div className="px-3 pt-1 text-[10px] text-[#64748b] break-words">{masterUpdateMsg}</div>}
          </div>
          <div className="p-3 pt-1">
            <button
              onClick={logout}
              className="flex items-center gap-2 px-3 py-2 rounded text-sm text-[#64748b] hover:text-white hover:bg-[#1a1d27] w-full transition-colors"
            >
              <LogOut size={15} />
              Logout
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
