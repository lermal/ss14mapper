// Operations on a whole selection: moving (dragged or nudged), turning by quarter turns around its centre
// and deleting. Each runs its document edits inside one `journal.edit`, so the scene hears of them once
// and they undo as one step.
//
// Selected entities move as "roots": an entity whose ancestor is selected too moves with that ancestor.
// They keep their parent (a grid stays the parent even off its tiles); anchored ones land on tile centres.
// Selected tiles move on their own grid: the cells they cover take their tile with its variant and rotation,
// the cells they leave become space. After a move the selection "floats" (as in image editors): what its tiles
// covered is remembered (`under`), so the next move of the same selection gives those cells their tiles back.
import type { DecalProps } from "../map/decals";
import type { MapDocument, TileEdit, Transform } from "../map/document";
import { PPM, type Scene } from "../render/scene";
import { cellKey, cellOf, type Selection } from "./selection";
import { deleteDecalsOnSpace } from "./space-decals";
import type { Point } from "./shapes";
import { quarterTurn, tileCenter, toPixel } from "./snap";
import type { DecalSnap } from "./tools";

/** A tile as a chunk stores it (flags are not kept: the editor writes 0). */
export interface TileValue {
    name: string;
    variant: number;
    rot: number;
}

/** Tiles by grid and cell key. */
export type TileMap = Map<number, Map<number, TileValue>>;

const SPACE: TileValue = { name: "Space", variant: 0, rot: 0 };
const sameTile = (a: TileValue, b: TileValue) => a.name === b.name && (a.name === "Space" || (a.variant === b.variant && a.rot === b.rot));

/** Reads tiles from the document (by name, through its tilemap); `all` reads every tile of a grid at once. */
function tileReader(doc: MapDocument) {
    const names = doc.tilemap();
    const value = (t: { id: number; variant: number; rotationMirroring: number }): TileValue => {
        const name = names.get(t.id) ?? "Space";
        return name === "Space" ? SPACE : { name, variant: t.variant, rot: t.rotationMirroring };
    };
    return {
        one: (grid: number, x: number, y: number): TileValue => value(doc.tile(grid, x, y)),
        all: (grid: number): Map<number, TileValue> => new Map(doc.tiles(grid).map((t) => [cellKey(t.x, t.y), value(t.tile)])),
    };
}

/** Selected tiles on a grid above this many are read with the whole grid (one decoding per chunk). */
const BULK_READ = 256;

/** A tile's rotation/mirroring turned by quarter turns (counter-clockwise; bit 4 mirrors). */
export function turnTileRotation(rot: number, turns: number): number {
    const mirrored = rot >= 4;
    const r = (((rot % 4) + (mirrored ? -turns : turns)) % 4 + 4) % 4;
    return mirrored ? r + 4 : r;
}

/** A point turned by quarter turns (counter-clockwise) around a centre. */
export function turnPoint([x, y]: Point, [cx, cy]: Point, turns: number): Point {
    switch (((turns % 4) + 4) % 4) {
        case 1:
            return [cx - (y - cy), cy + (x - cx)];
        case 2:
            return [2 * cx - x, 2 * cy - y];
        case 3:
            return [cx + (y - cy), cy - (x - cx)];
        default:
            return [x, y];
    }
}

