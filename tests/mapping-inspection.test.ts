import { describe, expect, it } from "vitest";
import { ConfiguratorLinks } from "../src/editor/configurator-overlay";
import { segmentVisible } from "../src/editor/inspection-overlay";
import { rulerLabel, rulerMeasurement, rulerPoint } from "../src/editor/ruler";
import { MapDocument } from "../src/map/document";
import { mapNodeTopology } from "../src/map/node-networks";
import type { PrototypeData, PrototypeIndex } from "../src/pack/format";
import { Pack } from "../src/pack/loader";
import { Scene } from "../src/render/scene";

const savedMap = `meta:
  format: 7
tilemap:
  0: Space
grids:
- 1
- 2
entities:
- proto: ""
  entities:
  - uid: 1
    components:
    - type: Transform
      pos: 10,0
      rot: 1.5707963267948966 rad
      parent: 3
    - type: MapGrid
      chunks: {}
  - uid: 2
    components:
    - type: Transform
      pos: 25,0
      parent: 3
    - type: MapGrid
      chunks: {}
  - uid: 3
    components:
    - type: Map
...
`;

const pipe = (pipeDirection: string) => ({ "!type": "PipeNode", nodeGroupID: "Pipe", pipeDirection });
const cable = (type: string, nodeGroupID = "HVPower") => ({ "!type": type, nodeGroupID });
const components = (nodes: Record<string, object>) => ({ Transform: { anchored: true }, NodeContainer: { nodes } });
const pipeColor = { AtmosPipeColor: { color: "#FFFFFFFF" } };
const prototypes: PrototypeData["entities"] = {
    Pipe: { components: { ...components({ pipe: pipe("Lateral") }), ...pipeColor } },
    Valve: { components: { ...components({ inlet: pipe("West"), outlet: pipe("East") }), GasValve: {} } },
    Cable: { components: components({ power: cable("CableNode") }) },
    CableMV: { components: components({ power: cable("CableNode", "MVPower") }) },
    Device: { components: components({ power: cable("CableDeviceNode") }) },
    Terminal: { components: components({ power: cable("CableTerminalNode") }) },
    TerminalPort: { components: components({ power: cable("CableTerminalPortNode") }) },
    ExtensionReceiver: { components: components({ power: cable("ApcExtensionCableReceiverNode", "Apc") }) },
};

function open() {
    const entities = Object.fromEntries(Object.entries(prototypes).map(([name, value]) => [name, { name, components: value.components }]));
    const index: PrototypeIndex = {
        entities, tiles: { Floor: { name: "Floor", sprite: null, variants: 1, isSubfloor: false } },
        decals: {}, stacks: {}, colors: {}, migrations: {}, tileAliases: {},
    };
    const pack = Pack.fromData({
        format: 1, fork: { id: "test", repo: "", branch: "", commit: "", engineCommit: null }, builtAt: "",
        files: { prototypes: "", textures: "" }, stats: { entities: 0, placeable: 0, tiles: 0, decals: 0, rsi: 0, frames: 0, pages: 0 },
    }, index, { pages: [], textures: {}, rsi: {} });
    const doc = new MapDocument(savedMap);
    const scene = new Scene(doc, pack);
    doc.onChange((change) => scene.apply(change));
    return { doc, scene, pack };
}

describe("ruler", () => {
    it("snaps in local grid coordinates and reports world axes across grids without editing the map", () => {
        const { doc, scene } = open();
        doc.setTile(1, -2, -3, "Floor");
        doc.setTile(1, 1, 1, "Floor");
        doc.setTile(2, 0, 0, "Floor");
        const date = new Date(2026, 0, 1);
        const before = doc.serialize(date);
        const a = rulerPoint(scene, scene.toWorld(1, -1.8, -2.8), "centers");
        const b = rulerPoint(scene, scene.toWorld(1, 1.1, 1.3), "centers");
        expect(rulerLabel(scene, a, b)).toBe("5 tiles · ΔX 3 · ΔY 4 · Grid #1");
        const next = rulerPoint(scene, scene.toWorld(1, -0.6, -2.8), "centers");
        expect(rulerMeasurement(scene, a, next).distance).toBeCloseTo(1);
        const corner = rulerPoint(scene, scene.toWorld(1, -1.8, -2.8), "corners");
        expect(corner.world).toEqual(scene.toWorld(1, -2, -3));
        const free = rulerPoint(scene, [25.31, 0.65], "free");
        expect(free).toEqual({ grid: 2, world: [25.31, 0.65] });
        expect(rulerMeasurement(scene, a, free).dx).toBeCloseTo(free.world[0] - a.world[0]);
        expect(rulerLabel(scene, a, free)).toContain("World axes");
        expect(doc.serialize(date)).toBe(before);
    });
});

