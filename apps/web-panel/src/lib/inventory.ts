import { api } from "@/lib/api";
import type { Container, InventoryNode as ApiInventoryNode, Node, NodeEvent, NodeMetric, Port } from "@/lib/api";

export interface InventoryNode extends ApiInventoryNode {}

export interface InventoryContainer extends Container {
  node_id: string;
  node_name: string;
  node_status: string;
  node_ip: string | null;
}

export interface InventoryPort extends Port {
  node_id: string;
  node_name: string;
  node_status: string;
  node_ip: string | null;
}

export interface InventoryEvent extends NodeEvent {
  node_name: string;
}

export function primaryNodeIP(node: Node): string | null {
  return node.public_ip || node.local_ips?.find((ip) => !ip.includes(":")) || node.local_ips?.[0] || null;
}

export function isMasterNode(node: Node): boolean {
  return node.tags?.includes("master") || node.group_name === "master";
}

export async function loadInventory(): Promise<InventoryNode[]> {
  const snapshot = await api.inventory.get();
  return snapshot.nodes;
}

export async function loadInventorySnapshot() {
  return api.inventory.get();
}

export function flattenContainers(inventory: InventoryNode[]): InventoryContainer[] {
  return inventory.flatMap(({ node, containers }) =>
    containers.map((container) => ({
      ...container,
      node_id: node.id,
      node_name: node.name,
      node_status: node.status,
      node_ip: primaryNodeIP(node),
    }))
  );
}

export function flattenPorts(inventory: InventoryNode[]): InventoryPort[] {
  return inventory.flatMap(({ node, ports }) =>
    ports.map((port) => ({
      ...port,
      node_id: node.id,
      node_name: node.name,
      node_status: node.status,
      node_ip: primaryNodeIP(node),
    }))
  );
}

export function flattenEvents(inventory: InventoryNode[]): InventoryEvent[] {
  return inventory
    .flatMap(({ node, incidents }) =>
      incidents.map((incident) => ({
        id: incident.id,
        node_id: node.id,
        node_name: node.name,
        severity: incident.severity,
        type: incident.rule_kind,
        message: incident.message,
        created_at: incident.last_seen_at,
      }))
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function latestMetric(item: InventoryNode): NodeMetric | null {
  return item.metrics;
}
