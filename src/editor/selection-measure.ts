import { PPM, type Scene } from "../render/scene";
import { cellOf, type Selection } from "./selection";

export interface SelectionMeasure {
    /** A single grid's axes, or world axes when the selection spans grids. */
    grid: number | null;
    width: number;
    height: number;
}

/** Tile footprint: entities occupy their position's cell; decals use their rotated texture bounds. */
export function measureSelection(scene: Pick<Scene, "placement" | "toLocal" | "toWorld" | "worldTransform" | "decalLayer" | "frames">, selection: Selection): SelectionMeasure | null {
    if (selection.isEmpty) return null;
    const grids = new Set<number | null>();
    for (const uid of selection.entities) {
        const p = scene.placement(uid);
        if (p) grids.add(p.grid);
    }
    for (const [grid, cells] of selection.tiles) if (cells.size) grids.add(grid);
    for (const [grid, ids] of selection.decals) if (ids.size) grids.add(grid);
    const grid = grids.size === 1 ? [...grids][0]! : null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (world: [number, number]) => {
        const [x, y] = grid === null ? world : scene.toLocal(grid, ...world);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };
    const cell = (g: number | null, x: number, y: number) => {
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
            const point: [number, number] = [x + dx!, y + dy!];
            add(g === null ? point : scene.toWorld(g, ...point));
        }
    };
    for (const [g, cells] of selection.tiles) for (const key of cells) cell(g, ...cellOf(key));
    for (const uid of selection.entities) {
        const p = scene.placement(uid);
        if (!p) continue;
        const w = p.grid === null ? scene.worldTransform(uid) : p;
        if (w) cell(p.grid, Math.floor(w.x), Math.floor(w.y));
    }
    for (const [g, id] of selection.decalList()) {
        const d = scene.decalLayer(g, id);
        if (!d) continue;
        const frame = scene.frames[d.frame];
        if (!frame) continue;
        const hw = frame[3] / (2 * PPM), hh = frame[4] / (2 * PPM);
        const c = Math.cos(d.rot), s = Math.sin(d.rot);
        for (const [x, y] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
            add([d.x + c * x - s * y, d.y + s * x + c * y]);
        }
    }
    return x0 === Infinity ? null : { grid, width: x1 - x0, height: y1 - y0 };
}
