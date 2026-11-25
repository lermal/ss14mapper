import { describe, expect, it } from "vitest";
import { measureSelection } from "../src/editor/selection-measure";
import { cellKey, Selection } from "../src/editor/selection";

// Grid 1 is rotated 90 degrees and translated. Grid 2 uses the world axes.
const scene: Parameters<typeof measureSelection>[0] = {
    placement: () => null,
    worldTransform: () => null,
    toWorld: (g, x, y) => g === 1 ? [10 - y, 20 + x] : [x, y],
    toLocal: (g, x, y) => g === 1 ? [y - 20, 10 - x] : [x, y],
    decalLayer: () => undefined,
    frames: [[0, 0, 0, 64, 32]],
};

describe("selection measurements", () => {
    it("has no dimensions for an empty or stale selection", () => {
        const selection = new Selection();
        expect(measureSelection(scene, selection)).toBeNull();
        selection.addEntity(404);
        expect(measureSelection(scene, selection)).toBeNull();
    });

    it("counts complete cells, including negative coordinates, in the grid's own axes", () => {
        const selection = new Selection();
        selection.tiles.set(1, new Set([cellKey(-3, -2), cellKey(1, 0)]));
        expect(measureSelection(scene, selection)).toEqual({ grid: 1, width: 5, height: 3 });
        selection.tiles.set(1, new Set([cellKey(-1, -1)]));
        expect(measureSelection(scene, selection)).toEqual({ grid: 1, width: 1, height: 1 });
    });

    it("uses world axes for selections spanning differently rotated grids", () => {
        const selection = new Selection();
        selection.tiles.set(1, new Set([cellKey(0, 0)])); // world x9..10, y20..21
        selection.tiles.set(2, new Set([cellKey(0, 0)]));
        expect(measureSelection(scene, selection)).toEqual({ grid: null, width: 10, height: 21 });
    });

    it("includes the cell of an entity at a negative fractional position", () => {
        const selection = new Selection();
        selection.addEntity(12);
        selection.tiles.set(2, new Set([cellKey(0, 0)]));
        const source = { ...scene, placement: () => ({ grid: 2, x: -0.1, y: -1.1, rot: 0, anchored: true }) };
        expect(measureSelection(source, selection)).toEqual({ grid: 2, width: 2, height: 3 });
    });

    it("measures rotated decal bounds rather than treating a decal as a point", () => {
        const selection = new Selection();
        selection.addDecal(2, "mark");
        const source = { ...scene, decalLayer: () => ({ x: 0, y: 0, rot: Math.PI / 2, frame: 0, color: null, z: 0, seq: 0, ext: 2, grid: 2, id: "mark", proto: "mark" }) };
        const measured = measureSelection(source, selection)!;
        expect(measured.width).toBeCloseTo(1);
        expect(measured.height).toBeCloseTo(2);
    });
});
