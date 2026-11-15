// Pipe layers: the layer the game's placement picks for the cursor, the prototype of each layer, which pipes share a
// tile (PipeRestrictOverlap) and the placement ghost, on Barnacle (Frontier) and an upstream shuttle.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { layerForOffset, layerGuides, layerPrototypes } from "../src/editor/pipe-layers";
import { Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import type { Pack } from "../src/pack/loader";
import { pipeNodesOverlap, pipeOverlapNodes, Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const NOW = new Date(2026, 10, 15, 10, 0, 0);
const Q = Math.PI / 2;

describe("pipe layer under the cursor", () => {
    it("keeps the primary layer near the tile centre, else secondary up or right and tertiary down or left", () => {
        expect(layerForOffset(0, 0)).toBe(0);
        expect(layerForOffset(0.2, 0.1)).toBe(0);
        expect(layerForOffset(0.25, 0)).toBe(0);
        expect(layerForOffset(0.4, 0)).toBe(1);
        expect(layerForOffset(0, 0.4)).toBe(1);
        expect(layerForOffset(-0.4, 0)).toBe(2);
        expect(layerForOffset(0, -0.4)).toBe(2);
        // up and to the left: up is nearer
        expect(layerForOffset(-0.3, 0.4)).toBe(1);
        expect(layerForOffset(-0.4, 0.3)).toBe(2);
    });

    it("draws the guide circles where the game does, each over its layer", () => {
        const a = 0.21875;
        const round = (g: Array<{ dx: number; dy: number; layer: number }>) => g.map(({ dx, dy, layer }) => [Math.round(dx * 1e6) / 1e6 + 0, Math.round(dy * 1e6) / 1e6 + 0, layer]);
        expect(round(layerGuides(0))).toEqual([[0, 0, 0], [a, a, 1], [-a, -a, 2]]);
        // a grid turned a quarter: the circles stay on the same diagonal
        expect(round(layerGuides(Q))).toEqual([[0, 0, 0], [-a, -a, 2], [a, a, 1]]);
    });
});

describe("pipe nodes on a tile", () => {
    const straight = { NodeContainer: { nodes: { pipe: { pipeDirection: "Longitudinal" } } }, AtmosPipeLayers: {} };
    const onLayer = (layer: number | string) => ({ ...straight, AtmosPipeLayers: { pipeLayer: layer } });
    const vent = { NodeContainer: { nodes: { pipe: { pipeDirection: "South" } } }, AtmosPipeLayers: { pipeLayer: 0 } };

    it("overlap only on one layer with a shared direction (PipeRestrictOverlapSystem)", () => {
        expect(pipeOverlapNodes(straight, 0)).toEqual([[0, 1 | 2]]);
        expect(pipeOverlapNodes(onLayer("Tertiary"), 0)).toEqual([[2, 1 | 2]]);
        expect(pipeNodesOverlap(pipeOverlapNodes(straight, 0), pipeOverlapNodes(straight, Math.PI))).toBe(true);
        // across each other on one layer, or along each other on two
        expect(pipeNodesOverlap(pipeOverlapNodes(straight, 0), pipeOverlapNodes(straight, Q))).toBe(false);
        expect(pipeNodesOverlap(pipeOverlapNodes(straight, 0), pipeOverlapNodes(onLayer(1), 0))).toBe(false);
        expect(pipeNodesOverlap(pipeOverlapNodes(vent, 0), pipeOverlapNodes(straight, 0))).toBe(true);
        expect(pipeNodesOverlap(pipeOverlapNodes(vent, 0), pipeOverlapNodes(onLayer(2), 0))).toBe(false);
    });

    it("keeps the nodes' own layers when the layers are locked (manifolds)", () => {
        const manifold = {
            AtmosPipeLayers: { pipeLayersLocked: true },
            NodeContainer: { nodes: { s0: { pipeDirection: "South", pipeLayer: 0 }, s1: { pipeDirection: "South", pipeLayer: 1 }, s2: { pipeDirection: "South", pipeLayer: 2 } } },
        };
        expect(pipeOverlapNodes(manifold, 0).map(([l]) => l)).toEqual([0, 1, 2]);
    });
});

/** A floor tile with nothing anchored on it and its world centre. */
function freeTile(scene: Scene): { grid: number; x: number; y: number; at: [number, number] } {
    for (const grid of scene.grids) {
        for (const [x, y] of scene.tileCells(grid)) {
            if (scene.anchoredAt(grid, x, y).length || scene.tileAt(grid, x, y) === null) continue;
            return { grid, x, y, at: scene.toWorld(grid, x + 0.5, y + 0.5) };
        }
    }
    throw new Error("no free tile");
}

const forks: Array<[string, string]> = [
    ["frontier", "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml"],
    ["upstream", "upstream/Resources/Maps/Shuttles/emergency_hike.yml"],
];

for (const [fork, map] of forks) {
    const file = path.join(corpusRoot(), map);
    const pack: Pack | null = packFor(fork);
    describe.skipIf(!fs.existsSync(file) || !pack)(`pipe layers on ${path.basename(map)} (${fork})`, () => {
        const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
        const open = () => {
            const doc = new MapDocument(original);
            const scene = new Scene(doc, pack!);
            doc.onChange((c) => scene.apply(c));
            const editor = new Editor(doc, scene, pack!, { visible: () => true });
            return { doc, scene, editor };
        };

        it("knows the prototype of each layer", () => {
            expect(layerPrototypes(pack!, "GasPipeStraight")).toEqual(["GasPipeStraight", "GasPipeStraightAlt1", "GasPipeStraightAlt2"]);
            expect(layerPrototypes(pack!, "GasPipeStraightAlt2")).toEqual(["GasPipeStraight", "GasPipeStraightAlt1", "GasPipeStraightAlt2"]);
            expect(layerPrototypes(pack!, "GasVentPump")).toEqual(["GasVentPump", "GasVentPumpAlt1", "GasVentPumpAlt2"]);
            // placed on a tile without layers
            expect(layerPrototypes(pack!, "GasPipeManifold")).toBeNull();
            expect(layerPrototypes(pack!, "WallSolid")).toBeNull();
        });

        it("keeps pipes of different layers on one tile and replaces one on the same layer, undone byte for byte", () => {
            const { doc, scene, editor } = open();
            const t = freeTile(scene);
            const before = doc.uids().length;
            const protosHere = () => scene.anchoredAt(t.grid, t.x, t.y).map((u) => doc.proto(u)).sort();

            const primary = editor.place("GasPipeStraight", ...t.at);
            const secondary = editor.place("GasPipeStraightAlt1", ...t.at);
            const tertiary = editor.place("GasPipeStraightAlt2", ...t.at);
            expect([primary, secondary, tertiary].every((u) => u !== null)).toBe(true);
            expect(protosHere()).toEqual(["GasPipeStraight", "GasPipeStraightAlt1", "GasPipeStraightAlt2"]);
            // the same pipe turned the same way is already there
            expect(editor.place("GasPipeStraightAlt1", ...t.at)).toBeNull();
            // across the secondary one on its layer: both stay, as in the game
            const across = editor.place("GasPipeStraightAlt1", ...t.at, Q);
            expect(across).not.toBeNull();
            expect(protosHere()).toHaveLength(4);
            // a vent on the primary layer shares the straight pipe's south: it takes its place
            const vent = editor.place("GasVentPump", ...t.at);
            expect(vent).not.toBeNull();
            expect(doc.proto(primary!)).toBeUndefined();
            expect(protosHere()).toEqual(["GasPipeStraightAlt1", "GasPipeStraightAlt1", "GasPipeStraightAlt2", "GasVentPump"]);
            // a vent on the tertiary layer, turned to face north: it shares the tertiary pipe's north
            const ventUp = editor.place("GasVentPumpAlt2", ...t.at, Math.PI);
            expect(ventUp).not.toBeNull();
            expect(doc.proto(tertiary!)).toBeUndefined();
            expect(doc.uids().length).toBe(before + 4);

            for (let i = 0; i < 6; i++) doc.undo();
            expect(doc.uids().length).toBe(before);
            expect(doc.serialize(NOW)).toBe(original);
        });

        it("draws the placement ghost of a vent as the vent, with its pipe on its layer", () => {
            const { scene } = open();
            const t = freeTile(scene);
            const icon = (id: string) => scene.preview(id, t.grid, t.x + 0.5, t.y + 0.5, 0);
            const vent = icon("GasVentPump"), vent2 = icon("GasVentPumpAlt2");
            // the pipe stub and the vent itself
            expect(vent).toHaveLength(2);
            expect(vent.every((l) => !l.subfloor && l.power === 0)).toBe(true);
            expect(vent2).toHaveLength(2);
            // the vent is the same, the stub comes from the tertiary layer's sprites
            const frames = (ls: typeof vent) => ls.map((l) => l.frame).sort();
            expect(frames(vent2)).not.toEqual(frames(vent));
            expect(frames(vent2).filter((f) => frames(vent).includes(f))).toHaveLength(1);
            for (const id of ["GasVentScrubber", "GasPressurePump", "GasVolumePump", "GasValve", "GasOutletInjector", "GasPassiveVent", "GasFilter", "GasMixer"]) {
                if (!pack!.prototypes.entities[id]) continue;
                expect(icon(id).length, id).toBeGreaterThanOrEqual(2);
            }
            // nothing is left of the preview in the scene
            expect(scene.layersOf(-1)).toHaveLength(0);
            expect(scene.anchoredAt(t.grid, t.x, t.y)).toHaveLength(0);
        });

        it("draws the map's pipes on their layers, manifolds included", () => {
            const { scene } = open();
            expect(scene.missing.filter((m) => /Piping/.test(m))).toEqual([]);
        });
    });
}
