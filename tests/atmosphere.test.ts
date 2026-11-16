import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { colorPipeNetwork } from "../src/editor/pipe-network";
import { fixGridAtmosphere } from "../src/map/atmosphere";
import { MapDocument } from "../src/map/document";
import type { PrototypeData, PrototypeIndex } from "../src/pack/format";
import { Pack } from "../src/pack/loader";
import { Scene } from "../src/render/scene";
import { packFor } from "./pack-files";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";

const now = new Date(2026, 10, 16, 0, 0, 0);
const UPSTREAM = "https://github.com/space-wizards/space-station-14";
const FRONTIER = "https://github.com/new-frontiers-14/frontier-station-14";
const TRIAD = "https://github.com/Triad-Sector/Triad_Sector";
const floor = { name: "Floor", sprite: null, variants: 1, isSubfloor: false };
const node = (pipeDirection: string, options: object = {}) => ({ pipeDirection, ...options });
const parts = (nodes: Record<string, object>) => ({ Transform: { anchored: true }, NodeContainer: { nodes } });
const paint = { AtmosPipeColor: { color: "#FFFFFFFF" } };
const definitions: PrototypeIndex["entities"] = {
    Wall: { name: "Wall", components: { Transform: { anchored: true } } },
    Marker: { name: "Marker", components: { Transform: { anchored: true } } },
    LooseMarker: { name: "Loose marker", components: {} },
    Pipe: { name: "Pipe", components: { ...parts({ pipe: node("Lateral") }), ...paint } },
    Bend: { name: "Bend", components: { ...parts({ pipe: node("NEBend") }), ...paint } },
    AltPipe: { name: "Alternate pipe", components: { ...parts({ pipe: node("Lateral") }), AtmosPipeLayers: { pipeLayer: "Secondary" }, ...paint } },
    ClosedPipe: { name: "Disabled pipe", components: { ...parts({ pipe: node("Lateral", { connectionsEnabled: false }) }), ...paint } },
    Pump: { name: "Pump", components: parts({ inlet: node("West"), outlet: node("East") }) },
    Valve: { name: "Valve", components: parts({ inlet: node("West"), outlet: node("East") }) },
};
const protoData: PrototypeData = {
    entities: {
        Wall: { parents: ["WallBase"], components: {} },
        WallBase: { components: { Airtight: {} } },
        Marker: { components: { AtmosFixMarker: { mode: 1 } } },
        LooseMarker: { parents: ["Marker"], components: {} },
        Valve: { components: { GasValve: {} } },
    },
};

const base = `meta:
  format: 7
tilemap:
  0: Space
grids: [1, 2]
entities:
- proto: ""
  entities:
  - uid: 1
    components:
    - type: Transform
      pos: 0,0
      parent: 3
    - type: MapGrid
      chunks: {}
  - uid: 2
    components:
    - type: Transform
      pos: 20,0
      parent: 3
    - type: MapGrid
      chunks: {}
  - uid: 3
    components:
    - type: Map
...
`;
// The game's writer uses block sequences for grids.
const text = base.replace("grids: [1, 2]", "grids:\n- 1\n- 2");

function open(repo = UPSTREAM) {
    const pack = Pack.fromData(
        { format: 1, fork: { id: "test", repo, branch: "", commit: "", engineCommit: null }, builtAt: "",
            files: { prototypes: "", textures: "" }, stats: { entities: 0, placeable: 0, tiles: 0, decals: 0, rsi: 0, frames: 0, pages: 0 } },
        { entities: definitions, tiles: { Floor: floor, Lattice: { ...floor, isSpace: true },
            LatticeCornerNE: { ...floor, sprite: "_Mono/Tiles/lattice/ne.png" } }, decals: {}, stacks: {}, colors: {}, migrations: {}, tileAliases: {} },
        { pages: [], textures: {}, rsi: {} },
    );
    const doc = new MapDocument(text);
    const scene = new Scene(doc, pack);
    doc.onChange((change) => scene.apply(change));
    return { doc, scene, pack };
}

type SavedMix = { temperature?: number; volume: number; moles: Record<string, number> | number[]; immutable?: boolean };
type SavedGrid = { chunkSize: number; uniqueMixes?: SavedMix[]; tiles?: Record<string, Record<string, number>> };

