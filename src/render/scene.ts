// Turns a map and an asset pack into draw lists (tiles, decals, sprite layers) for the canvas.
// The rules mirror the game's map renderer and client visualizers for a freshly loaded map; they come from
// the Shipyard renderer (github.com/lermal/map_viewer, tools/map-renderer/lib/render-data.mjs).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ENGINE_PROTOTYPES, decalOrder } from "../map/decals";
import type { Frame, Pack } from "../pack/loader";

export const PPM = 32;

/** One sprite layer of an entity. */
export interface SpriteLayer {
    x: number;
    y: number;
    rot: number;
    frame: number;
    color: number[] | null;
    depth: number;
    /** Hidden under a floor tile (shown with "under floor"). */
    subfloor: boolean;
    kind: string;
    uid: number;
    /** Entity draw order. */
    order: number;
    layer: number;
    /** 0: always drawn, 1: only when powered, 2: only when unpowered. */
    power: 0 | 1 | 2;
    scale: [number, number] | null;
    /** Tiles the layer can reach from (x, y) in any direction. */
    ext: number;
}

export interface TileLayer {
    x: number;
    y: number;
    gridRot: number;
    rotMirror: number;
    frame: number;
    subfloor: boolean;
    grid: number;
    ext: number;
}

export interface DecalLayer {
    x: number;
    y: number;
    rot: number;
    frame: number;
    color: number[] | null;
    z: number;
    /** Order among decals of equal z, as the game's overlay sorts them (chunk, then id). */
    seq: number;
    ext: number;
    grid: number;
    id: string;
    /** Decal prototype. */
    proto: string;
}

/** A decal as the scene reads it (see `MapDocument.decals`); x, y is its bottom left corner on the grid. */
export interface SceneDecal {
    id: string;
    proto: string;
    x: number;
    y: number;
    color: string | null;
    angle: number;
    zIndex: number;
}

const DRAW_DEPTH: Record<string, number> = {
    LowFloors: -20, ThickPipe: -19, ThickWire: -18, ThinPipeAlt2: -17, ThinPipeAlt1: -16,
    ThinPipe: -15, ThinWire: -14, BelowFloor: -13, FloorTiles: -12, FloorObjects: -11,
    Puddles: -10, HighFloorObjects: -5, DeadMobs: -4, SmallMobs: -3, Walls: -2,
    WallTops: -1, Objects: 0, Default: 0, SmallObjects: 1, WallMountedItems: 2,
    LargeObjects: 3, Items: 4, BelowMobs: 5, Mobs: 6, OverMobs: 7, Doors: 8,
    BlastDoors: 9, Overdoors: 10, Effects: 11, Ghosts: 12, Overlays: 13,
};
const depthOf = (v: any, fallback: number): number =>
    v === undefined || v === null ? fallback : DRAW_DEPTH[String(v)] ?? (Number.isInteger(v) ? v : fallback);

// Layers that client visualizers keep hidden while the entity is idle (not welded, panel closed, ...)
const HIDDEN_BY_DEFAULT = new Set([
    "enum.WiresVisualLayers.MaintenancePanel", "enum.WeldableLayers.BaseWelded",
    "enum.DoorVisualLayers.BaseBolted", "enum.DoorVisualLayers.BaseEmergencyAccess",
    "enum.DisposalUnitVisualLayers.Unanchored", "enum.DisposalUnitVisualLayers.BaseCharging",
    "enum.DisposalUnitVisualLayers.OverlayFlush", "enum.DisposalUnitVisualLayers.OverlayCharging",
    "enum.DisposalUnitVisualLayers.OverlayReady", "enum.DisposalUnitVisualLayers.OverlayFull",
    "enum.DisposalUnitVisualLayers.OverlayEngaged",
]);
const POWER_KEYS = ["enum.PowerDeviceVisuals.Powered", "enum.ComputerVisuals.Powered"];

// PipeDirection flags (Content.Shared/Atmos/PipeDirection.cs)
const PN = 1, PS = 2, PW = 4, PE = 8;
const PIPE_DIRS: Record<string, number> = {
    None: 0, North: PN, South: PS, West: PW, East: PE, Longitudinal: PN | PS, Lateral: PW | PE,
    NWBend: PN | PW, NEBend: PN | PE, SWBend: PS | PW, SEBend: PS | PE,
    TNorth: PN | PW | PE, TSouth: PS | PW | PE, TWest: PW | PN | PS, TEast: PE | PN | PS,
    Fourway: PN | PS | PW | PE, All: PN | PS | PW | PE,
};
const PIPE_STEP: Array<[number, number, number]> = [[PN, 0, 1], [PS, 0, -1], [PW, -1, 0], [PE, 1, 0]];
const PIPE_OPPOSITE: Record<number, number> = { [PN]: PS, [PS]: PN, [PW]: PE, [PE]: PW };
const PIPE_CCW = [PS, PE, PN, PW]; // counter-clockwise starting at angle 0 (south)
const PIPE_RSI: Record<number, number> = { [PS]: 0, [PN]: 1, [PE]: 2, [PW]: 3 };
const PIPE_LAYERS: Record<string, number> = { Primary: 0, Secondary: 1, Tertiary: 2 };
const PIPE_LAYER_NAMES = ["Primary", "Secondary", "Tertiary"];
const pipeLayerOf = (v: any, fallback = 0): number => {
    if (v === undefined || v === null) return fallback;
    if (Number.isInteger(v)) return v;
    return PIPE_LAYERS[String(v)] ?? (/^\d+$/.test(String(v)) ? Number(v) : fallback);
};
const PIPE_CONNECTOR_RSI = [
    "Structures/Piping/Atmospherics/pipe.rsi",
    "Structures/Piping/Atmospherics/pipe_alt1.rsi",
    "Structures/Piping/Atmospherics/pipe_alt2.rsi",
];

// RsiDirection index (S=0, N=1, E=2, W=3, SE=4, SW=5, NE=6, NW=7) for Direction (S=0 .. SW=7)
const DIR4: Record<number, number> = { 0: 0, 2: 2, 4: 1, 6: 3 };
const DIR8: Record<number, number> = { 0: 0, 1: 4, 2: 2, 3: 6, 4: 1, 5: 7, 6: 3, 7: 5 };
const OFFSETS: Record<string, number[]> = {
    None: [0, 1, 2, 3],
    Clockwise: [3, 2, 0, 1],
    CounterClockwise: [2, 3, 1, 0],
    Flip: [1, 0, 3, 2],
};

const TAU = 2 * Math.PI;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const cardinalDir = (t: number) => (Math.floor((mod(t, TAU) + Math.PI / 4) / (Math.PI / 2)) * 2) % 8;
const anyDir = (t: number) => Math.floor((mod(t, TAU) + Math.PI / 8) / (Math.PI / 4)) % 8;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const truthy = (v: any) => String(v).toLowerCase() === "true";
const isFalse = (v: any) => String(v ?? true).toLowerCase() === "false";

function parseAngle(v: any): number {
    if (v === undefined || v === null) return 0;
    const s = String(v).trim();
    if (s.endsWith("rad")) return parseFloat(s);
    if (s.endsWith("deg")) return (parseFloat(s) * Math.PI) / 180;
    return parseFloat(s) || 0;
}

function parseVec(v: any, fallback: [number, number] = [0, 0]): [number, number] {
    if (v === undefined || v === null) return fallback;
    if (Array.isArray(v)) return [Number(v[0]), Number(v[1])];
    const [a, b] = String(v).split(",");
    return [parseFloat(a ?? "0"), parseFloat(b ?? "0")];
}