describe("network configurator overlay", () => {
    it("indexes every saved list and updates after an edit and undo, with shared and missing members", () => {
        const { doc } = open();
        const a = doc.addEntity("Device", 1, 0.5, 0.5);
        const b = doc.addEntity("Device", 1, 1.5, 0.5);
        const target = doc.addEntity("Device", 1, 2.5, 0.5);
        doc.setComponent(a, "DeviceList", `devices:\n- ${target}\n- 999\n- ${target}`);
        doc.setComponent(b, "DeviceList", `devices:\n- ${target}`);
        const index = new ConfiguratorLinks(doc);
        doc.onChange((change) => index.update(change.entities));
        expect(index.lists).toEqual(new Map([[a, [target, 999]], [b, [target]]]));
        doc.setComponent(a, "DeviceList", "devices: []");
        expect(index.lists).toEqual(new Map([[b, [target]]]));
        doc.undo();
        expect(index.lists).toEqual(new Map([[a, [target, 999]], [b, [target]]]));
    });

    it("culls lines outside the view and keeps lines crossing it from off screen", () => {
        expect(segmentVisible([-5, 10], [25, 10], 20, 20, 0)).toBe(true);
        expect(segmentVisible([-5, 6], [6, -5], 20, 20, 0)).toBe(true);
        expect(segmentVisible([-10, 6], [6, -10], 20, 20, 0)).toBe(false);
    });
});

describe("physical node topology", () => {
    it("uses the color command's valve connections and reports open pipe directions", () => {
        const { doc, pack, scene } = open();
        const data = { entities: prototypes };
        const a = doc.addEntity("Pipe", 1, 0.5, 0.5);
        const valve = doc.addEntity("Valve", 1, 1.5, 0.5);
        const b = doc.addEntity("Pipe", 1, 2.5, 0.5);
        const topology = mapNodeTopology(doc, scene, pack, data);
        expect(topology.nodes.find((node) => node.uid === a)?.openEnds).toEqual([[-1, 0]]);
        expect(topology.edges).toHaveLength(3);
        expect(topology.edges.some(([x, y]) => x.uid === valve && y.uid === valve)).toBe(true);
        expect(new Set(scene.pipeNetwork(a, "pipe", data))).toEqual(new Set([a, b]));
        doc.setComponent(valve, "GasValve", "open: false");
        expect(mapNodeTopology(doc, scene, pack, data).edges).toHaveLength(2);
        expect(scene.pipeNetwork(a, "pipe", data)).toEqual([a]);
    });

    it("uses tagged power nodes per group and grid, and a terminal blocks a direct cable edge", () => {
        const { doc, scene, pack } = open();
        const data = { entities: prototypes };
        const a = doc.addEntity("Cable", 1, 0.5, 0.5);
        const b = doc.addEntity("Cable", 1, 1.5, 0.5);
        const mv = doc.addEntity("CableMV", 1, 1.5, 0.5);
        const device = doc.addEntity("Device", 1, 0.5, 0.5);
        const port = doc.addEntity("TerminalPort", 1, 1.5, 0.5);
        const terminal = doc.addEntity("Terminal", 1, 0.5, 0.5, Math.PI / 2);
        const receiver = doc.addEntity("ExtensionReceiver", 1, 0.5, 0.5);
        doc.addEntity("Cable", 2, 0.5, 0.5);
        const edges = () => mapNodeTopology(doc, scene, pack, data).edges.map(([x, y]) => [x.uid, y.uid].sort((a, b) => a - b).join(":")).sort();
        const edge = (x: number, y: number) => [x, y].sort((a, b) => a - b).join(":");
        expect(edges()).toEqual([edge(a, device), edge(a, terminal), edge(port, terminal)].sort());
        const topology = mapNodeTopology(doc, scene, pack, data);
        expect(topology.nodes.find((node) => node.uid === mv)?.kind).toBe("mv");
        expect(topology.nodes.find((node) => node.uid === receiver)?.incomplete).toBe(true);
        doc.setComponent(device, "NodeContainer", "nodes:\n  disabled: !type:CableDeviceNode\n    nodeGroupID: HVPower\n    enabled: false");
        expect(edges()).toEqual([edge(a, terminal), edge(port, terminal)].sort());
        doc.deleteEntity(terminal);
        expect(edges()).toEqual([edge(a, b)]);
        const partial = mapNodeTopology(doc, scene, pack, null);
        expect(partial.nodes.map((node) => [node.uid, node.name, node.type])).toEqual([[device, "disabled", "CableDeviceNode"]]);
    });
});
