import { describe, expect, it } from "vitest";
import { constrainEnd, shapeCells, type Cell } from "../src/editor/shapes";

const bounds = (cells: Cell[]) => {
    const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe("shapes drawn with Shift", () => {
    it("keeps lines to 45° steps", () => {
        // ~30° from the horizontal snaps to the diagonal (above 22.5°), ~15° to the horizontal
        expect(constrainEnd("line", [0, 0], [10, 6])).toEqual([10, 10]);
        expect(constrainEnd("line", [0, 0], [10, 3])).toEqual([10, 0]);
        expect(constrainEnd("line", [0, 0], [2, -9])).toEqual([0, -9]);
        expect(constrainEnd("line", [5, 5], [-3, -1])).toEqual([-3, -3]);
        const cells = shapeCells("line", false, [0, 0], constrainEnd("line", [0, 0], [7, 5]));
        expect(cells.every(([x, y]) => x === y)).toBe(true);
    });

    it("turns rectangles into squares and ellipses into circles, in the drag direction", () => {
        expect(constrainEnd("rect", [0, 0], [6, 2])).toEqual([6, 6]);
        expect(constrainEnd("rect", [0, 0], [-2, 5])).toEqual([-5, 5]);
        expect(constrainEnd("ellipse", [3, 3], [1, -4])).toEqual([-4, -4]);
        const [x0, y0, x1, y1] = bounds(shapeCells("ellipse", true, [0, 0], constrainEnd("ellipse", [0, 0], [8, 3])));
        expect(x1! - x0!).toBe(y1! - y0!);
    });

    it("leaves a single tile alone", () => {
        for (const kind of ["line", "rect", "ellipse"] as const) expect(constrainEnd(kind, [2, 2], [2, 2])).toEqual([2, 2]);
    });
});
