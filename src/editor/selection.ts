// What the mapper has selected, and the selection tools that gather it from the scene: areas (rectangle,
// ellipse, lasso), the magic wand and "select all". Pure logic over the scene (no DOM).
//
// A selection holds items of three kinds, each in its own set: entities (uids), tiles (grid + cell) and decals
// (grid + decal id). The group operations and the clipboard read it kind by kind.
import type { DecalLayer, Scene, SpriteLayer } from "../render/scene";
import { texelAt, type OpaqueTest } from "./hit";
import { areaBounds, areaContains, type Area } from "./shapes";

/** Kinds of things a selection holds. */
export const KINDS = ["entities", "tiles", "decals"] as const;
export type Kind = (typeof KINDS)[number];

/** What the selection tools pick up. */
export type SelectFilter = "all" | "entities" | "tiles" | "decals";

export const FILTER_KINDS: Record<SelectFilter, readonly Kind[]> = { all: KINDS, entities: ["entities"], tiles: ["tiles"], decals: ["decals"] };

/** How a new pick changes the selection: replaces it, adds to it (Shift), or is taken out of it (Alt). */
export type Combine = "replace" | "add" | "subtract";

const OFF = 32768;
/** One number for a tile cell (coordinates within ±32767). */
export const cellKey = (x: number, y: number): number => (x + OFF) * 65536 + (y + OFF);
export const cellOf = (key: number): [number, number] => [Math.floor(key / 65536) - OFF, (key % 65536) - OFF];

export class Selection {
    /** Selected entities (change them through the methods, so `version` follows). */
    readonly entities = new Set<number>();
    /** Selected tiles: grid → cell keys (`cellKey`). */
    readonly tiles = new Map<number, Set<number>>();
    /** Selected decals: grid → decal ids. */
    readonly decals = new Map<number, Set<string>>();
    /** Grows with every change (views cache what they draw by it). */
    version = 0;

    addEntity(uid: number): void {
        this.entities.add(uid);
        this.version++;
    }

    deleteEntity(uid: number): void {
        if (this.entities.delete(uid)) this.version++;
    }

    get isEmpty(): boolean {
        return !this.entities.size && !this.tiles.size && !this.decals.size;
    }

    get decalCount(): number {
        let n = 0;
        for (const s of this.decals.values()) n += s.size;
        return n;
    }

    hasDecal(grid: number, id: string): boolean {
        return !!this.decals.get(grid)?.has(id);
    }

    addDecal(grid: number, id: string): void {
        this.version++;
        let set = this.decals.get(grid);
        if (!set) this.decals.set(grid, (set = new Set()));
        set.add(id);
    }

    /** Every selected decal as [grid, id]. */
    *decalList(): IterableIterator<[number, string]> {
        for (const [g, set] of this.decals) for (const id of set) yield [g, id];
    }

    /** Selected decals renamed (a decal on chunk entities gets a new id when it moves to another chunk). */
    mapDecals(to: (grid: number, id: string) => string): void {
        this.version++;
        for (const [g, set] of [...this.decals]) this.decals.set(g, new Set([...set].map((id) => to(g, id))));
    }

    get tileCount(): number {
        let n = 0;
        for (const s of this.tiles.values()) n += s.size;
        return n;
    }

    /** Everything selected, counted over all kinds. */
    get size(): number {
        return this.entities.size + this.tileCount + this.decalCount;
    }

    hasTile(grid: number, x: number, y: number): boolean {
        return !!this.tiles.get(grid)?.has(cellKey(x, y));
    }

    addTile(grid: number, x: number, y: number): void {
        this.version++;
        let set = this.tiles.get(grid);
        if (!set) this.tiles.set(grid, (set = new Set()));
        set.add(cellKey(x, y));
    }

    deleteTile(grid: number, x: number, y: number): void {
        const set = this.tiles.get(grid);
        if (!set?.delete(cellKey(x, y))) return;
        this.version++;
        if (!set.size) this.tiles.delete(grid);
    }

    /** Every selected tile as [grid, x, y]. */
    *tileList(): IterableIterator<[number, number, number]> {
        for (const [g, set] of this.tiles) for (const k of set) yield [g, ...cellOf(k)];
    }

