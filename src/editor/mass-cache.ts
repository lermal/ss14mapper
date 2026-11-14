// Centres of mass of the grids of a scene in both modes of mass.ts, kept per grid and brought up to date by
// edits without going through the whole map again: a tile edit recomputes the game body of its chunk only (and
// the tile's own weight), an entity edit replaces that entity's share.
import { add, chunkBody, CHUNK_SIZE, entityMoments, result, ZERO, type MassEntity, type MassResult, type Moments } from "./mass";
import type { TileSource } from "./view-aids";

/** "game": the grid body as the engine makes it; "entities": tile masses and entity bodies (an editor aid). */
export type MassMode = "game" | "entities";

/** What the cache reads besides the tiles: the build's numbers and the bodies of entities. */
export interface MassRules {
    /** `PrototypeIndex.tileDensity`. */
    tileDensity: number;
    /** `TileDefinition.mass` of a tile name. */
    tileMass(name: string): number;
    /** Every entity that may have a body on a grid. */
    entityUids(): Iterable<number>;
    /** The body of an entity and the grid it is on, or null (no body, inside a container, on no grid). */
    body(uid: number): (MassEntity & { grid: number }) | null;
}

interface GameState {
    /** Body of each chunk with tiles, by "cx,cy". */
    chunks: Map<string, Moments>;
    /** Sum of the chunks; null until summed again after an edit. */
    sum: Moments | null;
}

interface WeightState {
    /** Tile mass by "x,y". */
    tiles: Map<string, number>;
    sum: Moments;
}

const sub = (a: Moments, b: Moments): Moments => ({ mass: a.mass - b.mass, mx: a.mx - b.mx, my: a.my - b.my });

export class MassCache {
    private game: Map<number, GameState> | null = null;
    private weights: Map<number, WeightState> | null = null;
    /** Share of each entity counted "with entities": its grid and moments. */
    private bodies = new Map<number, { grid: number; m: Moments }>();

    constructor(
        private readonly tiles: TileSource,
        private readonly rules: MassRules,
    ) {}

    /** Forgets everything; the next query reads the scene again (the grids changed). */
    invalidate(): void {
        this.game = null;
        this.weights = null;
        this.bodies.clear();
    }

    /** Applies edited tiles ([grid, x, y]) and entities that were added, removed, moved or changed. */
    update(tiles: Iterable<readonly [number, number, number]>, entities: Iterable<number> = []): void {
        const chunks = new Set<string>();
        for (const [g, x, y] of tiles) {
            if (this.game?.has(g)) chunks.add(`${g}|${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`);
            const w = this.weights?.get(g);
            if (!w) continue;
            const key = `${x},${y}`;
            const name = this.tiles.tileAt(g, x, y);
            const before = w.tiles.get(key) ?? 0, now = name === null ? 0 : this.rules.tileMass(name);
            if (before === now && w.tiles.has(key) === (name !== null)) continue;
            w.sum = add(sub(w.sum, tileShare(x, y, before)), tileShare(x, y, now));
            if (name === null) w.tiles.delete(key);
            else w.tiles.set(key, now);
        }
        for (const k of chunks) {
            const [g, c] = k.split("|") as [string, string];
            this.chunk(Number(g), c);
        }
        if (!this.weights) return;
        for (const uid of entities) this.setBody(uid);
    }

    /** Mass and centre of a grid in a mode (grid coordinates), or null for a grid that is not in the scene. */
    mass(grid: number, mode: MassMode): MassResult | null {
        if (mode === "game") {
            const s = this.gameStates().get(grid);
            if (!s) return null;
            if (!s.sum) {
                let sum = ZERO;
                for (const m of s.chunks.values()) sum = add(sum, m);
                s.sum = sum;
            }
            return result(s.sum);
        }
        const w = this.weightStates().get(grid);
        if (!w) return null;
        // sums kept by adding and taking away: what is left of nothing is rounding
        return w.tiles.size || w.sum.mass > 1e-6 ? result(w.sum) : { mass: 0, centre: null };
    }

    /** The centre of a grid in a mode, or null when it has no mass. */
    centre(grid: number, mode: MassMode): [number, number] | null {
        return this.mass(grid, mode)?.centre ?? null;
    }

    private gameStates(): Map<number, GameState> {
        if (this.game) return this.game;
        this.game = new Map();
        for (const g of this.tiles.grids) {
            const cells = new Map<string, Set<number>>();
            for (const [x, y] of this.tiles.tileCells(g)) {
                const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
                const key = `${cx},${cy}`;
                let set = cells.get(key);
                if (!set) cells.set(key, (set = new Set()));
                set.add(x - cx * CHUNK_SIZE + (y - cy * CHUNK_SIZE) * CHUNK_SIZE);
            }
            const chunks = new Map<string, Moments>();
            for (const [key, set] of cells) {
                const [cx, cy] = key.split(",").map(Number) as [number, number];
                chunks.set(key, chunkBody(cx, cy, (x, y) => set.has(x + y * CHUNK_SIZE), this.rules.tileDensity));
            }
            this.game.set(g, { chunks, sum: null });
        }
        return this.game;
    }

    /** Recomputes the game body of one chunk of a grid. */
    private chunk(grid: number, key: string): void {
        const s = this.game!.get(grid)!;
        const [cx, cy] = key.split(",").map(Number) as [number, number];
        const x0 = cx * CHUNK_SIZE, y0 = cy * CHUNK_SIZE;
        let any = false;
        const has = (x: number, y: number) => {
            const on = this.tiles.tileAt(grid, x0 + x, y0 + y) !== null;
            any ||= on;
            return on;
        };
        const m = chunkBody(cx, cy, has, this.rules.tileDensity);
        if (any) s.chunks.set(key, m);
        else s.chunks.delete(key);
        s.sum = null;
    }

    private weightStates(): Map<number, WeightState> {
        if (this.weights) return this.weights;
        this.weights = new Map();
        for (const g of this.tiles.grids) {
            const tiles = new Map<string, number>();
            let sum = ZERO;
            for (const [x, y] of this.tiles.tileCells(g)) {
                const m = this.rules.tileMass(this.tiles.tileAt(g, x, y)!);
                tiles.set(`${x},${y}`, m);
                sum = add(sum, tileShare(x, y, m));
            }
            this.weights.set(g, { tiles, sum });
        }
        this.bodies.clear();
        for (const uid of this.rules.entityUids()) this.setBody(uid);
        return this.weights;
    }

    /** Replaces an entity's share with what it weighs now. */
    private setBody(uid: number): void {
        const old = this.bodies.get(uid);
        if (old) {
            const w = this.weights!.get(old.grid);
            if (w) w.sum = sub(w.sum, old.m);
            this.bodies.delete(uid);
        }
        const b = this.rules.body(uid);
        const w = b && this.weights!.get(b.grid);
        if (!b || !w || !(b.mass > 0)) return;
        const m = entityMoments([b]);
        w.sum = add(w.sum, m);
        this.bodies.set(uid, { grid: b.grid, m });
    }
}

function tileShare(x: number, y: number, m: number): Moments {
    return { mass: m, mx: m * (x + 0.5), my: m * (y + 0.5) };
}