function mixAt(doc: MapDocument, grid: number, x: number, y: number): SavedMix | undefined {
    const data = doc.componentOverride(grid, "GridAtmosphere")?.data.data as SavedGrid | undefined;
    if (!data?.tiles || !data.uniqueMixes) return undefined;
    const size = data.chunkSize, cx = Math.floor(x / size), cy = Math.floor(y / size);
    const bit = 1 << (x - cx * size + (y - cy * size) * size);
    const entry = Object.entries(data.tiles[`${cx},${cy}`] ?? {}).find(([, bits]) => (bits & bit) !== 0);
    return entry ? data.uniqueMixes[Number(entry[0])] : undefined;
}

describe("fix grid atmosphere", () => {
    it("uses the selected grid, walls, anchored markers, negative chunks and the map's atmosphere", () => {
        const { doc, scene, pack } = open();
        doc.setTiles(1, [
            { x: -1, y: -1, name: "Floor" }, { x: 0, y: 0, name: "Floor" },
            { x: 1, y: 0, name: "Floor" }, { x: 2, y: 0, name: "Lattice" },
            { x: 3, y: 0, name: "Floor" },
        ]);
        doc.setTile(2, 0, 0, "Floor");
        doc.addEntity("Wall", 1, 0.5, 0.5);
        doc.addEntity("Marker", 1, 1.5, 0.5);
        doc.addEntity("LooseMarker", 1, 3.5, 0.5);
        doc.setComponent(3, "MapAtmosphere", "space: False\nmixture:\n  temperature: 275\n  volume: 2500\n  immutable: True\n  moles:\n    Nitrogen: 11");
        doc.setComponent(1, "GridAtmosphere", "version: 2\ndata:\n  chunkSize: 4\npaused: True");
        const before = doc.serialize(now);

        expect(fixGridAtmosphere(doc, scene, pack, protoData, 1)).toEqual({ changed: true, filled: 3, exposed: 1, sealed: 1 });
        expect(mixAt(doc, 1, -1, -1)).toEqual({ temperature: 293.15, volume: 2500, moles: { Oxygen: 21.824879, Nitrogen: 82.10312 } });
        expect(mixAt(doc, 1, 0, 0)).toBeUndefined();
        expect(mixAt(doc, 1, 1, 0)).toEqual({ temperature: 293.15, volume: 2500, moles: {} });
        expect(mixAt(doc, 1, 2, 0)).toEqual({ temperature: 275, volume: 2500, immutable: true, moles: { Nitrogen: 11 } });
        expect(mixAt(doc, 1, 3, 0)).toEqual(mixAt(doc, 1, -1, -1));
        expect(doc.componentOverride(1, "GridAtmosphere")?.data.paused).toBe(true);
        expect(doc.componentOverride(1, "GasTileOverlay")).toBeDefined();
        expect(doc.componentOverride(2, "GridAtmosphere")).toBeUndefined();
        expect(fixGridAtmosphere(doc, scene, pack, protoData, 1).changed).toBe(false);
        expect(doc.undo()).toBe("Fix grid atmosphere");
        expect(doc.serialize(now)).toBe(before);
    });

    it.each([[FRONTIER, 12, 12, 340], [TRIAD, 16, 11, 330]] as const)(
        "writes the correct legacy gas array and marker mix for %s", (repo, gasCount, markerMode, temperature) => {
            const { doc, scene, pack } = open(repo);
            const exposed = repo === TRIAD ? "LatticeCornerNE" : "Lattice";
            doc.setTiles(1, [{ x: 0, y: 0, name: "Floor" }, { x: 1, y: 0, name: exposed }]);
            const marker = doc.addEntity("Marker", 1, 0.5, 0.5);
            doc.setComponent(marker, "AtmosFixMarker", `mode: ${markerMode}`);
            fixGridAtmosphere(doc, scene, pack, protoData, 1);
            const mix = mixAt(doc, 1, 0, 0)!;
            expect(mix.temperature).toBe(temperature);
            expect(mix.moles).toHaveLength(gasCount);
            expect((mix.moles as number[])[5]).toBe(82.10312);
            expect(mixAt(doc, 1, 1, 0)).toMatchObject({ immutable: true, volume: 2500 });
        },
    );

    it("leaves the file untouched if a marker mode cannot be interpreted", () => {
        const { doc, scene, pack } = open();
        doc.setTile(1, 0, 0, "Floor");
        const uid = doc.addEntity("Marker", 1, 0.5, 0.5);
        doc.setComponent(uid, "AtmosFixMarker", "mode: 255");
        const before = doc.serialize(now);
        expect(() => fixGridAtmosphere(doc, scene, pack, protoData, 1)).toThrow(/mode 255/);
        expect(doc.serialize(now)).toBe(before);
    });

    for (const [fork, rel] of [
        ["upstream", "Resources/Maps/Shuttles/emergency_hike.yml"],
        ["frontier", "Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml"],
    ] as const) {
        const file = path.join(corpusRoot(), fork, rel);
        const pack = packFor(fork);
        it.skipIf(!pack || !fs.existsSync(file))(`round-trips an actual ${fork} shuttle and writes the saved format`, async () => {
            const text = fs.readFileSync(file, "utf8");
            const doc = new MapDocument(text);
            const scene = new Scene(doc, pack!);
            const data = (await pack!.prototypeData())!;
            const grid = scene.grids[0]!;
            const result = fixGridAtmosphere(doc, scene, pack!, data, grid);
            expect(result.filled).toBeGreaterThan(0);
            const reloaded = new MapDocument(doc.serialize(now));
            const atmos = reloaded.componentOverride(grid, "GridAtmosphere")!.data.data as SavedGrid;
            expect(atmos.chunkSize).toBe(4);
            for (const mix of atmos.uniqueMixes!) expect(Array.isArray(mix.moles)).toBe(fork === "frontier");
            if (result.changed) {
                expect(doc.undo()).toBe("Fix grid atmosphere");
                expect(doc.serialize(now)).toBe(text);
            }
        });
    }
});

