import { describe, expect, it } from "vitest";
import { arrow, arrowLength, bounds, forwardOnScreen, GridMass, gridLineRanges, type TileSource } from "../src/editor/view-aids";

/** A scene stand-in: tiles per grid in a set. */
function source(tiles: Record<number, Array<[number, number]>>) {
    const sets = new Map<number, Set<string>>();
    for (const [g, list] of Object.entries(tiles)) sets.set(+g, new Set(list.map(([x, y]) => `${x},${y}`)));
    const src: TileSource & { sets: Map<number, Set<string>> } = {
        sets,
        get grids() { return [...sets.keys()]; },
        *tileCells(g) { for (const k of sets.get(g) ?? []) yield k.split(",").map(Number) as [number, number]; },
        tileAt: (g, x, y) => (sets.get(g)?.has(`${x},${y}`) ? "Plating" : null),
    };
    return src;
}

describe("centre of mass", () => {
    it("is the mean of tile centres", () => {
        const m = new GridMass(source({ 1: [[0, 0], [1, 0], [2, 0]], 2: [[-3, -1]] }));
        expect(m.centre(1)).toEqual([1.5, 0.5]);
        expect(m.centre(2)).toEqual([-2.5, -0.5]);
        expect(m.area(1)).toEqual([0, 0, 3, 1]);
        expect(m.centre(9)).toBeNull();
    });
    it("moves towards painted tiles and back on erase", () => {
        const src = source({ 1: [[0, 0], [1, 0]] });
        const m = new GridMass(src);
        expect(m.centre(1)).toEqual([1, 0.5]);
        src.sets.get(1)!.add("5,0");
        src.sets.get(1)!.add("6,0");
        m.update([[1, 5, 0], [1, 6, 0]]);
        expect(m.centre(1)![0]).toBeGreaterThan(1);
        expect(m.centre(1)![0]).toBeCloseTo((0.5 + 1.5 + 5.5 + 6.5) / 4);
        expect(m.area(1)).toEqual([0, 0, 7, 1]);
        src.sets.get(1)!.delete("5,0");
        src.sets.get(1)!.delete("6,0");
        m.update([[1, 5, 0], [1, 6, 0], [1, 5, 0]]);
        expect(m.centre(1)).toEqual([1, 0.5]);
        expect(m.area(1)).toEqual([0, 0, 2, 1]); // shrinks again
    });
    it("ignores edits that change nothing, and edits before the first query", () => {
        const src = source({ 1: [[0, 0]] });
        const m = new GridMass(src);
        m.update([[1, 0, 0]]);
        src.sets.get(1)!.add("1,0");
        m.update([[1, 1, 0]]); // not built yet: the first query reads the scene
        expect(m.centre(1)).toEqual([1, 0.5]);
        m.update([[1, 1, 0], [1, 7, 7]]);
        expect(m.centre(1)).toEqual([1, 0.5]);
    });
    it("handles negative coordinates and rebuilds on invalidate", () => {
        const src = source({ 1: [[-4, -2], [-5, -2]] });
        const m = new GridMass(src);
        expect(m.centre(1)).toEqual([-4, -1.5]);
        src.sets.get(1)!.add("0,0");
        m.invalidate();
        expect(m.area(1)).toEqual([-5, -2, 1, 1]);
    });
    it("reports a grid whose tiles are all gone as empty", () => {
        const src = source({ 1: [[0, 0]] });
        const m = new GridMass(src);
        m.centre(1);
        src.sets.get(1)!.clear();
        m.update([[1, 0, 0]]);
        expect(m.centre(1)).toBeNull();
        expect(m.area(1)).toBeNull();
    });
});

describe("grid lines", () => {
    it("clips to the tile area plus a margin and to the visible box", () => {
        expect(gridLineRanges([0, 0, 10, 4], [-100, -100, 100, 100], 32)).toEqual({ xs: [-1, 11], ys: [-1, 5] });
        expect(gridLineRanges([0, 0, 10, 4], [3.2, -100, 6.7, 100], 32)).toEqual({ xs: [3, 7], ys: [-1, 5] });
        expect(gridLineRanges([0, 0, 10, 4], [50, 0, 60, 4], 32)).toBeNull();
    });
    it("draws nothing when tiles are too small", () => {
        expect(gridLineRanges([0, 0, 10, 4], [-100, -100, 100, 100], 5.9)).toBeNull();
        expect(gridLineRanges([0, 0, 10, 4], [-100, -100, 100, 100], 6)).not.toBeNull();
    });
    it("bounds points", () => {
        expect(bounds([[1, 5], [-2, 3], [4, -1]])).toEqual([-2, -1, 4, 5]);
    });
});

describe("direction arrow", () => {
    it("points up the screen for an unrotated grid and turns with it", () => {
        const [x, y] = forwardOnScreen(0);
        expect(x).toBeCloseTo(0);
        expect(y).toBeCloseTo(-1);
        const [rx, ry] = forwardOnScreen(Math.PI / 2); // counter-clockwise: forward points left
        expect(rx).toBeCloseTo(-1);
        expect(ry).toBeCloseTo(0);
        const [bx, by] = forwardOnScreen(Math.PI);
        expect(bx).toBeCloseTo(0);
        expect(by).toBeCloseTo(1);
    });
    it("has its tip at the length and the barbs behind it", () => {
        const a = arrow([100, 100], [0, -1], 50);
        expect(a.tip).toEqual([100, 50]);
        expect(a.left[1]).toBeGreaterThan(50);
        expect(a.right[1]).toBeGreaterThan(50);
        expect(a.left[0] + a.right[0]).toBeCloseTo(200);
        expect(a.left[0]).not.toBeCloseTo(a.right[0]);
    });
    it("keeps the length readable", () => {
        expect(arrowLength(1, 8)).toBe(32);
        expect(arrowLength(20, 20)).toBe(160);
        expect(arrowLength(500, 64)).toBe(300);
    });
});
