import { api } from "@/lib/api";
import type { Container, Node, NodeEvent, NodeMetric, Port } from "@/lib/api";

export interface InventoryNode {
  node: Node;
  containers: Container[];
  ports: Port[];
  metrics: NodeMetric | null;
  events: NodeEvent[];
}

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
  const nodes = await api.nodes.list();

  return Promise.all(
    nodes.map(async (node) => {
      const [containers, ports, metrics, events] = await Promise.all([
        api.nodes.containers(node.id).catch(() => [] as Container[]),
        api.nodes.ports(node.id).catch(() => [] as Port[]),
        api.nodes.metricsLatest(node.id).catch(() => null as NodeMetric | null),
        api.nodes.events(node.id).catch(() => [] as NodeEvent[]),
      ]);

      return { node, containers, ports, metrics, events };
    })
  );
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
    .flatMap(({ node, events }) =>
      events.map((event) => ({
        ...event,
        node_id: event.node_id ?? node.id,
        node_name: node.name,
      }))
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}
