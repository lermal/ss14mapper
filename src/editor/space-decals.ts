// Decals do not stay on space. The game deletes them when a tile becomes space (DecalSystem.OnTileChanged): every
// decal whose position lies in the tile's box (GetDecalsIntersecting: `Box2.Contains` of the decal's bottom left
// corner, edges included, so a decal on a tile corner goes with any of the four tiles around it).
import type { MapDocument } from "../map/document";
import { cellKey } from "./selection";

/** The tiles (cell keys) whose box holds a point; a coordinate on a tile edge belongs to both tiles at it. */
function cellsAt(x: number, y: number): number[] {
    const xs = Number.isInteger(x) ? [x - 1, x] : [Math.floor(x)];
    const ys = Number.isInteger(y) ? [y - 1, y] : [Math.floor(y)];
    return xs.flatMap((cx) => ys.map((cy) => cellKey(cx, cy)));
}

/** Ids of the decals the game deletes when these cells become space. */
export function decalsOnCells(decals: readonly { id: string; x: number; y: number }[], cells: Iterable<number>): string[] {
    const set = new Set(cells);
    if (!set.size) return [];
    return decals.filter((d) => cellsAt(d.x, d.y).some((k) => set.has(k))).map((d) => d.id);
}

/**
 * Deletes the decals on cells that became space (call inside the edit that made them space, so it is one undo
 * step); `keep` ids are left (decals moving with their tiles). Returns the number deleted.
 */
export function deleteDecalsOnSpace(doc: MapDocument, grid: number, cells: Iterable<number>, keep?: ReadonlySet<string>): number {
    const set = new Set(cells);
    if (!set.size) return 0;
    const ids = decalsOnCells(doc.decals(grid), set).filter((id) => !keep?.has(id));
    if (ids.length) doc.deleteDecals(grid, ids);
    return ids.length;
}

/** The cell keys of the grid's tiles that are not space. */
export function solidCells(doc: MapDocument, grid: number): Set<number> {
    return new Set(doc.tiles(grid).map((t) => cellKey(t.x, t.y)));
}
