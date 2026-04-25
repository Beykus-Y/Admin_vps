"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, LockKeyhole } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await api.login(username, password);
      localStorage.setItem("token", res.access_token);
      await refresh();
      router.push("/dashboard");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось войти");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0c0e16] p-4 text-[#dde2f0]">
      <div className="absolute left-1/2 top-[-20%] h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[#4ade80]/10 blur-[110px]" />
      <div className="absolute bottom-[-20%] right-[-10%] h-[420px] w-[420px] rounded-full bg-[#38bdf8]/10 blur-[120px]" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[#1d2135] bg-[#111420] text-[#4ade80] shadow-[0_18px_55px_rgba(0,0,0,0.25)]">
            <LockKeyhole size={22} />
          </div>
          <h1 className="font-mono text-2xl font-semibold tracking-[0.08em] text-[#4ade80]">Filin<span className="font-normal text-[#2a3355]">Control</span></h1>
          <p className="mt-2 text-sm text-[#4a5170]">Панель управления VPS-инфраструктурой</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-2xl border border-[#1d2135] bg-[#111420]/95 p-6 shadow-[0_24px_90px_rgba(0,0,0,0.42)] backdrop-blur">
          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">Логин</label>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-3 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.14em] text-[#4a5170]">Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-[#1d2135] bg-[#0c0e16] px-3 py-3 text-sm text-[#dde2f0] outline-none transition placeholder:text-[#2a3355] focus:border-[#4ade80]/70"
              required
            />
          </div>
          {error && <p className="rounded-lg border border-[#f87171]/20 bg-[#f87171]/10 px-3 py-2 font-mono text-xs text-[#f87171]">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-[#4ade80]/60 bg-[#4ade80] px-4 py-3 text-sm font-bold text-[#06110a] transition hover:bg-[#63ef93] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? "Вхожу..." : "Войти"}
          </button>
        </form>
      </div>
    </div>
  );
}