    clear(): void {
        this.entities.clear();
        this.tiles.clear();
        this.decals.clear();
        this.version++;
    }

    /** Makes this selection a copy of another. */
    assign(other: Selection): void {
        if (other === this) return;
        this.clear();
        this.combine(other, "add");
    }

    clone(): Selection {
        const s = new Selection();
        s.combine(this, "add");
        return s;
    }

    /** Applies a new pick: replace, add or subtract. */
    combine(other: Selection, op: Combine): void {
        this.version++;
        if (op === "replace") {
            this.assign(other);
            return;
        }
        for (const uid of other.entities) {
            if (op === "add") this.entities.add(uid);
            else this.entities.delete(uid);
        }
        combineSets(this.tiles, other.tiles, op);
        combineSets(this.decals, other.decals, op);
    }

    /** Drops what no longer exists (deleted entities and decals, tiles that became space); returns whether anything went. */
    prune(
        entityExists: (uid: number) => boolean,
        tileExists: (grid: number, x: number, y: number) => boolean,
        decalExists: (grid: number, id: string) => boolean = () => true,
    ): boolean {
        let changed = false;
        for (const uid of this.entities) {
            if (entityExists(uid)) continue;
            this.entities.delete(uid);
            changed = true;
        }
        for (const [g, set] of this.tiles) {
            for (const k of set) {
                if (tileExists(g, ...cellOf(k))) continue;
                set.delete(k);
                changed = true;
            }
            if (!set.size) this.tiles.delete(g);
        }
        for (const [g, set] of this.decals) {
            for (const id of set) {
                if (decalExists(g, id)) continue;
                set.delete(id);
                changed = true;
            }
            if (!set.size) this.decals.delete(g);
        }
        if (changed) this.version++;
        return changed;
    }

    /** Selected tiles replaced: per grid, each cell mapped by `to` (after a group move or rotation). */
    mapTiles(to: (grid: number, x: number, y: number) => [number, number]): void {
        this.version++;
        for (const [g, set] of [...this.tiles]) {
            const next = new Set<number>();
            for (const k of set) next.add(cellKey(...to(g, ...cellOf(k))));
            this.tiles.set(g, next);
        }
    }
}

