import type { Point } from "../editor/shapes";
import type { PrototypeData } from "../pack/format";
import type { Pack } from "../pack/loader";
import type { Scene } from "../render/scene";
import type { MapDocument } from "./document";
import { toPlain } from "./yaml";

export const NETWORK_KINDS = ["pipes", "hv", "mv", "lv"] as const;
export type NetworkKind = typeof NETWORK_KINDS[number];

export interface NetworkNode {
    uid: number;
    name: string;
    type: string;
    kind: NetworkKind;
    group: string;
    grid: number;
    cell: Point;
    layer?: string;
    openEnds?: Point[];
    incomplete?: boolean;
}

export interface NetworkTopology {
    nodes: NetworkNode[];
    edges: Array<[NetworkNode, NetworkNode]>;
}

interface NodeDefinition {
    "!type"?: string;
    nodeGroupID?: string;
    enabled?: boolean;
    pipeDirection?: unknown;
}

/** Read saved node tags directly: ordinary scene data intentionally drops YAML tags. */
function definitions(doc: MapDocument, pack: Pack, data: PrototypeData | null, uid: number, proto: string): Record<string, NodeDefinition> {
    const saved = doc.componentField(uid, "NodeContainer", "nodes");
    if (saved) {
        if (saved.kind !== "map") return {};
        return Object.fromEntries(saved.entries.map(({ key, value }) => [
            key.value,
            { ...toPlain(value) as NodeDefinition, "!type": value.tag?.startsWith("!type:") ? value.tag.slice(6) : undefined },
        ]));
    }
    return data && proto ? (pack.fullComponents(data, proto).NodeContainer?.nodes as Record<string, NodeDefinition> ?? {}) : {};
}

const CARDINAL: readonly Point[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const direction = (rot: number, count: 4 | 8): Point => {
    const angle = Math.round(rot / (2 * Math.PI / count)) * (2 * Math.PI / count);
    return [Math.round(Math.sin(angle)), -Math.round(Math.cos(angle))];
};
const key = (grid: number, x: number, y: number) => `${grid}|${x}|${y}`;

function powerKind(group: string): NetworkKind | null {
    if (group === "HVPower") return "hv";
    if (group === "MVPower") return "mv";
    if (group === "Apc" || group === "ExCable") return "lv";
    return null;
}

const POWER_TYPES = new Set(["CableNode", "CableDeviceNode", "CableTerminalNode", "CableTerminalPortNode"]);
interface PowerNode extends NetworkNode {
    rotation: number;
    enabled: boolean;
}

/** Cable connections from the saved nodes, including terminals that interrupt a cable in their direction. */
function addPowerEdges(topology: NetworkTopology, power: readonly PowerNode[]): void {
    const cells = new Map<string, PowerNode[]>();
    for (const node of power) {
        const k = key(node.grid, ...node.cell);
        const cell = cells.get(k);
        if (cell) cell.push(node);
        else cells.set(k, [node]);
    }
    const connected = new Map<NetworkNode, Set<NetworkNode>>();
    const connect = (a: PowerNode, b: PowerNode) => {
        if (a === b || a.group !== b.group || !a.enabled || !b.enabled || a.incomplete || b.incomplete || connected.get(b)?.has(a)) return;
        let neighbors = connected.get(a);
        if (!neighbors) connected.set(a, (neighbors = new Set()));
        if (neighbors.has(b)) return;
        neighbors.add(b);
        topology.edges.push([a, b]);
    };
    const blocks = (nodes: readonly PowerNode[], dx: number, dy: number) => nodes.some((n) => {
        // The engine checks for terminals before filtering by node group or Enabled.
        if (n.type !== "CableTerminalNode") return false;
        const [tx, ty] = direction(n.rotation, 4);
        return tx === dx && ty === dy;
    });
    for (const node of power) {
        const { grid, cell: [x, y], type, rotation } = node;
        if (!node.enabled || node.incomplete) continue;
        const here = cells.get(key(grid, x, y)) ?? [];
        if (type === "CableNode") {
            for (const other of here) {
                if (other.type === "CableNode" || other.type === "CableDeviceNode" || other.type === "CableTerminalNode") connect(node, other);
            }
            for (const [dx, dy] of CARDINAL) {
                const there = cells.get(key(grid, x + dx, y + dy)) ?? [];
                if (blocks(here, dx, dy) || blocks(there, -dx, -dy)) continue;
                for (const other of there) if (other.type === "CableNode") connect(node, other);
            }
        } else if (type === "CableTerminalNode") {
            const [dx, dy] = direction(rotation, 8);
            for (const other of cells.get(key(grid, x + dx, y + dy)) ?? []) {
                if (other.type === "CableTerminalPortNode") connect(node, other);
            }
        } else if (type === "CableTerminalPortNode") {
            for (const [dx, dy] of CARDINAL) {
                for (const other of cells.get(key(grid, x + dx, y + dy)) ?? []) {
                    if (other.type === "CableTerminalNode" && blocks([other], -dx, -dy)) connect(node, other);
                }
            }
        }
    }
}

export function mapNodeTopology(doc: MapDocument, scene: Scene, pack: Pack, data: PrototypeData | null): NetworkTopology {
    const topology = scene.pipeTopology(data ?? undefined);
    const pipeByUid = new Map<number, Map<string, NetworkNode>>();
    for (const node of topology.nodes) {
        let ports = pipeByUid.get(node.uid);
        if (!ports) pipeByUid.set(node.uid, (ports = new Map()));
        ports.set(node.name, node);
    }
    const power: PowerNode[] = [];
    for (const uid of doc.uids()) {
        const p = scene.placement(uid);
        if (p?.grid == null || !p.anchored) continue;
        const proto = pack.migrate(doc.proto(uid) ?? "") ?? "";
        const ports = pipeByUid.get(uid);
        const cell: Point = [Math.floor(p.x), Math.floor(p.y)];
        for (const [name, d] of Object.entries(definitions(doc, pack, data, uid, proto))) {
            if (!d || typeof d !== "object") continue;
            const type = d["!type"] ?? "Unknown";
            const pipe = ports?.get(name);
            if (pipe) {
                pipe.type = type;
                pipe.incomplete = type !== "PipeNode";
            } else if (d.nodeGroupID === "Pipe" && d.pipeDirection === undefined) {
                // Special pipe nodes can bind at runtime, for example a portable canister or a docking port.
                topology.nodes.push({ uid, name, type, cell, grid: p.grid, group: "Pipe", kind: "pipes", incomplete: true });
            } else {
                const group = d.nodeGroupID ?? "";
                const kind = powerKind(group);
                if (!kind) continue;
                const incomplete = !POWER_TYPES.has(type) || group === "ExCable";
                const enabled = String(d.enabled ?? true).toLowerCase() !== "false";
                const node: PowerNode = { uid, name, type, group, grid: p.grid, cell, kind, rotation: p.rot, enabled, incomplete };
                power.push(node);
                topology.nodes.push(node);
            }
        }
    }
    for (const node of topology.nodes) {
        if (node.kind === "pipes" && node.incomplete) delete node.openEnds;
    }
    addPowerEdges(topology, power);
    return topology;
}