const mulColor = (a: number[] | null, b: number[] | null) => (!a ? b : !b ? a : a.map((x, i) => x * b[i]!));
const keysOf = (layer: any) => new Set<string>([].concat(layer.map ?? []).map(String));
const texPath = (ref: string) => String(ref).replace(/^\/+/, "").replace(/^Textures\//, "");

function decodeTiles(chunks: any, tilemap: Map<number, string>): Map<string, [string, number, number]> {
    const out = new Map<string, [string, number, number]>();
    for (const [key, ch] of Object.entries<any>(chunks ?? {})) {
        const [cx, cy] = String(ch.ind ?? key).split(",").map(Number) as [number, number];
        const bin = atob(String(ch.tiles ?? ""));
        const raw = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        const view = new DataView(raw.buffer);
        const ver = Number(ch.version ?? 1);
        const size = ver >= 7 ? 7 : ver >= 6 ? 6 : 4;
        const n = Math.floor(raw.length / size);
        const cs = Math.round(Math.sqrt(n));
        for (let i = 0; i < n; i++) {
            const o = i * size;
            const tid = ver >= 6 ? view.getInt32(o, true) : view.getUint16(o, true);
            const p = ver >= 6 ? 4 : 2;
            const name = tilemap.get(tid);
            if (!name || name === "Space") continue;
            out.set(`${cx * cs + (i % cs)},${cy * cs + Math.floor(i / cs)}`, [name, raw[o + p + 1]!, ver >= 7 ? raw[o + p + 2]! : 0]);
        }
    }
    return out;
}

// ---- IconSmooth rules (Content.Client/IconSmoothing/Smoothings/*.cs)

const rotr8 = (v: number, n: number) => (n > 0 ? ((v >> n) | (v << (8 - n))) & 0xff : v);
const overlaps = (keys: Set<string> | null | undefined, mask: unknown) =>
    !!keys && Array.isArray(mask) && mask.some((m) => keys.has(String(m)));

/** Direction8Flag mask of the three directions a corner looks at, for the iteration index that completes it. */
const CORNER_MASK: Record<number, number> = { 2: 0b0000_0111, 4: 0b0001_1100, 6: 0b0111_0000, 7: 0b1100_0001 };
const CORNER_KEY: Record<number, string> = { 2: "SouthEast", 4: "NorthEast", 6: "NorthWest", 7: "SouthWest" };
/** Corner layers in the order CornerSpriteSmoothing adds them, with their direction offsets. */
const CORNER_LAYERS: Array<[string, string]> = [["SouthEast", "None"], ["SouthWest", "Clockwise"], ["NorthEast", "CounterClockwise"], ["NorthWest", "Flip"]];
const EDGES: Array<[number, string, [number, number]]> = [[0, "south", [0, -1]], [2, "east", [1, 0]], [4, "north", [0, 1]], [6, "west", [-1, 0]]];

function cardinalOf(flag: number): number {
    flag &= 0x55;
    flag |= flag >> 1;
    flag &= 0x33;
    flag |= flag >> 2;
    return flag & 0xf;
}

function cardinalCornerState(base: string, dirs: number, alt: number): string {
    const cardinals = cardinalOf(dirs);
    const cardinalMask = cardinals | cardinalOf(alt);
    if (cardinalMask < 3) return cardinalMask !== cardinals ? `${base}${cardinalMask + 2}` : `${base}${cardinals}`;
    if (cardinalMask === cardinals) {
        if ((dirs & 2) === 2) return `${base}6`;
        if ((alt & 2) === 2) return `${base}7`;
        return `${base}5`;
    }
    if ((dirs & 2) === 2 || (alt & 2) === 2) return `${base}${cardinals + 11}`;
    return `${base}${cardinals + 8}`;
}

/** Adds the layers of one smoothing rule (InitializeStates) with the states it picks for the neighbours (EnumerateStates). */
function applySmoothRule(rule: any, adjacent: Array<Set<string> | null>, layers: any[]): void {
    const type = String(rule["!type"] ?? "");
    const base = String(rule.base ?? "");
    const insert = (layer: any) => {
        if (Number.isInteger(rule.index) && rule.index >= 0 && rule.index <= layers.length) layers.splice(rule.index, 0, layer);
        else layers.push(layer);
    };

    if (type === "CornerSpriteSmoothing" || type === "CardinalCornerSpriteSmoothing") {
        const states = new Map<string, string>();
        let match = 0, alt = 0, seen = 0;
        for (let i = 0; i < 8; i++) {
            if (overlaps(adjacent[i], rule.mask)) match |= 1 << i;
            if (overlaps(adjacent[i], rule.altMask)) alt |= 1 << i;
            const mask = CORNER_MASK[i];
            if (mask === undefined) continue;
            states.set(
                CORNER_KEY[i]!,
                type === "CornerSpriteSmoothing"
                    ? `${base}${rotr8(match & mask, seen)}`
                    : cardinalCornerState(base, rotr8(match & mask, seen), rotr8(alt & mask, seen)),
            );
            seen += 2;
        }
        for (const [key, offset] of CORNER_LAYERS) insert({ state: states.get(key), _diroff: offset });
    } else if (type === "DiagonalSpriteSmoothing" || type === "AltDiagonalSpriteSmoothing") {
        let match = 0, alt = 0;
        for (let i = 0; i <= 2; i++) {
            if (overlaps(adjacent[i], rule.mask)) match |= 1 << i;
            if (overlaps(adjacent[i], rule.altMask)) alt |= 1 << i;
        }
        const full = 0b111;
        const state = (match & full) === full ? 1 : type === "AltDiagonalSpriteSmoothing" && (alt & full) === full ? 2 : 0;
        insert({ state: `${base}${state}` });
    } else if (type === "DirectionSpriteSmoothing") {
        let match = 0;
        for (let i = 0; 2 * i < 8; i++) if (overlaps(adjacent[2 * i], rule.mask)) match |= 1 << i;
        insert({ state: `${base}${match}` });
    } else if (type === "EdgeSpriteSmoothing") {
        // an edge shows where the neighbour does not smooth with us
        for (const [i, suffix, [ox, oy]] of EDGES) insert({ state: `${base}${suffix}`, offset: `${ox},${oy}`, visible: !overlaps(adjacent[i], rule.mask) });
    }
}

/** Collects the texture frames a scene uses. */
class Frames {
    readonly list: Frame[] = [];
    private readonly index = new Map<string, number>();
    readonly licenses = new Map<string, Set<string>>();
    readonly missing = new Set<string>();

    constructor(private readonly pack: Pack) {}

    private add(f: Frame): number {
        const key = f.join("|");
        let i = this.index.get(key);
        if (i === undefined) {
            i = this.list.length;
            this.list.push(f);
            this.index.set(key, i);
        }
        return i;
    }

    stateDirs(rsi: string, state: string): number {
        return this.pack.stateDirections(texPath(rsi), state);
    }

    rsiFrame(rsi: string, state: string, dir: number): number | null {
        const key = texPath(rsi);
        const f = this.pack.rsiFrame(key, state, dir);
        if (!f) {
            this.missing.add(`${key}:${state}`);
            return null;
        }
        const license = this.pack.textures.rsi[key]?.license;
        if (license) {
            if (!this.licenses.has(license)) this.licenses.set(license, new Set());
            this.licenses.get(license)!.add(key);
        }
        return this.add(f);
    }

    texture(ref: string, variant = 0): number | null {
        const f = this.pack.texture(texPath(ref), variant);
        if (!f) {
            this.missing.add(texPath(ref));
            return null;
        }
        return this.add(f);
    }
}

/** Whether two lists of layer rows are equal (the powered and unpowered looks of an entity). */
function sameRows(a: LayerRow[], b: LayerRow[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const r = a[i]!, q = b[i]!;
        for (let k = 0; k < r.length; k++) {
            const u = r[k], v = q[k];
            if (u === v) continue;
            if (Array.isArray(u) && Array.isArray(v) && u.length === v.length && u.every((x, j) => x === v[j])) continue;
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Spatial index

/** Something drawn at world (x, y) that reaches at most `ext` tiles from it in any direction. */
interface Placed {
    x: number;
    y: number;
    ext: number;
}

const BUCKET = 8; // tiles per side of an index bucket
const bucketKey = (bx: number, by: number) => (bx + 32768) * 65536 + (by + 32768);

/** Items bucketed by the tile area of their centre, for drawing and invalidating one chunk at a time. */
export class SpatialIndex<T extends Placed> {
    private readonly cells = new Map<number, Set<T>>();
    /** Largest reach of any item ever added; queries are widened by it. */
    maxExt = 0;
    size = 0;

    add(item: T): void {
        const k = bucketKey(Math.floor(item.x / BUCKET), Math.floor(item.y / BUCKET));
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = new Set()));
        cell.add(item);
        this.size++;
        if (item.ext > this.maxExt) this.maxExt = item.ext;
    }

    remove(item: T): void {
        const k = bucketKey(Math.floor(item.x / BUCKET), Math.floor(item.y / BUCKET));
        const cell = this.cells.get(k);
        if (cell?.delete(item)) this.size--;
        if (cell && !cell.size) this.cells.delete(k);
    }

    /** Items that may touch the world rectangle [x0, x1] × [y0, y1] (unordered). */
    query(x0: number, y0: number, x1: number, y1: number): T[] {
        const m = this.maxExt;
        const out: T[] = [];
        for (let bx = Math.floor((x0 - m) / BUCKET); bx <= Math.floor((x1 + m) / BUCKET); bx++) {
            for (let by = Math.floor((y0 - m) / BUCKET); by <= Math.floor((y1 + m) / BUCKET); by++) {
                const cell = this.cells.get(bucketKey(bx, by));
                if (!cell) continue;
                for (const t of cell) {
                    if (t.x + t.ext >= x0 && t.x - t.ext <= x1 && t.y + t.ext >= y0 && t.y - t.ext <= y1) out.push(t);
                }
            }
        }
        return out;
    }

    clear(): void {
        this.cells.clear();
        this.size = 0;
        this.maxExt = 0;
    }

    *[Symbol.iterator](): IterableIterator<T> {
        for (const cell of this.cells.values()) yield* cell;
    }
}

/** World rectangle [x0, y0, x1, y1]. */
export type Rect = [number, number, number, number];

// ---------------------------------------------------------------------------------------------
// Scene

/** What the scene reads a map from; `MapDocument` is one. */
export interface SceneSource {
    /** Entity uids in file order. */
    uids(): Iterable<number>;
    entityData(uid: number): { proto: string; components: unknown[] } | undefined;
    listedGrids(): number[];
    tilemap(): Map<number, string>;
    tile(grid: number, x: number, y: number): { id: number; variant: number; rotationMirroring: number };
    /** Decals of a grid; without it, the scene reads the grid's `DecalGrid` from its entity data. */
    decals?(grid: number): Iterable<SceneDecal>;
    decal?(grid: number, id: string): SceneDecal | undefined;
}

/** What changed in the source (see `MapDocument.onChange`). */
export interface SceneChange {
    entities: Iterable<number>;
    tiles: Iterable<[number, number, number]>;
    /** Decals changed, as [grid, decal id]. */
    decals?: Iterable<[number, string]>;
}

interface Ent {
    uid: number;
    proto: string;
    name: string;
    c: any;
}

interface Info {
    g: number | null;
    lx: number;
    ly: number;
    lrot: number;
    anchored: boolean;
    tx: number;
    ty: number;
}

type Xf = [number, number, number, number | null];
type LayerRow = [number, number, number, number, number[] | null, number, number, string, number, [number, number] | null];

// Direction of a neighbour offset as in Robust's Direction enum (S=0, SE, E, NE, N, NW, W, SW=7)
const DIRECTION_OF: Record<string, number> = { "0,-1": 0, "1,-1": 1, "1,0": 2, "1,1": 3, "0,1": 4, "-1,1": 5, "-1,0": 6, "-1,-1": 7 };

const cellKey = (g: number, x: number, y: number) => `${g}|${x}|${y}`;

/**
 * A map turned into draw lists (tiles, decals, sprite layers) for the canvas, kept up to date with edits.
 * The rules mirror the game's map renderer and client visualizers for a freshly loaded map. After an edit,
 * `apply` recomputes only the entities it touched, their children and their neighbours (smoothing, pipes,
 * cables and the like look at adjacent tiles), and returns the world areas whose drawing changed.
 */
export class Scene {
    readonly sprites = new SpatialIndex<SpriteLayer>();
    readonly tiles = new SpatialIndex<TileLayer>();
    readonly decals = new SpatialIndex<DecalLayer>();
    /** Drawn entities: uid → [prototype id, display name]. */
    readonly entities = new Map<number, [string, string]>();
    /** Union of everything drawn so far (it grows with edits, never shrinks). */
    bounds: Rect = [0, 0, 1, 1];

    private fr: Frames;
    private readonly protos;
    private tilemap = new Map<number, string>();
    private readonly ents = new Map<number, Ent>();
    /** Draw order of entities: file order, then the order in which edits added them. */
    private readonly order = new Map<number, number>();
    private nextOrder = 0;
    private gridUids = new Set<number>();
    private readonly parentOf = new Map<number, number>();
    private readonly children = new Map<number, Set<number>>();
    /** Contained entities that their container hides, with the containers that hold them. */
    private readonly hiddenBy = new Map<number, Set<number>>();
    private readonly contentsOf = new Map<number, number[]>();
    private readonly world = new Map<number, Xf>();
    private readonly info = new Map<number, Info>();
    /** Anchored entities on each grid tile. */
    private readonly occ = new Map<string, number[]>();
    /** IconSmooth keys present on each tile (IconSmoothGridComponent's cache), filled on use. */
    private readonly smoothCache = new Map<string, Set<string> | null>();
    private readonly pipeNodes = new Map<number, Array<[string, number, number]>>();
    private readonly gridTiles = new Map<number, Map<string, [string, number, number]>>();
    private readonly spriteLayers = new Map<number, SpriteLayer[]>();
    private readonly tileLayers = new Map<string, TileLayer>();
    private readonly decalLayers = new Map<string, DecalLayer>();
    private readonly gridAreas = new Map<number, Rect>();
    private dirty: Rect[] = [];

    constructor(
        private readonly source: SceneSource,
        private readonly pack: Pack,
    ) {
        this.protos = pack.prototypes;
        this.fr = new Frames(pack);
        this.build();
    }

    get frames(): Frame[] {
        return this.fr.list;
    }

    get licenses(): Record<string, string[]> {
        return Object.fromEntries([...this.fr.licenses].map(([k, v]) => [k, [...v].sort()]));
    }

    get missing(): string[] {
        return [...this.fr.missing].sort();
    }

    /** Sprite layers in drawing order (draw depth, then higher y first, then entity order, then layer order). */
    static sortSprites(list: SpriteLayer[]): SpriteLayer[] {
        return list.sort((a, b) => a.depth - b.depth || b.y - a.y || a.order - b.order || a.layer - b.layer);
    }

    // -----------------------------------------------------------------------------------------
    // Queries for the editor

    /** Grid entities (they carry tiles). */
    get grids(): number[] {
        return [...this.gridUids];
    }

    /** Sprite layers drawn for an entity (both power states). */
    layersOf(uid: number): readonly SpriteLayer[] {
        return this.spriteLayers.get(uid) ?? [];
    }

    /**
     * Entities placed in the world (not inside containers) that draw nothing: spawn points, markers,
     * invisible machinery. Area selections take them too, so moving a whole shuttle leaves nothing behind.
     */
    *undrawn(): IterableIterator<number> {
        // entities without a parent (the map itself) hold everything else: they are not part of an area
        for (const uid of this.info.keys()) if (!this.spriteLayers.has(uid) && this.parentOf.has(uid) && !this.gridUids.has(uid)) yield uid;
    }

    /** World position (tiles) and rotation of an entity, or null when it is not in the scene. */
    worldTransform(uid: number): { x: number; y: number; rot: number } | null {
        if (!this.ents.has(uid)) return null;
        const [x, y, rot] = this.worldXf(uid);
        return { x, y, rot };
    }

    /** Where a drawn entity is on its grid (grid null when it is on none) and whether it is anchored there. */
    placement(uid: number): { grid: number | null; x: number; y: number; rot: number; anchored: boolean } | null {
        const i = this.info.get(uid);
        return i ? { grid: i.g, x: i.lx, y: i.ly, rot: i.lrot, anchored: i.anchored } : null;
    }

    /** World point → coordinates local to an entity (a grid, the map, a container...). */
    toLocal(uid: number, wx: number, wy: number): [number, number] {
        const [ox, oy, r] = this.ents.has(uid) ? this.worldXf(uid) : [0, 0, 0];
        const c = Math.cos(-r), s = Math.sin(-r), dx = wx - ox, dy = wy - oy;
        return [c * dx - s * dy, s * dx + c * dy];
    }

    /** Coordinates local to an entity → world point. */
    toWorld(uid: number, lx: number, ly: number): [number, number] {
        const [ox, oy, r] = this.ents.has(uid) ? this.worldXf(uid) : [0, 0, 0];
        const c = Math.cos(r), s = Math.sin(r);
        return [ox + c * lx - s * ly, oy + s * lx + c * ly];
    }

    /** The drawn layer of a decal, or undefined (no such decal, or nothing of it is drawn). */
    decalLayer(grid: number, id: string): DecalLayer | undefined {
        return this.decalLayers.get(`${grid}|${id}`);
    }

    /** Anchored entities on a grid tile. */
    anchoredAt(grid: number, x: number, y: number): readonly number[] {
        return this.occAt(grid, x, y);
    }

    /** Coordinates of every non-space tile of a grid. */
    *tileCells(grid: number): IterableIterator<[number, number]> {
        for (const key of this.gridTiles.get(grid)?.keys() ?? []) {
            const [x, y] = key.split(",").map(Number) as [number, number];
            yield [x, y];
        }
    }

    /** Tile name on a grid tile, or null where there is none (space). */
    tileAt(grid: number, x: number, y: number): string | null {
        return this.gridTiles.get(grid)?.get(`${x},${y}`)?.[0] ?? null;
    }

    /**
     * The grid at a world point: the one with a tile there (drawn on top when several are), else the grid
     * whose tile area is nearest, or null when the map has no grid.
     */
    gridAt(wx: number, wy: number): number | null {
        let best: number | null = null, bestDist = Infinity;
        for (const g of [...this.gridUids].sort((a, b) => b - a)) {
            const [lx, ly] = this.toLocal(g, wx, wy);
            if (this.tileAt(g, Math.floor(lx), Math.floor(ly)) !== null) return g;
            const [x0, y0, x1, y1] = this.gridArea(g);
            const d = Math.hypot(Math.max(x0 - lx, 0, lx - x1), Math.max(y0 - ly, 0, ly - y1));
            if (d < bestDist || best === null) [best, bestDist] = [g, d];
        }
        return best;
    }

    /** Tile area of a grid in its own coordinates, cached until its tiles change. */
    private gridArea(g: number): Rect {
        let area = this.gridAreas.get(g);
        if (area) return area;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const key of this.gridTiles.get(g)?.keys() ?? []) {
            const [x, y] = key.split(",").map(Number) as [number, number];
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x + 1);
            y1 = Math.max(y1, y + 1);
        }
        area = x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
        this.gridAreas.set(g, area);
        return area;
    }

    // -----------------------------------------------------------------------------------------
    // Building and updating

    private build(): void {
        for (const s of [this.sprites, this.tiles, this.decals]) s.clear();
        this.entities.clear();
        for (const m of [this.ents, this.parentOf, this.children, this.hiddenBy, this.contentsOf, this.world, this.info, this.occ, this.smoothCache, this.pipeNodes, this.gridTiles, this.spriteLayers, this.tileLayers, this.decalLayers, this.gridAreas]) m.clear();
        this.tilemap = this.source.tilemap();

        for (const uid of this.source.uids()) {
            if (!this.order.has(uid)) this.order.set(uid, this.nextOrder++);
            this.loadEntity(uid);
        }
        const listed = this.source.listedGrids();
        this.gridUids = new Set(listed.length ? listed : [...this.ents.values()].filter((e) => e.c.MapGrid).map((e) => e.uid));

        for (const g of this.gridUids) this.gridTiles.set(g, decodeTiles(this.ents.get(g)?.c.MapGrid?.chunks, this.tilemap));
        for (const uid of this.ents.keys()) this.place(uid);
        for (const uid of this.ents.keys()) this.renderEntity(uid);
        for (const [g, tl] of this.gridTiles) for (const key of tl.keys()) this.renderTile(g, key);
        this.renderDecals();

        // bounds: the tile area, or the sprites when there are no tiles
        const pts: Placed[] = this.tiles.size ? [...this.tiles].map((t) => ({ ...t, ext: 0.5 })) : [...this.sprites].map((s) => ({ ...s, ext: 0 }));
        this.bounds = [0, 0, 1, 1];
        if (pts.length) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const { x, y, ext } of pts) {
                x0 = Math.min(x0, x - ext);
                y0 = Math.min(y0, y - ext);
                x1 = Math.max(x1, x + ext);
                y1 = Math.max(y1, y + ext);
            }
            this.bounds = [x0, y0, x1, y1].map(r4) as Rect;
        }
        this.dirty = [];
    }

    /**
     * Brings the scene up to date with a change of the source. Returns the world areas to redraw,
     * or null when everything changed (a grid was edited).
     */
    apply(change: SceneChange): Rect[] | null {
        const changed = new Set(change.entities);
        const tileEdits = [...change.tiles];
        // grids carry everything on them: an edit of a grid entity itself redraws the whole scene
        const data = new Map<number, ReturnType<SceneSource["entityData"]>>();
        for (const uid of changed) {
            if (this.gridUids.has(uid)) return this.rebuild();
            const d = this.source.entityData(uid);
            if (d?.components.some((c: any) => c?.type === "MapGrid")) return this.rebuild();
            data.set(uid, d);
        }
        this.dirty = [];
        const cells = new Set<string>();

        // tiles
        if (tileEdits.length) this.tilemap = this.source.tilemap();
        for (const [g, x, y] of tileEdits) {
            const tl = this.gridTiles.get(g);
            if (!tl) continue;
            const t = this.source.tile(g, x, y);
            const name = this.tilemap.get(t.id);
            const key = `${x},${y}`;
            if (!name || name === "Space") tl.delete(key);
            else tl.set(key, [name, t.variant, t.rotationMirroring]);
            this.gridAreas.delete(g);
            this.renderTile(g, key);
            cells.add(cellKey(g, x, y));
        }

        // decals: a few are looked up one by one, many are read with all decals of their grid
        const decalEdits = new Map<number, Set<string>>();
        for (const [g, id] of change.decals ?? []) {
            if (!this.gridUids.has(g)) continue;
            let set = decalEdits.get(g);
            if (!set) decalEdits.set(g, (set = new Set()));
            set.add(id);
        }
        for (const [g, ids] of decalEdits) {
            const all = ids.size > 8 || !this.source.decal ? new Map([...this.decalsOf(g)].map((d) => [d.id, d])) : null;
            for (const id of ids) this.renderDecal(g, id, all ? all.get(id) : this.source.decal!(g, id));
        }

        // entities: data, parents and containers first
        const affected = new Set<number>();
        for (const uid of changed) {
            this.unloadEntity(uid, affected);
            this.loadEntity(uid, affected, data.get(uid));
            if (!this.order.has(uid)) this.order.set(uid, this.nextOrder++);
            affected.add(uid);
        }
        // then everything that moves with them
        for (const uid of [...affected]) for (const d of this.descendants(uid)) affected.add(d);
        for (const uid of affected) this.world.delete(uid);
        for (const uid of affected) {
            const before = this.info.get(uid);
            if (before?.anchored && before.g !== null) cells.add(cellKey(before.g, before.tx, before.ty));
            this.unplace(uid);
            this.place(uid);
            const after = this.info.get(uid);
            if (after?.anchored && after.g !== null) cells.add(cellKey(after.g, after.tx, after.ty));
        }

        // redraw them and their neighbours
        const redraw = new Set(affected);
        for (const k of cells) {
            const [g, x, y] = k.split("|").map(Number) as [number, number, number];
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const o of this.occAt(g, x + dx, y + dy)) redraw.add(o);
        }
        for (const uid of redraw) this.renderEntity(uid);

        const out = this.dirty;
        this.dirty = [];
        for (const [x0, y0, x1, y1] of out) {
            this.bounds = [Math.min(this.bounds[0], x0), Math.min(this.bounds[1], y0), Math.max(this.bounds[2], x1), Math.max(this.bounds[3], y1)];
        }
        return out;
    }

    private rebuild(): null {
        this.build();
        return null;
    }

    private loadEntity(uid: number, affected?: Set<number>, known?: ReturnType<SceneSource["entityData"]>): void {
        const d = known ?? this.source.entityData(uid);
        if (!d) return;
        const original = d.proto;
        const proto = original ? this.pack.migrate(original) : "";
        if (proto === null) return; // removed by a migration
        const base = proto ? this.protos.entities[proto] : undefined;
        if (proto && !base && !ENGINE_PROTOTYPES.has(proto)) this.fr.missing.add(`prototype ${proto}`);
        const c: any = {};
        for (const [k, v] of Object.entries(base?.components ?? {})) c[k] = { ...(v as object) };
        for (const comp of d.components as any[]) if (comp && typeof comp === "object" && comp.type) c[comp.type] = { ...(c[comp.type] ?? {}), ...comp };
        this.ents.set(uid, { uid, proto, name: base?.name ?? proto, c });

        const parent = c.Transform?.parent;
        if (parent !== undefined && parent !== null && parent !== "invalid" && Number.isFinite(Number(parent))) {
            const p = Number(parent);
            this.parentOf.set(uid, p);
            let set = this.children.get(p);
            if (!set) this.children.set(p, (set = new Set()));
            set.add(uid);
        }

        // contained entities are hidden unless the container shows them
        const contents: number[] = [];
        for (const cont of Object.values<any>(c.ContainerContainer?.containers ?? {})) {
            if (!cont || typeof cont !== "object" || truthy(cont.showEnts)) continue;
            for (const u of cont.ents ?? []) contents.push(Number(u));
            if (cont.ent !== undefined && cont.ent !== null && cont.ent !== "invalid") contents.push(Number(cont.ent));
        }
        if (contents.length) {
            this.contentsOf.set(uid, contents);
            for (const u of contents) {
                let by = this.hiddenBy.get(u);
                if (!by) this.hiddenBy.set(u, (by = new Set()));
                by.add(uid);
                affected?.add(u);
            }
        }
    }

    private unloadEntity(uid: number, affected: Set<number>): void {
        if (!this.ents.delete(uid)) return;
        const p = this.parentOf.get(uid);
        if (p !== undefined) {
            this.children.get(p)?.delete(uid);
            this.parentOf.delete(uid);
        }
        for (const u of this.contentsOf.get(uid) ?? []) {
            const by = this.hiddenBy.get(u);
            by?.delete(uid);
            if (by && !by.size) this.hiddenBy.delete(u);
            affected.add(u);
        }
        this.contentsOf.delete(uid);
    }

    private descendants(uid: number): number[] {
        const out: number[] = [];
        const seen = new Set([uid]);
        const visit = (id: number) => {
            for (const c of this.children.get(id) ?? []) {
                if (seen.has(c)) continue;
                seen.add(c);
                out.push(c);
                visit(c);
            }
        };
        visit(uid);
        return out;
    }

    // -----------------------------------------------------------------------------------------
    // Transforms and tile occupancy

    private localXf(e: Ent | undefined): [number, number, number, any] {
        const x = e?.c.Transform ?? {};
        const [px, py] = parseVec(x.pos);
        return [px, py, parseAngle(x.rot), x.parent];
    }

    private worldXf(uid: number, depth = 0): Xf {
        const done = this.world.get(uid);
        if (done) return done;
        const e = this.ents.get(uid);
        if (!e || depth > 32) return [0, 0, 0, null];
        const [px, py, rot, parent] = this.localXf(e);
        const grid = this.gridUids.has(uid) ? uid : null;
        let res: Xf;
        if (parent === undefined || parent === null || parent === "invalid" || !this.ents.has(Number(parent))) {
            res = [px, py, rot, grid];
        } else {
            const [ppx, ppy, prot, pgrid] = this.worldXf(Number(parent), depth + 1);
            const c = Math.cos(prot), s = Math.sin(prot);
            res = [ppx + c * px - s * py, ppy + s * px + c * py, prot + rot, grid ?? pgrid];
        }
        this.world.set(uid, res);
        return res;
    }

    private gridLocal(uid: number): [number | null, number, number, number] {
        const [px, py, rot, parent] = this.localXf(this.ents.get(uid));
        if (this.gridUids.has(Number(parent))) return [Number(parent), px, py, rot];
        const [wx, wy, wr, g] = this.worldXf(uid);
        if (g === null) return [null, wx, wy, wr];
        const [gx, gy, gr] = this.worldXf(g);
        const c = Math.cos(-gr), s = Math.sin(-gr), dx = wx - gx, dy = wy - gy;
        return [g, c * dx - s * dy, s * dx + c * dy, wr - gr];
    }

    /** Works out where an entity is and records it on its tile (anchored entities) and its pipe nodes. */
    private place(uid: number): void {
        const e = this.ents.get(uid);
        if (!e || this.gridUids.has(uid) || this.hiddenBy.has(uid)) return;
        const [g, lx, ly, lrot] = this.gridLocal(uid);
        const anchored = truthy(e.c.Transform?.anchored ?? false);
        const tx = Math.floor(lx), ty = Math.floor(ly);
        this.info.set(uid, { g, lx, ly, lrot, anchored, tx, ty });
        if (!anchored || g === null) return;
        const k = cellKey(g, tx, ty);
        const list = this.occ.get(k);
        if (list) list.push(uid);
        else this.occ.set(k, [uid]);
        this.smoothCache.delete(k);

        const c = e.c;
        const defaultLayer = pipeLayerOf(c.AtmosPipeLayers?.pipeLayer);
        const nodes: Array<[string, number, number]> = [];
        for (const nd of Object.values<any>(c.NodeContainer?.nodes ?? {})) {
            if (!nd || typeof nd !== "object" || nd.pipeDirection === undefined) continue;
            if (isFalse(nd.connectionsEnabled)) continue;
            let mask = PIPE_DIRS[String(nd.pipeDirection)] ?? (Number.isInteger(nd.pipeDirection) ? nd.pipeDirection : 0);
            if (!isFalse(nd.rotationsEnabled)) mask = rotatePipe(mask, lrot);
            // the server moves every pipe node to the component's layer on startup (AtmosPipeLayersSystem)
            nodes.push([nd.nodeGroupID ?? "Pipe", c.AtmosPipeLayers ? defaultLayer : pipeLayerOf(nd.pipeLayer), mask]);
        }
        if (nodes.length) this.pipeNodes.set(uid, nodes);
    }

    private unplace(uid: number): void {
        const i = this.info.get(uid);
        if (!i) return;
        this.info.delete(uid);
        this.pipeNodes.delete(uid);
        if (!i.anchored || i.g === null) return;
        const k = cellKey(i.g, i.tx, i.ty);
        const list = this.occ.get(k);
        if (list) {
            const at = list.indexOf(uid);
            if (at >= 0) list.splice(at, 1);
            if (!list.length) this.occ.delete(k);
        }
        this.smoothCache.delete(k);
    }

    private occAt(g: number, x: number, y: number): number[] {
        return this.occ.get(cellKey(g, x, y)) ?? [];
    }

    private smoothKeysAt(g: number, x: number, y: number): Set<string> | null {
        const k = cellKey(g, x, y);
        let keys = this.smoothCache.get(k);
        if (keys !== undefined) return keys;
        keys = null;
        for (const o of this.occAt(g, x, y)) {
            const smooth = this.ents.get(o)!.c.IconSmooth;
            if (smooth && !isFalse(smooth.enabled) && smooth.key !== undefined && smooth.key !== null) (keys ??= new Set()).add(String(smooth.key));
        }
        this.smoothCache.set(k, keys);
        return keys;
    }

    private isSubfloor(g: number, tx: number, ty: number): boolean {
        const t = this.gridTiles.get(g)?.get(`${tx},${ty}`);
        return t === undefined ? true : !!this.pack.tile(t[0])?.isSubfloor;
    }

    /** Keys of the 8 neighbours, indexed by direction relative to the entity's rotation (IconSmoothSystem.PopulateAdjacentKeys). */
    private adjacentKeys(g: number, tx: number, ty: number, lrot: number): Array<Set<string> | null> {
        const out: Array<Set<string> | null> = new Array(8).fill(null);
        const offset = cardinalDir(-lrot);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const keys = this.smoothKeysAt(g, tx + dx, ty + dy);
                if (!keys) continue;
                out[(DIRECTION_OF[`${dx},${dy}`]! + offset) % 8] = keys;
            }
        }
        return out;
    }

    private smoothMatch(smooth: any, g: number, x: number, y: number): boolean {
        return this.occAt(g, x, y).some((o) => {
            const os = this.ents.get(o)!.c.IconSmooth;
            if (!os || os.key === undefined || os.key === null || isFalse(os.enabled)) return false;
            return os.key === smooth.key || (smooth.additionalKeys ?? []).includes(os.key);
        });
    }

    private pipeConnections(uid: number, g: number, tx: number, ty: number): Map<number, number> {
        const conn = new Map<number, number>();
        for (const [group, layer, mask] of this.pipeNodes.get(uid) ?? []) {
            for (const [d, dx, dy] of PIPE_STEP) {
                if (!(mask & d)) continue;
                const linked = this.occAt(g, tx + dx, ty + dy).some((o) =>
                    (this.pipeNodes.get(o) ?? []).some(([og, ol, om]) => og === group && ol === layer && om & PIPE_OPPOSITE[d]!),
                );
                if (linked) conn.set(layer, (conn.get(layer) ?? 0) | d);
            }
        }
        return conn;
    }

    private cableMask(e: Ent, g: number, tx: number, ty: number): number {
        const kind = cableKind(e);
        let mask = 0;
        for (const [bit, dx, dy] of [[1, 0, 1], [2, 0, -1], [4, 1, 0], [8, -1, 0]] as const) {
            if (this.occAt(g, tx + dx, ty + dy).some((o) => cableKind(this.ents.get(o)) === kind)) mask |= bit;
        }
        return mask;
    }

    private color(v: any): number[] | null {
        if (v === undefined || v === null) return null;
        let s = String(v).trim();
        if (!s.startsWith("#")) return this.protos.colors[s.toLowerCase()] ?? null;
        s = s.slice(1);
        if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join("");
        if (s.length === 6) s += "FF";
        return [0, 2, 4, 6].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
    }

    // -----------------------------------------------------------------------------------------
    // Drawing records

    private reach(frame: number, scale: [number, number] | null): number {
        const [, , , fw, fh] = this.fr.list[frame]!;
        const sx = Math.abs(scale?.[0] ?? 1), sy = Math.abs(scale?.[1] ?? 1);
        return Math.hypot(fw * sx, fh * sy) / 2 / PPM;
    }

    private markDirty(t: Placed): void {
        this.dirty.push([t.x - t.ext, t.y - t.ext, t.x + t.ext, t.y + t.ext]);
    }

    private renderEntity(uid: number): void {
        for (const l of this.spriteLayers.get(uid) ?? []) {
            this.sprites.remove(l);
            this.markDirty(l);
        }
        this.spriteLayers.delete(uid);
        this.entities.delete(uid);

        const e = this.ents.get(uid);
        if (!e || !this.info.has(uid)) return;
        const c = e.c, sp = c.Sprite;
        if (!sp || c.Marker) return;
        // SubFloorHide drives sprite visibility itself (revealed when not covered)
        if (isFalse(sp.visible) && !c.SubFloorHide) return;
        const off = this.entityLayers(uid, e, false);
        const gv = c.GenericVisualizer?.visuals ?? {};
        const on = POWER_KEYS.some((k) => k in gv) || c.ApcVisuals || c.Thruster ? this.entityLayers(uid, e, true) : off;
        if (!off.length && !on.length) return;
        const order = this.order.get(uid)!;
        const layers: SpriteLayer[] = [];
        const emit = (rows: LayerRow[], power: 0 | 1 | 2) => {
            for (const r of rows) {
                layers.push({
                    x: r[0], y: r[1], rot: r[2], frame: r[3], color: r[4], depth: r[5], subfloor: r[6] === 1, kind: r[7],
                    uid, order, layer: r[8], power, scale: r[9], ext: this.reach(r[3], r[9]),
                });
            }
        };
        if (on === off || sameRows(on, off)) emit(off, 0);
        else {
            emit(off, 2);
            emit(on, 1);
        }
        for (const l of layers) {
            this.sprites.add(l);
            this.markDirty(l);
        }
        this.spriteLayers.set(uid, layers);
        this.entities.set(uid, [e.proto, e.name]);
    }

    private renderTile(g: number, key: string): void {
        const id = `${g}|${key}`;
        const old = this.tileLayers.get(id);
        if (old) {
            this.tiles.remove(old);
            this.markDirty(old);
            this.tileLayers.delete(id);
        }
        const t = this.gridTiles.get(g)?.get(key);
        if (!t) return;
        const [tname, variant, rotmir] = t;
        const td = this.pack.tile(tname);
        if (!td?.sprite) {
            if (!td) this.fr.missing.add(`tile ${tname}`);
            return;
        }
        const frame = this.fr.texture(td.sprite, variant < td.variants ? variant : 0);
        if (frame === null) return;
        const [gx, gy, gr] = this.worldXf(g);
        const c = Math.cos(gr), s = Math.sin(gr);
        const [x, y] = key.split(",").map(Number) as [number, number];
        const cx = x + 0.5, cy = y + 0.5;
        const layer: TileLayer = {
            x: r4(gx + c * cx - s * cy), y: r4(gy + s * cx + c * cy), gridRot: r4(gr), rotMirror: rotmir, frame,
            subfloor: !!td.isSubfloor, grid: g, ext: this.reach(frame, null),
        };
        this.tiles.add(layer);
        this.tileLayers.set(id, layer);
        this.markDirty(layer);
    }

    private renderDecals(): void {
        for (const g of this.gridUids) for (const d of this.decalsOf(g)) this.renderDecal(g, d.id, d);
    }

    private decalsOf(g: number): Iterable<SceneDecal> {
        if (this.source.decals) return this.source.decals(g);
        const out: SceneDecal[] = [];
        for (const node of this.ents.get(g)?.c.DecalGrid?.chunkCollection?.nodes ?? []) {
            const nd = node.node ?? {};
            for (const [id, pos] of Object.entries(node.decals ?? {})) {
                const [x, y] = parseVec(pos);
                out.push({ id, proto: String(nd.id), x, y, color: nd.color ?? null, angle: parseAngle(nd.angle), zIndex: Number(nd.zIndex ?? 0) || 0 });
            }
        }
        return out;
    }

    /** Redraws one decal of a grid (`d` undefined: it is gone). */
    private renderDecal(g: number, id: string, d: SceneDecal | undefined): void {
        const key = `${g}|${id}`;
        const old = this.decalLayers.get(key);
        if (old) {
            this.decals.remove(old);
            this.markDirty(old);
            this.decalLayers.delete(key);
        }
        if (!d) return;
        const def = this.protos.decals[d.proto];
        if (!def?.sprite) return;
        const frame = "rsi" in def.sprite ? this.fr.rsiFrame(def.sprite.rsi, def.sprite.state, 0) : this.fr.texture(def.sprite.texture);
        if (frame === null) return;
        const [gx, gy, gr] = this.worldXf(g);
        const c = Math.cos(gr), s = Math.sin(gr);
        const w = this.fr.list[frame]![3] / PPM, h = this.fr.list[frame]![4] / PPM;
        const cx = d.x + w / 2, cy = d.y + h / 2;
        const col = this.color(d.color);
        const layer: DecalLayer = {
            x: r4(gx + c * cx - s * cy), y: r4(gy + s * cx + c * cy), rot: r4(gr + d.angle), frame,
            color: col ? col.map((v) => Math.round(v * 1000) / 1000) : null, z: d.zIndex, seq: decalOrder(id), ext: this.reach(frame, null),
            grid: g, id, proto: d.proto,
        };
        this.decals.add(layer);
        this.decalLayers.set(key, layer);
        this.markDirty(layer);
    }

    // ---- per-entity layer emulation
    private entityLayers(uid: number, e: Ent, powered: boolean): LayerRow[] {
        const fr = this.fr, protos = this.protos;
        const occAt = (g: number, x: number, y: number) => this.occAt(g, x, y);
        const color = (v: any) => this.color(v);
        const c = e.c, sp = c.Sprite;
        const { g, lx, ly, lrot, anchored, tx, ty } = this.info.get(uid)!;
        const [wx, wy, wrot] = this.worldXf(uid);
        let baseRsi = sp.sprite;
        let layers: any[] = [];
        if (Array.isArray(sp.layers) && sp.layers.length) {
            layers = sp.layers.filter((l: any) => l && typeof l === "object").map((l: any) => ({ ...l }));
        } else if (sp.state || sp.texture) {
            layers.push({ state: sp.state, texture: sp.texture });
        }
        const setLayers = (key: string, fields: any) => {
            for (const l of layers) if (keysOf(l).has(key)) Object.assign(l, fields);
        };

        // pipe layer sprites (AtmosPipeLayersSystem.SetPipeLayer on startup): alternative layers use shifted RSIs
        const apl = c.AtmosPipeLayers;
        if (apl) {
            const idx = pipeLayerOf(apl.pipeLayer);
            const pick = (paths: any) => paths?.[PIPE_LAYER_NAMES[idx]!] ?? paths?.[idx];
            const baseOverride = pick(apl.spriteRsiPaths);
            if (baseOverride) baseRsi = baseOverride;
            for (const [layerKey, paths] of Object.entries<any>(apl.spriteLayersRsiPaths ?? {})) {
                const rsi = pick(paths);
                if (rsi) setLayers(layerKey, { sprite: rsi });
            }
        }

        for (const l of layers) if ([...keysOf(l)].some((k) => HIDDEN_BY_DEFAULT.has(k))) l.visible = false;

        const gv = c.GenericVisualizer?.visuals ?? {};
        if (Object.keys(gv).length) {
            const values: Record<string, any> = {
                "enum.DisposalTubeVisuals.VisualState": anchored ? "Anchored" : "Free",
                "enum.PowerDeviceVisuals.Powered": powered,
                "enum.ComputerVisuals.Powered": powered,
                "enum.PowerDeviceVisuals.VisualState": "Idle",
                "enum.FoldedVisuals.State": truthy(c.Foldable?.folded ?? false),
            };
            // SharedEntityStorageSystem reports open/closed on startup; charger status (CellVisual) only comes later
            if (c.EntityStorage) values["enum.StorageVisuals.Open"] = truthy(c.EntityStorage.open ?? false);
            if ("enum.AmeShieldVisuals.Core" in gv && g !== null) {
                // AME: a shield surrounded by shields on all 8 sides is a core (AmeNodeGroup)
                let core = true;
                for (let dx = -1; dx <= 1; dx++)
                    for (let dy = -1; dy <= 1; dy++) {
                        if ((dx || dy) && !occAt(g, tx + dx, ty + dy).some((o) => this.ents.get(o)!.proto === e.proto)) core = false;
                    }
                values["enum.AmeShieldVisuals.Core"] = core;
                values["enum.AmeShieldVisuals.CoreState"] = core ? "Weak" : "Off";
            }
            for (const [vkey, perLayer] of Object.entries<any>(gv)) {
                if (!(vkey in values) || !perLayer || typeof perLayer !== "object") continue;
                const val = String(values[vkey]);
                for (const [lkey, options] of Object.entries<any>(perLayer)) {
                    const data = options?.[val] ?? options?.[val.toLowerCase()];
                    if (data && typeof data === "object") {
                        const f: any = {};
                        for (const n of ["state", "visible", "color"]) if (n in data) f[n] = data[n];
                        setLayers(lkey, f);
                    }
                }
            }
        }

        let depthOverride: number | null = null;
        if (c.Door) {
            const open = String(c.Door.state ?? "Closed") === "Open";
            setLayers("enum.DoorVisualLayers.Base", { state: open ? (c.Door.openSpriteState ?? "open") : (c.Door.closedSpriteState ?? "closed") });
            depthOverride = depthOf(open ? c.Door.openDrawDepth : c.Door.closedDrawDepth, DRAW_DEPTH.Doors!);
        }

        const esv = c.EntityStorageVisuals;
        if (esv) {
            const open = truthy(c.EntityStorage?.open ?? false);
            const base = open ? (esv.stateBaseOpen ?? esv.stateBaseClosed) : esv.stateBaseClosed;
            if (base) setLayers("enum.StorageVisualLayers.Base", { state: base });
            const door = open ? esv.stateDoorOpen : esv.stateDoorClosed;
            setLayers("enum.StorageVisualLayers.Door", door ? { state: door, visible: true } : { visible: false });
            const dd = open ? esv.openDrawDepth : esv.closedDrawDepth;
            if (dd !== undefined && dd !== null) depthOverride = depthOf(dd, depthOverride ?? 0);
        }

        if (c.Paper) {
            if (String(c.Paper.content ?? "").trim()) setLayers("enum.PaperVisualLayers.Writing", { visible: true });
            if (c.Paper.stampState) setLayers("enum.PaperVisualLayers.Stamp", { state: c.Paper.stampState, visible: true });
        }

        const stack = c.Stack;
        if (stack?.layerStates && !truthy(stack.composite ?? false)) {
            const states = [...stack.layerStates];
            let actual = Number(stack.count ?? 30);
            let max = Number(stack.maxCountOverride ?? protos.stacks[String(stack.stackType)] ?? 2 ** 31 - 1);
            if (stack.layerFunction === "Threshold") {
                const thresholds: any[] = c.StackLayerThreshold?.thresholds ?? [];
                max = Math.min(thresholds.length + 1, max);
                actual = Math.min(thresholds.filter((t) => actual >= Number(t)).length, max);
            }
            if (states.length > 1) {
                const idx = actual >= max ? states.length - 1 : actual <= 0 ? 0 : Math.trunc((actual / max) * states.length);
                setLayers(stack.baseLayer ?? "", { state: states[idx] });
            }
        }

        // thrusters glow while enabled: anchored, powered and, unless exempt, with open space behind the nozzle
        if (c.Thruster && powered && anchored && g !== null && truthy(c.Thruster.enabled ?? true)) {
            let on = true;
            if (truthy(c.Thruster.requireSpace ?? true)) {
                // the nozzle needs open space behind it: no tile, or a tile the game counts as space (lattice):
                // ThrusterSystem.NozzleExposed → TurfSystem.IsSpace, the tile prototype's `isSpace`
                const nx = Math.floor(lx - Math.sin(lrot)), ny = Math.floor(ly + Math.cos(lrot));
                const behind = this.gridTiles.get(g)?.get(`${nx},${ny}`);
                on = !behind || !!(this.pack.tile(behind[0]) as { isSpace?: boolean } | null)?.isSpace;
            }
            if (on) setLayers("enum.ThrusterVisualLayers.ThrustOn", { visible: true });
        }

        if (c.ApcVisuals) {
            const prefix = c.ApcVisuals.screenPrefix ?? "display";
            const suffixes = c.ApcVisuals.screenSuffixes ?? ["lack", "charging", "full", "remote"];
            setLayers("enum.ApcVisualLayers.ChargeState", { state: `${prefix}-${suffixes[powered ? 2 : 0]}` });
        }

        const vm = c.VendingMachine;
        if (vm) {
            setLayers("enum.VendingMachineVisualLayers.Base", { state: vm.offState ?? "off", visible: true });
            if (vm.normalState ?? "normal-unshaded") setLayers("enum.VendingMachineVisualLayers.BaseUnshaded", { state: vm.normalState ?? "normal-unshaded", visible: true });
            if (vm.screenState) setLayers("enum.VendingMachineVisualLayers.Screen", { state: vm.screenState, visible: true });
        }

        const smooth = c.IconSmooth;
        if (smooth && Array.isArray(smooth.states)) {
            // smoothing rules of the reworked IconSmooth (Content.Client/IconSmoothing/Smoothings)
            const usable = !isFalse(smooth.enabled) && anchored && g !== null;
            const adjacent = usable ? this.adjacentKeys(g!, tx, ty, lrot) : new Array<Set<string> | null>(8).fill(null);
            for (const rule of smooth.states) {
                if (rule && typeof rule === "object") applySmoothRule(rule, adjacent, layers);
            }
        } else if (smooth && (smooth.mode !== undefined || smooth.base !== undefined) && !isFalse(smooth.enabled) && g !== null) {
            // the original IconSmooth (mode + base); in the reworked one an entity with only a key adds no layers
            const mode = smooth.mode ?? "Corners", sbase = smooth.base ?? "";
            const m = (dx: number, dy: number) => this.smoothMatch(smooth, g, tx + dx, ty + dy);
            if (mode === "Corners") {
                const n = m(0, 1), ne = m(1, 1), ee = m(1, 0), se = m(1, -1), s = m(0, -1), sw = m(-1, -1), w = m(-1, 0), nw = m(-1, 1);
                let cNE = (n ? 1 : 0) | (ne ? 2 : 0) | (ee ? 4 : 0);
                let cSE = (ee ? 1 : 0) | (se ? 2 : 0) | (s ? 4 : 0);
                let cSW = (s ? 1 : 0) | (sw ? 2 : 0) | (w ? 4 : 0);
                let cNW = (w ? 1 : 0) | (nw ? 2 : 0) | (n ? 4 : 0);
                const d = cardinalDir(lrot);
                if (d === 4) [cNE, cNW, cSW, cSE] = [cSW, cSE, cNE, cNW];
                else if (d === 6) [cNE, cNW, cSW, cSE] = [cSE, cNE, cNW, cSW];
                else if (d === 2) [cNE, cNW, cSW, cSE] = [cNW, cSW, cSE, cNE];
                for (const [fill, off] of [[cSE, "None"], [cNE, "CounterClockwise"], [cNW, "Flip"], [cSW, "Clockwise"]] as const) {
                    layers.push({ state: `${sbase}${fill}`, _diroff: off });
                }
            } else if (mode === "CardinalFlags" && layers.length) {
                layers[0].state = `${sbase}${(m(0, 1) ? 1 : 0) | (m(0, -1) ? 2 : 0) | (m(1, 0) ? 4 : 0) | (m(-1, 0) ? 8 : 0)}`;
            } else if ((mode === "Diagonal" || mode === "DiagonalNF") && layers.length) {
                const cr = Math.cos(lrot), sr = Math.sin(lrot);
                const rot = (vx: number, vy: number): [number, number] => [Math.round(cr * vx - sr * vy), Math.round(sr * vx + cr * vy)];
                const a = m(...rot(1, 0)), b = m(...rot(0, -1)), dg = m(...rot(1, -1));
                if (mode === "Diagonal") layers[0].state = `${sbase}${a && b && dg ? 1 : 0}`;
                else {
                    let v = (a ? 1 : 0) | (b ? 2 : 0);
                    if (v === 3 && dg) v = 4;
                    layers[0].state = `${sbase}${v}`;
                }
            }
        }

        const cv = c.CableVisualizer;
        if (cv && layers.length && g !== null) {
            const mask = this.cableMask(e, g, tx, ty);
            layers[0].state = `${cv.statePrefix ?? ""}${mask}`;
            if (cv.extraLayerPrefix && layers.length > 1) layers[1].state = `${cv.extraLayerPrefix}${mask}`;
        }

        const pipeColor = c.AtmosPipeColor ? color(c.AtmosPipeColor.color) : null;
        if (c.PipeAppearance && g !== null && this.pipeNodes.has(uid)) {
            const cfg = c.PipeAppearance.sprite;
            const nLayers = c.AtmosPipeLayers ? 3 : 1;
            const gridRot = wrot - lrot;
            for (const [layerIdx, mask] of [...this.pipeConnections(uid, g, tx, ty)].sort((a, b) => a[0] - b[0])) {
                if (layerIdx >= nLayers) continue;
                const spec = Array.isArray(cfg) && cfg[layerIdx] && typeof cfg[layerIdx] === "object" ? cfg[layerIdx] : {};
                for (const d of [PS, PN, PE, PW]) {
                    if (!(mask & d)) continue;
                    layers.push({
                        sprite: spec.sprite ?? PIPE_CONNECTOR_RSI[layerIdx],
                        state: spec.state ?? "pipeConnector",
                        _rsidir: PIPE_RSI[rotatePipe(d, gridRot)],
                        _color: pipeColor ? [pipeColor[0], pipeColor[1], pipeColor[2], 1] : null,
                        map: [`pipeConnector${d}`],
                    });
                }
            }
        }

        const sub = c.SubFloorHide;
        const covered = !!sub && anchored && g !== null && !this.isSubfloor(g, tx, ty);
        const visibleKeys = new Set<string>(sub?.visibleLayers ?? []);
        let kind = "other";
        if (cv) kind = ({ hvcable_: "hv", mvcable_: "mv", lvcable_: "lv" } as Record<string, string>)[cv.statePrefix] ?? "cable";
        else if (c.AtmosPipeColor || c.PipeAppearance) kind = "pipe";
        else if (c.DisposalTube || (e.proto ?? "").includes("Disposal")) kind = "disposal";
        else if (sub) kind = "subfloor";

        let depth = depthOf(sp.drawdepth ?? "Objects", 0);
        if (depthOverride !== null) depth = depthOverride;
        const spriteColor = color(sp.color);
        const [sox, soy] = parseVec(sp.offset);
        const noRot = truthy(sp.noRot ?? false), snap = truthy(sp.snapCardinals ?? false);
        const [ssx, ssy] = parseVec(sp.scale, [1, 1]);

        const out: LayerRow[] = [];
        layers.forEach((layer, li) => {
            if (isFalse(layer.visible)) return;
            const lkeys = keysOf(layer);
            const subLayer = covered && ![...lkeys].some((k) => visibleKeys.has(k));
            let col = mulColor(spriteColor, color(layer.color));
            if ("_color" in layer) col = layer._color; // connectors get the pipe colour assigned, not multiplied
            if (pipeColor && lkeys.has("enum.PipeVisualLayers.Pipe")) col = mulColor(col, [pipeColor[0]!, pipeColor[1]!, pipeColor[2]!, 1]);
            const [lox, loy] = parseVec(layer.offset);
            const [lsx, lsy] = parseVec(layer.scale, [1, 1]);
            const scale: [number, number] = [r4(ssx * lsx), r4(ssy * lsy)];
            let frame: number | null = null, rotate = 0;
            if (layer.texture && !layer.state) {
                frame = fr.texture(layer.texture);
                rotate = noRot || snap ? 0 : wrot;
            } else {
                const rsi = layer.sprite ?? baseRsi;
                const state = layer.state;
                if (!rsi || state === undefined || state === null || state === "") return;
                const ndirs = fr.stateDirs(rsi, String(state));
                if (!ndirs) {
                    fr.missing.add(`${texPath(rsi)}:${state}`);
                    return;
                }
                let rsidir: number;
                if (ndirs === 1) rsidir = 0;
                else if ("_rsidir" in layer) rsidir = layer._rsidir;
                else if (ndirs === 4) rsidir = OFFSETS[layer._diroff ?? "None"]![DIR4[cardinalDir(wrot)]!]!;
                else rsidir = DIR8[anyDir(wrot)]!;
                frame = fr.rsiFrame(rsi, String(state), rsidir);
                if (ndirs === 1 && !noRot && !snap) rotate = wrot;
            }
            if (frame === null) return;
            // the offsets of the sprite and the layer are in the sprite's own frame: they turn with it, as the engine
            // draws them (the sprite matrix carries the entity's rotation, none with noRot, only the part off the
            // nearest cardinal with snapCardinals)
            const ox = sox + lox, oy = soy + loy;
            const offsetTurn = noRot ? 0 : snap ? wrot - Math.round(wrot / (Math.PI / 2)) * (Math.PI / 2) : wrot;
            const offsetCos = Math.cos(offsetTurn), offsetSin = Math.sin(offsetTurn);
            out.push([
                r4(wx + ox * offsetCos - oy * offsetSin), r4(wy + ox * offsetSin + oy * offsetCos), r4(rotate), frame,
                col ? col.map((v) => Math.round(v * 1000) / 1000) : null, depth, subLayer ? 1 : 0, kind, li,
                scale[0] === 1 && scale[1] === 1 ? null : scale,
            ]);
        });
        return out;
    }
}

const rotatePipe = (mask: number, rot: number) => {
    const k = mod(Math.round(rot / (Math.PI / 2)), 4);
    let out = 0;
    PIPE_CCW.forEach((d, i) => {
        if (mask & d) out |= PIPE_CCW[(i + k) % 4]!;
    });
    return out;
};

const cableKind = (e: Ent | undefined) => e?.c.CableVisualizer?.statePrefix ?? null;