/** The point nearest to `c` around which a quarter turn maps tiles onto tiles (both coordinates whole, or both halves). */
export function latticeCentre([cx, cy]: Point): Point {
    const whole: Point = [Math.round(cx), Math.round(cy)];
    const half: Point = [Math.floor(cx) + 0.5, Math.floor(cy) + 0.5];
    const d = (p: Point) => (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
    return d(whole) <= d(half) ? whole : half;
}

/** An angle turned by quarter turns, in (-π, π], exact for quarter turns. */
export function turnAngle(angle: number, turns: number): number {
    const a = angle + (turns * Math.PI) / 2;
    const q = Math.round(a / (Math.PI / 2));
    if (Math.abs(a - q * (Math.PI / 2)) < 1e-9) return [0, Math.PI / 2, Math.PI, -Math.PI / 2][((q % 4) + 4) % 4]!;
    let r = a % (2 * Math.PI);
    if (r <= -Math.PI) r += 2 * Math.PI;
    if (r > Math.PI) r -= 2 * Math.PI;
    return r;
}

/** A selected decal: where it was (bottom left corner on its grid) and its size in tiles. */
interface DecalItem {
    grid: number;
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    props: DecalProps;
}

/** A selected entity that moves on its own (no selected ancestor). */
interface Mover {
    uid: number;
    from: Transform;
    /** The parent is a grid: positions are worked out on it. */
    onGrid: boolean;
    /** Grid it is anchored to, or null. */
    anchored: number | null;
    /** World point: its tile centre when anchored, else its position. */
    world: Point;
}

/**
 * What a group operation works on: the selection's moving entities, its tiles with their values, and the grid
 * whose tiles the moves and turns follow.
 */
export class Group {
    readonly movers: Mover[] = [];
    /** Selected tiles with what they hold: grid → cell key → tile. */
    readonly tiles: TileMap = new Map();
    readonly decals: DecalItem[] = [];
    /**
     * The group keeps to the tile lattice (moves of whole tiles, turns about a lattice point): it has tiles or
     * anchored entities, or the snap is not Off.
     */
    readonly snaps: boolean;
    /** Decals or free (unanchored) entities, which move as the snap says. */
    private readonly hasFree: boolean;
    /** Grid of the moves and turns (tiles of other grids follow as near as they can), or null off grids. */
    readonly ref: number | null;
    private readonly read: (grid: number, x: number, y: number) => TileValue;

    /**
     * `under`: what the cells under a floating selection held before it covered them (from the previous move
     * of the same selection); left cells get it back instead of becoming space. `snap` (the decal snap) says how
     * decals and free entities move: whole tiles ("tile"), onto tile corners ("corner", decals) or by texture
     * pixels ("free"). Tiles and anchored entities always move by whole tiles.
     */
    constructor(
        readonly doc: MapDocument,
        readonly scene: Scene,
        selection: Selection,
        near: Point | null = null,
        private readonly under: TileMap = new Map(),
        readonly snap: DecalSnap = "tile",
    ) {
        const reader = tileReader(doc);
        this.read = reader.one;
        const selected = selection.entities;
        const grids = new Set(scene.grids);
        for (const uid of selected) {
            if (doc.proto(uid) === undefined || grids.has(uid)) continue;
            const from = doc.transform(uid);
            if (from.parent === null) continue;
            if (this.hasSelectedAncestor(from.parent, selected)) continue;
            const p = scene.placement(uid);
            const w = scene.worldTransform(uid);
            if (!w) continue;
            const anchored = p?.anchored && p.grid !== null ? p.grid : null;
            const world: Point = anchored !== null ? scene.toWorld(anchored, Math.floor(p!.x) + 0.5, Math.floor(p!.y) + 0.5) : [w.x, w.y];
            this.movers.push({ uid, from, onGrid: grids.has(from.parent), anchored, world });
        }
        for (const [g, cells] of selection.tiles) {
            if (!grids.has(g)) continue;
            const m = new Map<number, TileValue>();
            const all = cells.size > BULK_READ ? reader.all(g) : null;
            for (const k of cells) {
                const t = all ? all.get(k) ?? SPACE : this.read(g, ...cellOf(k));
                if (t.name !== "Space") m.set(k, t);
            }
            if (m.size) this.tiles.set(g, m);
        }
        for (const [g, ids] of selection.decals) {
            if (!grids.has(g)) continue;
            const all = ids.size > 8 ? new Map(doc.decals(g).map((d) => [d.id, d])) : null;
            for (const id of ids) {
                const d = all ? all.get(id) : doc.decal(g, id);
                if (!d) continue;
                const layer = scene.decalLayer(g, id);
                const [, , , fw, fh] = layer ? scene.frames[layer.frame]! : [0, 0, 0, PPM, PPM];
                const { proto, color, angle, zIndex, cleanable } = d;
                this.decals.push({ grid: g, id, x: d.x, y: d.y, w: fw / PPM, h: fh / PPM, props: { proto, color, angle, zIndex, cleanable } });
            }
        }
        this.snaps = this.tiles.size > 0 || this.movers.some((m) => m.anchored !== null) || snap !== "free";
        this.hasFree = this.decals.length > 0 || this.movers.some((m) => m.anchored === null);
        const candidates = new Set<number>([...this.tiles.keys(), ...this.decals.map((d) => d.grid)]);
        for (const m of this.movers) {
            const g = m.anchored ?? scene.placement(m.uid)?.grid ?? null;
            if (g !== null) candidates.add(g);
        }
        const pointed = near ? scene.gridAt(...near) : null;
        this.ref = pointed !== null && candidates.has(pointed) ? pointed : candidates.size ? [...candidates][0]! : null;
    }

    private hasSelectedAncestor(parent: number | null, selected: Set<number>): boolean {
        for (let p = parent, depth = 0; p !== null && depth < 64; depth++) {
            if (selected.has(p)) return true;
            if (this.doc.proto(p) === undefined) return false;
            p = this.doc.transform(p).parent;
        }
        return false;
    }

    get isEmpty(): boolean {
        return !this.movers.length && !this.tiles.size && !this.decals.length;
    }

    /** Group frame (the reference grid, or the world off grids) ↔ world. */
    toFrame(p: Point): Point {
        return this.ref === null ? p : this.scene.toLocal(this.ref, ...p);
    }

    fromFrame(p: Point): Point {
        return this.ref === null ? p : this.scene.toWorld(this.ref, ...p);
    }

    /** A world vector in a grid's coordinates. */
    private vectorOn(grid: number, [wx, wy]: Point): Point {
        const [ox, oy] = this.scene.toLocal(grid, 0, 0);
        const [x, y] = this.scene.toLocal(grid, wx, wy);
        return [x - ox, y - oy];
    }

    // -----------------------------------------------------------------------------------------
    // Moving

    /** It has tiles or anchored entities (they always move by whole tiles). */
    get keepsTiles(): boolean {
        return this.tiles.size > 0 || this.movers.some((m) => m.anchored !== null);
    }

    /** Whether moves go by texture pixels (snap Off with decals or free entities; tiles still round to whole tiles). */
    get freeMoves(): boolean {
        return this.snap === "free" && this.hasFree;
    }

    /**
     * World vector of a move by `delta` (a world vector, e.g. cursor travel): whole texture pixels when moves are
     * free, else whole tiles of the reference grid.
     */
    snapDelta(delta: Point): Point {
        if (this.freeMoves || this.ref === null) return [toPixel(delta[0]), toPixel(delta[1])];
        const [x, y] = this.vectorOn(this.ref, delta);
        return this.tileStep(Math.round(x), Math.round(y));
    }

    /** World vector of whole tiles on the reference grid. */
    tileStep(dx: number, dy: number): Point {
        if (this.ref === null) return [dx, dy];
        const [ox, oy] = this.scene.toWorld(this.ref, 0, 0);
        const [x, y] = this.scene.toWorld(this.ref, dx, dy);
        return [x - ox, y - oy];
    }

    /** Whole-tile offset on a grid for a world move (exact on the reference grid). */
    gridOffset(grid: number, delta: Point): [number, number] {
        const [x, y] = this.vectorOn(grid, delta);
        return [Math.round(x), Math.round(y)];
    }

    /** Where a mover goes for a world move (in its parent's coordinates). */
    private movedTo(m: Mover, delta: Point): Point {
        const { from } = m;
        if (!delta[0] && !delta[1]) return [from.x, from.y];
        const parent = from.parent!;
        if (m.onGrid && (m.anchored === null || m.anchored === parent)) {
            if (m.anchored !== null) {
                const [dx, dy] = this.gridOffset(parent, delta);
                return [tileCenter(from.x + dx), tileCenter(from.y + dy)];
            }
            if (this.snap !== "free") {
                const [dx, dy] = this.gridOffset(parent, delta);
                return [from.x + dx, from.y + dy];
            }
            const [dx, dy] = this.vectorOn(parent, delta);
            return [from.x + toPixel(dx), from.y + toPixel(dy)];
        }
        let w: Point = [m.world[0] + delta[0], m.world[1] + delta[1]];
        if (m.anchored !== null) {
            const [lx, ly] = this.scene.toLocal(m.anchored, ...w);
            w = this.scene.toWorld(m.anchored, tileCenter(lx), tileCenter(ly));
        }
        return this.scene.toLocal(parent, ...w);
    }

    /** Tiles after a world move: grid → cell key → tile. */
    private movedTiles(delta: Point): TileMap {
        const out: TileMap = new Map();
        for (const [g, cells] of this.tiles) {
            const [dx, dy] = this.gridOffset(g, delta);
            const m = new Map<number, TileValue>();
            for (const [k, t] of cells) {
                const [x, y] = cellOf(k);
                m.set(cellKey(x + dx, y + dy), t);
            }
            out.set(g, m);
        }
        return out;
    }

    // -----------------------------------------------------------------------------------------
    // Applying

    /** Cells written since `reset` and what they held before. */
    private orig: TileMap = new Map();
    private cur: TileMap = new Map();
    /** Where the tiles were last written. */
    private dest: TileMap = new Map();
    private placed = new Map<number, Point>();
    /** Decals written since `reset`: "grid|original id" → where and under which id they are now. */
    private decalsNow = new Map<string, { id: string; x: number; y: number }>();
    /** Something was written and later put back (it would stay in the file as a no-op edit). */
    reverted = false;

    /** Forgets what was written (after the document reverted it). */
    reset(): void {
        this.orig.clear();
        this.cur.clear();
        this.placed.clear();
        this.decalsNow.clear();
        this.dest = new Map();
        this.reverted = false;
    }

    private origOf(g: number, k: number): TileValue {
        let m = this.orig.get(g);
        if (!m) this.orig.set(g, (m = new Map()));
        let t = m.get(k);
        if (!t) m.set(k, (t = this.tiles.get(g)?.get(k) ?? this.read(g, ...cellOf(k))));
        return t;
    }

    /**
     * Brings the selected tiles to `dest` (grid → cell → tile): cells they leave get back what was under them
     * (space for the selection's own cells), other cells written earlier get back what they held. Writes only
     * what differs.
     */
    private writeTiles(dest: TileMap): void {
        this.dest = dest;
        const grids = new Set([...this.tiles.keys(), ...dest.keys(), ...this.cur.keys()]);
        for (const g of grids) {
            const src = this.tiles.get(g), to = dest.get(g), under = this.under.get(g);
            let cur = this.cur.get(g);
            if (!cur) this.cur.set(g, (cur = new Map()));
            const cells = new Set([...cur.keys(), ...(src?.keys() ?? []), ...(to?.keys() ?? [])]);
            const edits: TileEdit[] = [];
            for (const k of cells) {
                const want = to?.get(k) ?? under?.get(k) ?? (src?.has(k) ? SPACE : this.origOf(g, k));
                const have = cur.get(k) ?? this.origOf(g, k);
                if (sameTile(want, have)) continue;
                const [x, y] = cellOf(k);
                edits.push({ x, y, name: want.name, variant: want.variant, rotationMirroring: want.rot });
                cur.set(k, want);
                if (sameTile(want, this.origOf(g, k))) this.reverted = true;
            }
            if (edits.length) this.doc.setTiles(g, edits);
        }
    }

    /**
     * Deletes the decals that cells turned into space by the writes so far (DecalSystem.OnTileChanged), except the
     * selection's own decals, which move with their tiles. Called once a move, turn or delete is final (a live drag
     * would lose decals it later uncovers), inside its edit.
     */
    clearSpaceDecals(): void {
        for (const [g, cur] of this.cur) {
            const cells: number[] = [];
            for (const [k, t] of cur) if (t.name === "Space" && this.origOf(g, k).name !== "Space") cells.push(k);
            if (!cells.length) continue;
            const own = new Set(this.decals.filter((d) => d.grid === g).map((d) => this.decalIdOf(g, d.id)));
            deleteDecalsOnSpace(this.doc, g, cells, own);
        }
    }

    private writeEntity(m: Mover, [x, y]: Point): void {
        const now = this.placed.get(m.uid) ?? [m.from.x, m.from.y];
        if (now[0] === x && now[1] === y) return;
        this.doc.moveEntity(m.uid, x, y);
        this.placed.set(m.uid, [x, y]);
        if (x === m.from.x && y === m.from.y) this.reverted = true;
    }

    /** The id a selected decal has now (decals on chunk entities change it when they move to another chunk). */
    decalIdOf(grid: number, id: string): string {
        return this.decalsNow.get(`${grid}|${id}`)?.id ?? id;
    }

    /**
     * Moves decals (bottom left corners, on their grids) where they are not yet, and turns them (`angle`), with
     * one edit per grid; follows their ids.
     */
    private writeDecals(moves: ReadonlyArray<{ d: DecalItem; x: number; y: number; angle?: number }>): void {
        const byGrid = new Map<number, Array<{ d: DecalItem; x: number; y: number; angle?: number; from: string }>>();
        for (const m of moves) {
            const now = this.decalsNow.get(`${m.d.grid}|${m.d.id}`) ?? { id: m.d.id, x: m.d.x, y: m.d.y };
            if (now.x === m.x && now.y === m.y && m.angle === undefined) continue;
            let list = byGrid.get(m.d.grid);
            if (!list) byGrid.set(m.d.grid, (list = []));
            list.push({ ...m, from: now.id });
        }
        for (const [g, list] of byGrid) {
            const ids = this.doc.editDecals(g, list.map((m) => ({ id: m.from, x: m.x, y: m.y, ...(m.angle !== undefined ? { props: { angle: m.angle } } : {}) })));
            list.forEach((m, i) => {
                this.decalsNow.set(`${g}|${m.d.id}`, { id: ids[i]!, x: m.x, y: m.y });
                if (m.x === m.d.x && m.y === m.d.y && m.angle === undefined) this.reverted = true;
            });
        }
    }

    /**
     * The shift of a grid's decals for a world move: whole pixels with the snap Off, else the shift that puts the
     * grid's first selected decal on the snap's lattice as the brush places them (its corner on whole tiles for
     * "tile", on half tiles for "corner"), so decals on the lattice stay on it and move by whole tiles.
     */
    private decalShift(grid: number, delta: Point): Point {
        const v = this.vectorOn(grid, delta);
        if (this.snap === "free") return [toPixel(v[0]), toPixel(v[1])];
        const first = this.decals.find((d) => d.grid === grid)!;
        const on = this.snap === "corner" ? (x: number) => Math.round(x - 0.5) + 0.5 : Math.round;
        return [on(first.x + v[0]) - first.x, on(first.y + v[1]) - first.y];
    }

    /** Where a decal goes for a world move. */
    private decalMovedTo(d: DecalItem, delta: Point, shifts: Map<number, Point>): Point {
        if (!delta[0] && !delta[1]) return [d.x, d.y];
        let s = shifts.get(d.grid);
        if (!s) shifts.set(d.grid, (s = this.decalShift(d.grid, delta)));
        return [d.x + s[0], d.y + s[1]];
    }

    /** Puts the group where a world move (already snapped) takes it, writing only what changes. */
    moveBy(delta: Point): void {
        this.doc.batch("Move", () => {
            for (const m of this.movers) this.writeEntity(m, this.movedTo(m, delta));
            this.writeTiles(this.movedTiles(delta));
            const shifts = new Map<number, Point>();
            this.writeDecals(this.decals.map((d) => {
                const [x, y] = this.decalMovedTo(d, delta, shifts);
                return { d, x, y };
            }));
        });
    }

    /** What lies under the selection's tiles where they were last written (for its next move). */
    underAfter(): TileMap {
        const out: TileMap = new Map();
        for (const [g, cells] of this.dest) {
            const src = this.tiles.get(g), under = this.under.get(g);
            const m = new Map<number, TileValue>();
            for (const k of cells.keys()) m.set(k, under?.get(k) ?? (src?.has(k) ? SPACE : this.origOf(g, k)));
            out.set(g, m);
        }
        return out;
    }

    /** The selection after a move (its tiles follow, its decals keep their new ids). */
    movedSelection(selection: Selection, delta: Point): void {
        const offsets = new Map<number, [number, number]>();
        selection.mapTiles((g, x, y) => {
            let o = offsets.get(g);
            if (!o) offsets.set(g, (o = this.gridOffset(g, delta)));
            return [x + o[0], y + o[1]];
        });
        selection.mapDecals((g, id) => this.decalIdOf(g, id));
    }

    // -----------------------------------------------------------------------------------------
    // Turning and deleting

    /** Centre of the group in its frame; on the tile lattice when it snaps, so tiles turn onto tiles. */
    centre(): Point | null {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const add = ([x, y]: Point, r: number) => {
            x0 = Math.min(x0, x - r);
            y0 = Math.min(y0, y - r);
            x1 = Math.max(x1, x + r);
            y1 = Math.max(y1, y + r);
        };
        for (const m of this.movers) add(this.toFrame(m.world), m.anchored !== null ? 0.5 : 0);
        for (const [g, cells] of this.tiles) {
            for (const k of cells.keys()) {
                const [x, y] = cellOf(k);
                add(g === this.ref ? [x + 0.5, y + 0.5] : this.toFrame(this.scene.toWorld(g, x + 0.5, y + 0.5)), 0.5);
            }
        }
        for (const d of this.decals) {
            const centre: Point = [d.x + d.w / 2, d.y + d.h / 2];
            add(d.grid === this.ref ? centre : this.toFrame(this.scene.toWorld(d.grid, ...centre)), 0);
        }
        if (x0 === Infinity) return null;
        const c: Point = [(x0 + x1) / 2, (y0 + y1) / 2];
        return this.snaps ? latticeCentre(c) : c;
    }

    /**
     * Turns the group by quarter turns (positive: counter-clockwise) around its centre: positions and
     * rotations of entities and decals, tiles with their rotation. Returns the turned cell of a tile on each grid,
     * for the selection (decal ids: `decalIdOf`).
     */
    turn(turns: number): ((grid: number, x: number, y: number) => [number, number]) | null {
        const c = this.centre();
        if (!c) return null;
        const rotates = this.doc.format >= 7;
        const turned: TileMap = new Map();
        const centres = new Map<number, Point>();
        const centreOn = (g: number): Point => {
            let p = centres.get(g);
            if (!p) centres.set(g, (p = g === this.ref ? c : latticeCentre(this.scene.toLocal(g, ...this.fromFrame(c)))));
            return p;
        };
        const cellTo = (g: number, x: number, y: number): [number, number] => {
            const [tx, ty] = turnPoint([x + 0.5, y + 0.5], centreOn(g), turns);
            return [Math.floor(tx), Math.floor(ty)];
        };
        for (const [g, cells] of this.tiles) {
            const m = new Map<number, TileValue>();
            for (const [k, t] of cells) {
                const [x, y] = cellTo(g, ...cellOf(k));
                m.set(cellKey(x, y), rotates ? { ...t, rot: turnTileRotation(t.rot, turns) } : t);
            }
            turned.set(g, m);
        }
        this.doc.batch("Rotate", () => {
            // decals turn around their centre
            this.writeDecals(this.decals.map((d) => {
                const centre: Point = [d.x + d.w / 2, d.y + d.h / 2];
                const [cx, cy] =
                    d.grid === this.ref ? turnPoint(centre, c, turns) : this.scene.toLocal(d.grid, ...this.fromFrame(turnPoint(this.toFrame(this.scene.toWorld(d.grid, ...centre)), c, turns)));
                return { d, x: cx - d.w / 2, y: cy - d.h / 2, angle: turnAngle(d.props.angle, turns) };
            }));
            for (const m of this.movers) {
                const { from } = m;
                const parent = from.parent!;
                let to: Point;
                if (parent === this.ref) {
                    // exact on the reference grid: tile centres turn onto tile centres
                    const at: Point = m.anchored === parent ? [tileCenter(from.x), tileCenter(from.y)] : [from.x, from.y];
                    to = turnPoint(at, c, turns);
                } else {
                    let w = this.fromFrame(turnPoint(this.toFrame(m.world), c, turns));
                    if (m.anchored !== null) {
                        const [lx, ly] = this.scene.toLocal(m.anchored, ...w);
                        w = this.scene.toWorld(m.anchored, tileCenter(lx), tileCenter(ly));
                    }
                    to = this.scene.toLocal(parent, ...w);
                }
                if (to[0] !== from.x || to[1] !== from.y) this.doc.moveEntity(m.uid, to[0], to[1]);
                this.doc.rotateEntity(m.uid, quarterTurn(from.rotation, turns));
            }
            this.writeTiles(turned);
            this.clearSpaceDecals();
        });
        return cellTo;
    }

    /** Deletes the entities (with everything inside them) and makes the tiles space; returns the deleted uids. */
    delete(): number[] {
        const removed: number[] = [];
        this.doc.batch("Delete", () => {
            for (const m of this.movers) if (this.doc.proto(m.uid) !== undefined) removed.push(...this.doc.deleteEntity(m.uid));
            this.writeTiles(new Map());
            this.clearSpaceDecals();
            const byGrid = new Map<number, string[]>();
            for (const d of this.decals) {
                const ids = byGrid.get(d.grid);
                if (ids) ids.push(d.id);
                else byGrid.set(d.grid, [d.id]);
            }
            for (const [g, ids] of byGrid) this.doc.deleteDecals(g, ids);
        });
        return removed;
    }
}
