// Geometry of the view aids (tile grid lines, shuttle centre and direction). No DOM and no drawing:
// the controller draws what these return on the overlay.

/** Tile area of a grid in its own coordinates: [x0, y0, x1, y1), x1 and y1 exclusive. */
export type Area = [number, number, number, number];

/** What the aids need to know about a scene. */
export interface TileSource {
    readonly grids: number[];
    tileCells(grid: number): Iterable<[number, number]>;
    tileAt(grid: number, x: number, y: number): string | null;
}

interface Mass {
    /** Tiles present, by packed coordinates. */
    cells: Set<number>;
    n: number;
    /** Sums of tile centres. */
    sx: number;
    sy: number;
    area: Area;
    /** The area may be larger than the tiles (a tile at its edge was removed). */
    stale: boolean;
}

const BIAS = 1 << 25;
const pack = (x: number, y: number) => (x + BIAS) * (1 << 26) + (y + BIAS);
const unpack = (k: number): [number, number] => [Math.floor(k / (1 << 26)) - BIAS, (k % (1 << 26)) - BIAS];

/**
 * Centre of mass of each grid by its tiles (every non-space tile weighs the same) and its tile area,
 * kept up to date from tile edits without going through all tiles again.
 */
export class GridMass {
    private grids = new Map<number, Mass>();
    private built = false;

    constructor(private readonly source: TileSource) {}

    /** Forgets everything; the next query reads the scene again (the grids changed). */
    invalidate(): void {
        this.grids.clear();
        this.built = false;
    }

    /** Applies edited tiles, as [grid, x, y]. */
    update(tiles: Iterable<[number, number, number]>): void {
        if (!this.built) return; // nothing computed yet: the first query reads the scene
        for (const [g, x, y] of tiles) {
            const m = this.grids.get(g);
            if (!m) continue;
            const key = pack(x, y);
            const has = m.cells.has(key);
            const now = this.source.tileAt(g, x, y) !== null;
            if (now === has) continue;
            const [a, b, c, d] = m.area;
            if (now) {
                m.cells.add(key);
                m.n++;
                m.sx += x + 0.5;
                m.sy += y + 0.5;
                m.area = [Math.min(a, x), Math.min(b, y), Math.max(c, x + 1), Math.max(d, y + 1)];
            } else {
                m.cells.delete(key);
                m.n--;
                m.sx -= x + 0.5;
                m.sy -= y + 0.5;
                if (x === a || y === b || x + 1 === c || y + 1 === d) m.stale = true;
            }
        }
    }

    /** Centre of mass in the grid's own coordinates, or null for a grid without tiles. */
    centre(grid: number): [number, number] | null {
        const m = this.mass(grid);
        return m && m.n ? [m.sx / m.n, m.sy / m.n] : null;
    }

    /** Tile area of a grid, or null for a grid without tiles. */
    area(grid: number): Area | null {
        const m = this.mass(grid);
        if (!m || !m.n) return null;
        if (m.stale) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const k of m.cells) {
                const [x, y] = unpack(k);
                x0 = Math.min(x0, x);
                y0 = Math.min(y0, y);
                x1 = Math.max(x1, x + 1);
                y1 = Math.max(y1, y + 1);
            }
            m.area = [x0, y0, x1, y1];
            m.stale = false;
        }
        return m.area;
    }

    private mass(grid: number): Mass | undefined {
        if (!this.built) {
            this.built = true;
            for (const g of this.source.grids) {
                const m: Mass = { cells: new Set(), n: 0, sx: 0, sy: 0, area: [Infinity, Infinity, -Infinity, -Infinity], stale: false };
                for (const [x, y] of this.source.tileCells(g)) {
                    m.cells.add(pack(x, y));
                    m.n++;
                    m.sx += x + 0.5;
                    m.sy += y + 0.5;
                    m.area = [Math.min(m.area[0], x), Math.min(m.area[1], y), Math.max(m.area[2], x + 1), Math.max(m.area[3], y + 1)];
                }
                this.grids.set(g, m);
            }
        }
        return this.grids.get(grid);
    }
}

/** Grid lines are drawn only when tiles are at least this many CSS px wide. */
export const MIN_GRID_PX = 6;

/** Integer line ranges to draw: vertical lines x = xs[0]..xs[1] over y = ys[0]..ys[1], horizontal ones likewise. */
export interface LineRanges {
    xs: [number, number];
    ys: [number, number];
}

/**
 * Grid lines worth drawing for a grid: those of its tile area (plus `margin` tiles around it, so there is
 * a guide for painting next to it) that fall inside the visible region, given as the grid-local bounding
 * box [x0, y0, x1, y1] of the screen. Null when there is nothing to draw (too small tiles, off screen).
 */
export function gridLineRanges(area: Area, visible: Area, tilePx: number, margin = 1): LineRanges | null {
    if (tilePx < MIN_GRID_PX) return null;
    const x0 = Math.max(area[0] - margin, Math.floor(visible[0])), x1 = Math.min(area[2] + margin, Math.ceil(visible[2]));
    const y0 = Math.max(area[1] - margin, Math.floor(visible[1])), y1 = Math.min(area[3] + margin, Math.ceil(visible[3]));
    if (x0 > x1 || y0 > y1) return null;
    return { xs: [x0, x1], ys: [y0, y1] };
}

/** Bounding box of points. */
export function bounds(points: Iterable<[number, number]>): Area {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of points) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    }
    return [x0, y0, x1, y1];
}

/** Screen direction (y down) of a grid's local +Y when the grid is turned by `rot` radians counter-clockwise. */
export function forwardOnScreen(rot: number): [number, number] {
    return [-Math.sin(rot), -Math.cos(rot)];
}

/** Arrow from `from` along the unit direction `dir`: shaft end and the two barbs of the head (screen px). */
export function arrow(from: [number, number], dir: [number, number], length: number, head = Math.min(14, length * 0.35)) {
    const tip: [number, number] = [from[0] + dir[0] * length, from[1] + dir[1] * length];
    const barb = (a: number): [number, number] => {
        const c = Math.cos(a), s = Math.sin(a);
        // the reverse direction turned by ±25°
        const bx = -dir[0], by = -dir[1];
        return [tip[0] + head * (c * bx - s * by), tip[1] + head * (s * bx + c * by)];
    };
    return { tip, left: barb(0.44), right: barb(-0.44) };
}

/** Length of a direction arrow in CSS px for a grid `tiles` tiles long drawn at `tilePx` per tile. */
export function arrowLength(tiles: number, tilePx: number): number {
    return Math.min(300, Math.max(32, tiles * 0.4 * tilePx));
}