/** Adds or takes per-grid sets of another selection. */
function combineSets<K>(mine: Map<number, Set<K>>, theirs: ReadonlyMap<number, ReadonlySet<K>>, op: "add" | "subtract"): void {
    for (const [g, items] of theirs) {
        let set = mine.get(g);
        if (op === "add") {
            if (!set) mine.set(g, (set = new Set()));
            for (const k of items) set.add(k);
        } else if (set) {
            for (const k of items) set.delete(k);
            if (!set.size) mine.delete(g);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Gathering

/** What the selection tools need from the view: which sprite layers are drawn, and whether tiles and decals are. */
export interface PickView {
    visible(s: SpriteLayer): boolean;
    tilesShown?(): boolean;
    decalsShown?(): boolean;
}

/** Where a decal counts for areas: its centre. */
export const decalPoint = (d: DecalLayer): [number, number] => [d.x, d.y];

/** The decal drawn on top at a world point (where its pixels are, with `opaque`), or null. */
export function decalAt(scene: Scene, x: number, y: number, opaque?: OpaqueTest, accept?: (decal: DecalLayer) => boolean): DecalLayer | null {
    const list = scene.decals.query(x, y, x, y).sort((a, b) => a.z - b.z || a.seq - b.seq);
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i]!;
        if ((accept && !accept(d)) || (d.color && (d.color[3] ?? 1) === 0)) continue;
        const [, , , fw, fh] = scene.frames[d.frame]!;
        const t = texelAt({ ...d, scale: null } as unknown as SpriteLayer, fw, fh, x, y);
        if (t && (!opaque || opaque(d.frame, t[0], t[1]))) return d;
    }
    return null;
}

/** Whether an entity can be picked: something of it is drawn with the current view options. */
export function selectable(scene: Scene, view: PickView, uid: number): boolean {
    return scene.layersOf(uid).some((l) => view.visible(l));
}

/** Where an entity counts for areas: its tile centre when anchored to a grid, else its position. */
export function entityPoint(scene: Scene, uid: number): [number, number] | null {
    const p = scene.placement(uid);
    if (p?.anchored && p.grid !== null) return scene.toWorld(p.grid, Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5);
    const w = scene.worldTransform(uid);
    return w ? [w.x, w.y] : null;
}

const gridsOf = (scene: Scene) => new Set(scene.grids);

/**
 * Whether an area takes a layer's entity. Unlike a click, an area takes what lies under the floor even while
 * the subfloor is hidden: moving or deleting a room must take its pipes and cables along.
 */
const inArea = (view: PickView, l: SpriteLayer) => view.visible(l) || l.subfloor || l.kind === "marker";

/** Everything of the filter's kinds inside an area: entities by their point, tiles by their centre. */
export function collectArea(scene: Scene, view: PickView, area: Area, filter: SelectFilter): Selection {
    const kinds = FILTER_KINDS[filter];
    const out = new Selection();
    const [x0, y0, x1, y1] = areaBounds(area);
    if (kinds.includes("entities")) {
        const grids = gridsOf(scene);
        // layers sit near their entity; one tile of slack catches offset layers
        const seen = new Set<number>();
        for (const l of scene.sprites.query(x0 - 1, y0 - 1, x1 + 1, y1 + 1)) {
            if (seen.has(l.uid) || !inArea(view, l)) continue;
            seen.add(l.uid);
            if (grids.has(l.uid)) continue;
            const p = entityPoint(scene, l.uid);
            if (p && areaContains(area, p[0], p[1])) out.entities.add(l.uid);
        }
        // entities that draw nothing (spawn points, markers) are in the area all the same
        for (const uid of scene.undrawn()) {
            if (grids.has(uid)) continue;
            const p = entityPoint(scene, uid);
            if (p && areaContains(area, p[0], p[1])) out.entities.add(uid);
        }
    }
    if (kinds.includes("tiles") && (view.tilesShown?.() ?? true)) {
        for (const g of scene.grids) {
            // the area's box in grid coordinates
            const corners = [scene.toLocal(g, x0, y0), scene.toLocal(g, x1, y0), scene.toLocal(g, x1, y1), scene.toLocal(g, x0, y1)];
            const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
            const cx0 = Math.floor(Math.min(...xs)), cx1 = Math.floor(Math.max(...xs)), cy0 = Math.floor(Math.min(...ys)), cy1 = Math.floor(Math.max(...ys));
            for (let x = cx0; x <= cx1; x++) {
                for (let y = cy0; y <= cy1; y++) {
                    if (scene.tileAt(g, x, y) === null) continue;
                    const [wx, wy] = scene.toWorld(g, x + 0.5, y + 0.5);
                    if (areaContains(area, wx, wy)) out.addTile(g, x, y);
                }
            }
        }
    }
    if (kinds.includes("decals") && (view.decalsShown?.() ?? true)) {
        for (const d of scene.decals.query(x0, y0, x1, y1)) if (areaContains(area, ...decalPoint(d))) out.addDecal(d.grid, d.id);
    }
    return out;
}

/** Every entity drawn and every tile, of the filter's kinds. */
export function collectAll(scene: Scene, view: PickView, filter: SelectFilter): Selection {
    const kinds = FILTER_KINDS[filter];
    const out = new Selection();
    if (kinds.includes("entities")) {
        const grids = gridsOf(scene);
        for (const l of scene.sprites) if (!grids.has(l.uid) && inArea(view, l)) out.entities.add(l.uid);
        for (const uid of scene.undrawn()) if (!grids.has(uid)) out.entities.add(uid);
    }
    if (kinds.includes("tiles") && (view.tilesShown?.() ?? true)) {
        for (const g of scene.grids) for (const [x, y] of scene.tileCells(g)) out.addTile(g, x, y);
    }
    if (kinds.includes("decals") && (view.decalsShown?.() ?? true)) for (const d of scene.decals) out.addDecal(d.grid, d.id);
    return out;
}

/** Tile of a decal's centre on its grid, as "x|y". */
function decalCell(scene: Scene, d: DecalLayer): string {
    const [lx, ly] = scene.toLocal(d.grid, d.x, d.y);
    return `${Math.floor(lx)}|${Math.floor(ly)}`;
}

/**
 * Magic wand on a decal: decals of its prototype and colour on its grid. Contiguous (the default): those
 * reachable through 4-adjacent tiles that hold one (a warning line, a run of trims); otherwise all of the grid.
 */
export function wandDecals(scene: Scene, start: DecalLayer, contiguous: boolean): Selection {
    const out = new Selection();
    const colour = JSON.stringify(start.color);
    const same = [...scene.decals].filter((d) => d.grid === start.grid && d.proto === start.proto && JSON.stringify(d.color) === colour);
    if (!contiguous) {
        for (const d of same) out.addDecal(d.grid, d.id);
        return out;
    }
    const byCell = new Map<string, DecalLayer[]>();
    for (const d of same) {
        const k = decalCell(scene, d);
        const list = byCell.get(k);
        if (list) list.push(d);
        else byCell.set(k, [d]);
    }
    const first = decalCell(scene, start);
    const seen = new Set([first]);
    const stack = [first];
    out.addDecal(start.grid, start.id);
    while (stack.length) {
        const k = stack.pop()!;
        for (const d of byCell.get(k) ?? []) out.addDecal(d.grid, d.id);
        const [x, y] = k.split("|").map(Number) as [number, number];
        for (const [dx, dy] of STEPS) {
            const n = `${x + dx}|${y + dy}`;
            if (seen.has(n) || !byCell.has(n)) continue;
            seen.add(n);
            stack.push(n);
        }
    }
    return out;
}

const STEPS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Magic wand on a tile: the 4-connected area of the same tile on that grid. */
export function wandTiles(scene: Scene, grid: number, x: number, y: number): Selection {
    const out = new Selection();
    const name = scene.tileAt(grid, x, y);
    if (name === null) return out;
    const stack: Array<[number, number]> = [[x, y]];
    out.addTile(grid, x, y);
    while (stack.length) {
        const [cx, cy] = stack.pop()!;
        for (const [dx, dy] of STEPS) {
            const nx = cx + dx, ny = cy + dy;
            if (out.hasTile(grid, nx, ny) || scene.tileAt(grid, nx, ny) !== name) continue;
            out.addTile(grid, nx, ny);
            stack.push([nx, ny]);
        }
    }
    return out;
}

/**
 * Magic wand on an entity: drawn entities of the same prototype. Contiguous (the default): those reachable
 * through 4-adjacent tiles that hold one, like a wall run or a cable line; otherwise every one on the map.
 */
export function wandEntities(scene: Scene, view: PickView, uid: number, contiguous: boolean): Selection {
    const out = new Selection();
    const proto = scene.entities.get(uid)?.[0];
    if (proto === undefined) return out;
    const same: number[] = [];
    for (const [u, [p]] of scene.entities) if (p === proto && selectable(scene, view, u)) same.push(u);
    if (!contiguous) {
        for (const u of same) out.entities.add(u);
        return out;
    }
    // same-prototype entities by tile: grid tile, or a world tile off grids
    const cellOfEntity = (u: number): string | null => {
        const p = scene.placement(u);
        if (p && p.grid !== null) return `${p.grid}|${Math.floor(p.x)}|${Math.floor(p.y)}`;
        const w = scene.worldTransform(u);
        return w ? `w|${Math.floor(w.x)}|${Math.floor(w.y)}` : null;
    };
    const byCell = new Map<string, number[]>();
    for (const u of same) {
        const k = cellOfEntity(u);
        if (k === null) continue;
        const list = byCell.get(k);
        if (list) list.push(u);
        else byCell.set(k, [u]);
    }
    const start = cellOfEntity(uid);
    if (start === null) {
        out.entities.add(uid);
        return out;
    }
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
        const k = stack.pop()!;
        for (const u of byCell.get(k) ?? []) out.entities.add(u);
        const [g, x, y] = k.split("|") as [string, string, string];
        for (const [dx, dy] of STEPS) {
            const n = `${g}|${Number(x) + dx}|${Number(y) + dy}`;
            if (seen.has(n) || !byCell.has(n)) continue;
            seen.add(n);
            stack.push(n);
        }
    }
    return out;
}
