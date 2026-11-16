import { NETWORK_KINDS, type NetworkKind, type NetworkNode, type NetworkTopology } from "../map/node-networks";
import { PPM, SpatialIndex, type Scene } from "../render/scene";
import { segmentVisible, type InspectionHint } from "./inspection-overlay";
import type { OverlayContext } from "./selection-overlay";
import type { Point } from "./shapes";

export type NetworkFilter = "all" | NetworkKind;
const COLORS: Record<NetworkKind, string> = { pipes: "#68dcff", hv: "#ff9260", mv: "#ffd263", lv: "#9bf477" };
const PIPE_LAYERS: Record<string, string> = { Secondary: "#bfb1ff", Tertiary: "#5ee1cf" };
const color = (node: NetworkNode) => node.incomplete ? "#b9bdcd" : (node.layer && PIPE_LAYERS[node.layer]) || COLORS[node.kind];

interface PlacedNode {
    node: NetworkNode;
    x: number;
    y: number;
    ext: number;
    ends: Point[];
    network: NetworkNode;
}
interface PlacedEdge {
    a: PlacedNode;
    b: PlacedNode;
    x: number;
    y: number;
    ext: number;
}

export class NodeOverlay {
    private readonly nodes = new SpatialIndex<PlacedNode>();
    private readonly edges = new SpatialIndex<PlacedEdge>();
    private readonly sizes = new Map<NetworkNode, number>();
    private readonly incomplete = new Set<NetworkKind>();
    private readonly kinds = new Set<NetworkKind>();

