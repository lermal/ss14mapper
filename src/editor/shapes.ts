// Geometry of the selection and drawing tools (no DOM, no scene): areas drawn with the selection tools
// in world coordinates, and the tiles covered by the shapes drawn with a palette choice.

/** World point. */
export type Point = [number, number];

/** What a selection tool drew, in world coordinates: a rectangle, the ellipse inside one, or a freehand polygon. */
export type Area =
    | { kind: "rect"; a: Point; b: Point }
    | { kind: "ellipse"; a: Point; b: Point }
    | { kind: "polygon"; points: Point[] };

/** Bounding box [x0, y0, x1, y1] of an area. */
export function areaBounds(area: Area): [number, number, number, number] {
    if (area.kind !== "polygon") {
        const { a, b } = area;
        return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of area.points) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    }
    return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Whether a world point is inside an area (the rectangle's edges count as inside). */
export function areaContains(area: Area, x: number, y: number): boolean {
    if (area.kind === "polygon") return insidePolygon(area.points, x, y);
    const [x0, y0, x1, y1] = areaBounds(area);
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    if (area.kind === "rect") return true;
    const rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    if (!rx || !ry) return false;
    const dx = (x - (x0 + rx)) / rx, dy = (y - (y0 + ry)) / ry;
    return dx * dx + dy * dy <= 1;
}

/** Even-odd rule; the polygon closes itself. */
export function insidePolygon(points: readonly Point[], x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i]!, [xj, yj] = points[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

// ---------------------------------------------------------------------------------------------
// Shapes drawn with tiles or entities, on the tiles of one grid

export type ShapeKind = "line" | "rect" | "ellipse";

/** Tile coordinates on a grid. */
export type Cell = [number, number];

/** Tiles of a straight line between two tiles, both included (Bresenham: one tile per step, no gaps). */
export function lineCells([x0, y0]: Cell, [x1, y1]: Cell): Cell[] {
    const out: Cell[] = [];
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    for (;;) {
        out.push([x, y]);
        if (x === x1 && y === y1) return out;
        const e2 = 2 * err;
        if (e2 >= dy) {
            err += dy;
            x += sx;
        }
        if (e2 <= dx) {
            err += dx;
            y += sy;
        }
    }
}

/** tan(22.5°): below it a line snaps to the nearer axis, above it to the diagonal. */
const TAN_22_5 = Math.tan(Math.PI / 8);

/**
 * The end tile of a shape drawn with Shift held, as in image editors: a line keeps to multiples of 45°,
 * a rectangle becomes a square and an ellipse a circle (the longer side wins).
 */
export function constrainEnd(kind: ShapeKind, [x0, y0]: Cell, [x1, y1]: Cell): Cell {
    const dx = x1 - x0, dy = y1 - y0;
    const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (kind === "line") {
        if (ay <= ax * TAN_22_5) return [x1, y0];
        if (ax <= ay * TAN_22_5) return [x0, y1];
    }
    const side = Math.max(ax, ay);
    return [x0 + sx * side, y0 + sy * side];
}

/**
 * Tiles of a shape spanned by two corner tiles (both included). A rectangle or ellipse is either filled
 * or just its border; the border is 4-connected, so walls drawn along it join up.
 */
export function shapeCells(kind: ShapeKind, filled: boolean, a: Cell, b: Cell): Cell[] {
    if (kind === "line") return lineCells(a, b);
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    const inside =
        kind === "rect"
            ? () => true
            : (() => {
                  // the ellipse inscribed in the tiles' outer edges, tested at tile centres
                  const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
                  return (x: number, y: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
              })();
    const out: Cell[] = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (!inside(x, y)) continue;
            // a border tile has a neighbour (diagonals too) outside the shape: so the border is 4-connected
            let border = x === x0 || x === x1 || y === y0 || y === y1;
            for (let dx = -1; dx <= 1 && !border; dx++) for (let dy = -1; dy <= 1 && !border; dy++) border = !inside(x + dx, y + dy);
            if (filled || border) out.push([x, y]);
        }
    }
    return out;
}