describe("color pipe network", () => {
    it("follows a turned bend and stops at different layers, disabled connections and a pump's separate port", () => {
        const { doc, scene } = open();
        const place = (proto: string, x: number, y: number, rot = 0) => doc.addEntity(proto, 1, x + 0.5, y + 0.5, rot);
        const a = place("Pipe", 0, 0);
        const bend = place("Bend", 1, 0, Math.PI / 2);
        const next = place("Pipe", 1, 1, Math.PI / 2);
        const pump = place("Pump", 1, 2, Math.PI / 2);
        const differentCircuit = place("Pipe", 1, 3, Math.PI / 2);
        const otherLayer = place("AltPipe", 0, 0);
        const disabled = place("ClosedPipe", -1, 0);
        place("Pipe", -2, 0);
        doc.setComponent(bend, "AtmosPipeColor", "color: '#FFFFFFFF'\notherField: 12");
        const before = doc.serialize(now);

        expect(scene.pipePorts(pump)).toEqual([{ name: "inlet", layer: "Primary" }, { name: "outlet", layer: "Primary" }]);
        const circuit = scene.pipeNetwork(a, "pipe", protoData);
        expect(new Set(circuit)).toEqual(new Set([a, bend, next]));
        expect(colorPipeNetwork(doc, circuit, "#de5d4a")).toBe(3);
        expect(colorPipeNetwork(doc, circuit, "#DE5D4A")).toBe(0);
        expect(scene.pipeColor(a)).toBe("#de5d4a");
        for (const uid of circuit) {
            expect(doc.componentOverride(uid, "AtmosPipeColor")?.data.color).toBe("#DE5D4AFF");
        }
        expect(doc.componentOverride(bend, "AtmosPipeColor")?.data.otherField).toBe(12);
        for (const uid of [differentCircuit, otherLayer, disabled, pump]) expect(doc.componentOverride(uid, "AtmosPipeColor")).toBeUndefined();
        expect(doc.undo()).toBe("Color pipe network");
        expect(doc.serialize(now)).toBe(before);
        expect(scene.pipeColor(a)).toBe("#ffffff");
    });

    it("traces across open valves and respects their saved closed state", () => {
        const { doc, scene } = open();
        const a = doc.addEntity("Pipe", 1, 0.5, 0.5);
        const valve = doc.addEntity("Valve", 1, 1.5, 0.5);
        const b = doc.addEntity("Pipe", 1, 2.5, 0.5);
        expect(new Set(scene.pipeNetwork(a, "pipe", protoData))).toEqual(new Set([a, b]));
        doc.setComponent(valve, "GasValve", "open: False");
        expect(scene.pipeNetwork(a, "pipe", protoData)).toEqual([a]);
        expect(scene.pipeNetwork(valve, "outlet", protoData)).toEqual([b]);
    });
});