    constructor(scene: Scene, topology: NetworkTopology) {
        const parent = new Map<NetworkNode, NetworkNode>();
        const root = (node: NetworkNode) => {
            while (parent.has(node)) {
                const next = parent.get(node)!;
                const after = parent.get(next);
                if (after) parent.set(node, after);
                node = after ?? next;
            }
            return node;
        };
        for (const [a, b] of topology.edges) {
            const ra = root(a), rb = root(b);
            if (ra !== rb) parent.set(ra, rb);
        }
        const tiles = new Map<string, NetworkNode[]>();
        for (const node of topology.nodes) {
            const k = `${node.grid}|${node.cell[0]}|${node.cell[1]}`;
            const tile = tiles.get(k);
            if (tile) tile.push(node);
            else tiles.set(k, [node]);
        }
        const positions = new Map<NetworkNode, PlacedNode>();
        for (const tile of tiles.values()) {
            tile.sort((a, b) => NETWORK_KINDS.indexOf(a.kind) - NETWORK_KINDS.indexOf(b.kind) || a.uid - b.uid || a.name.localeCompare(b.name));
            tile.forEach((node, i) => {
                const [tx, ty] = node.cell;
                const angle = Math.PI + 2 * Math.PI * i / tile.length;
                const radius = tile.length === 1 ? 0 : Math.min(0.37, 0.15 + 0.028 * tile.length);
                const [x, y] = scene.toWorld(node.grid, tx + 0.5 + radius * Math.cos(angle), ty + 0.5 + radius * Math.sin(angle));
                const ends = (node.openEnds ?? []).map(([dx, dy]) => scene.toWorld(node.grid, tx + 0.5 + 0.46 * dx, ty + 0.5 + 0.46 * dy));
                const network = root(node);
                const position = { node, x, y, ext: ends.length ? 0.9 : 0, ends, network };
                positions.set(node, position);
                this.nodes.add(position);
                this.sizes.set(network, (this.sizes.get(network) ?? 0) + 1);
                this.kinds.add(node.kind);
                if (node.incomplete) this.incomplete.add(node.kind);
            });
        }
        for (const [from, to] of topology.edges) {
            const a = positions.get(from)!, b = positions.get(to)!;
            this.edges.add({ a, b, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ext: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) / 2 });
        }
    }

    status(filter: NetworkFilter): string {
        if (filter === "all" ? this.incomplete.size : this.incomplete.has(filter)) return "Partial topology · unsupported nodes shown in gray";
        if (!(filter === "all" ? this.kinds.size : this.kinds.has(filter))) return "No matching nodes";
        return "";
    }

    draw(c: OverlayContext, filter: NetworkFilter, cursor: Point | null, label: (uid: number) => string): InspectionHint | null {
        const { g, map, width, height } = c;
        const a = map.worldAt(-10, height + 10), b = map.worldAt(width + 10, -10);
        if (!a || !b) return null;
        const detail = PPM * map.view.scale >= 10;
        const matches = (n: PlacedNode) => filter === "all" || n.node.kind === filter;
        const point = (n: PlacedNode) => map.screenAt(n.x, n.y);
        const nodes = this.nodes.query(...a, ...b).filter(matches);
        const edges = this.edges.query(...a, ...b).filter(({ a }) => matches(a));
        const screen = new Map(nodes.map((n) => [n, point(n)]));
        let hover: PlacedNode | null = null, distance = 8;
        if (cursor) for (const [node, [x, y]] of screen) {
            const d = Math.hypot(cursor[0] - x, cursor[1] - y);
            if (d < distance) [hover, distance] = [node, d];
        }
        const isFocused = (node: PlacedNode) => node.network === hover?.network;
        g.save();
        g.lineCap = "round";
        for (const focused of [false, true]) {
            if (focused && !hover) continue;
            const paths = new Map<string, Path2D>();
            const path = (col: string) => {
                let p = paths.get(col);
                if (!p) paths.set(col, (p = new Path2D()));
                return p;
            };
            for (const { a, b } of edges) {
                if (isFocused(a) !== focused) continue;
                const from = screen.get(a) ?? point(a), to = screen.get(b) ?? point(b);
                if (!segmentVisible(from, to, width, height)) continue;
                const p = path(color(a.node));
                p.moveTo(...from);
                p.lineTo(...to);
            }
            if (detail) {
                for (const [node, from] of screen) {
                    if (isFocused(node) !== focused) continue;
                    for (const end of node.ends) {
                        const to = map.screenAt(...end);
                        if (!segmentVisible(from, to, width, height)) continue;
                        const p = path("#ff8189");
                        p.moveTo(...from);
                        p.lineTo(...to);
                    }
                }
            }
            g.globalAlpha = hover && !focused ? 0.32 : 1;
            for (const [col, p] of paths) {
                g.lineWidth = focused ? 6 : 4;
                g.strokeStyle = "#182631";
                g.stroke(p);
                g.lineWidth = focused ? 3 : 1.6;
                g.strokeStyle = col;
                g.stroke(p);
            }
            const dots = new Map<string, Path2D>();
            for (const [node, [x, y]] of screen) {
                if (isFocused(node) !== focused || x < -6 || y < -6 || x > width + 6 || y > height + 6) continue;
                if (!detail && !focused && this.sizes.get(node.network)! > 1) continue;
                const col = color(node.node), radius = node === hover ? 5.5 : focused ? 4 : 2.7;
                let p = dots.get(col);
                if (!p) dots.set(col, (p = new Path2D()));
                p.moveTo(x + radius, y);
                p.arc(x, y, radius, 0, 2 * Math.PI);
            }
            for (const [col, p] of dots) {
                g.fillStyle = col;
                g.strokeStyle = "#182631";
                g.lineWidth = 2;
                g.stroke(p);
                g.fill(p);
            }
        }
        g.restore();
        if (!hover || !cursor) return null;
        const { node, network } = hover;
        const type = [node.type, node.group, node.layer].filter(Boolean).join(" · ");
        const size = this.sizes.get(network);
        const coordinates = `Grid #${node.grid} · ${node.cell.join(", ")} · ${size} ${size === 1 ? "node" : "nodes"}`;
        return {
            at: cursor,
            lines: [`${label(node.uid)} · ${node.name}`, type, coordinates,
                ...(node.incomplete ? ["Partial topology for this node"] : node.openEnds?.length ? [`Open directions: ${node.openEnds.length}`] : [])],
        };
    }
}
