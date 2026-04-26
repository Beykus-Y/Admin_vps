import { SubProxyNode } from "@/lib/api";

export interface SubProxyNodeGroup {
  host: string;
  nodeName: string | null;
  fragments: string[];
}

export function subscriptionStatusLabel(status: string | null | undefined): string {
  return {
    active: "активен",
    disabled: "выкл",
    expired: "истёк",
    limited: "лимит",
    on_hold: "на паузе",
  }[status ?? ""] ?? (status || "неизвестно");
}

export function subscriptionStatusColor(status: string | null | undefined): "green" | "red" | "yellow" | "gray" {
  if (status === "active") return "green";
  if (status === "limited") return "yellow";
  if (status === "disabled" || status === "expired") return "red";
  return "gray";
}

export function parseHostFromUri(uri: string): string | null {
  try {
    if (!uri.includes("://")) return null;
    const [scheme, restRaw] = uri.split("://", 2);
    let rest = restRaw.split("#", 1)[0].split("?", 1)[0];
    let auth = rest.split("/", 1)[0];
    if (auth.includes("@")) {
      auth = auth.slice(auth.lastIndexOf("@") + 1);
    } else if (scheme.toLowerCase() === "ss") {
      try {
        const decoded = atob(auth.replace(/-/g, "+").replace(/_/g, "/"));
        if (decoded.includes("@")) {
          auth = decoded.slice(decoded.lastIndexOf("@") + 1);
        }
      } catch {}
    }
    if (auth.startsWith("[")) {
      return auth.slice(1, auth.indexOf("]")) || null;
    }
    return auth.split(":", 1)[0] || null;
  } catch {
    return null;
  }
}

export function parseFragmentFromUri(uri: string): string | null {
  try {
    if (!uri.includes("#")) return null;
    return decodeURIComponent(uri.split("#", 2)[1]) || null;
  } catch {
    return null;
  }
}

export function buildNodeGroups(links: string[], nodes: SubProxyNode[]): SubProxyNodeGroup[] {
  const configsByHost = new Map<string, string[]>();
  const hostOrder: string[] = [];

  links.forEach((uri) => {
    const scheme = uri.split("://", 1)[0]?.toLowerCase();
    if (scheme === "hysteria2") return;
    const host = parseHostFromUri(uri);
    const fragment = parseFragmentFromUri(uri);
    if (!host || !fragment) return;
    if (!configsByHost.has(host)) {
      configsByHost.set(host, []);
      hostOrder.push(host);
    }
    const existing = configsByHost.get(host)!;
    if (!existing.includes(fragment)) existing.push(fragment);
  });

  const nodeByAddress = new Map(nodes.map((node) => [node.address, node.name]));
  return hostOrder.map((host) => ({
    host,
    nodeName: nodeByAddress.get(host) ?? null,
    fragments: configsByHost.get(host) ?? [],
  }));
}
