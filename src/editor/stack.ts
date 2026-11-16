// What lies under one point of the map, topmost first (for the pick menu and for cycling through overlapping
// things with repeated clicks). Pure logic over the scene, no DOM.
import { t as translate } from "../i18n";
import type { Frame, Pack } from "../pack/loader";
import { Scene, type SpriteLayer } from "../render/scene";
import { decalIconFrame, entityIconFrame, tileIconFrame } from "../ui/palette-search";
import { texelAt, type OpaqueTest } from "./hit";
import type { PickView, Selection } from "./selection";

export type StackKind = "entity" | "decal" | "tile";

/** One thing under the point: an entity, a decal or the tile. */
export type StackItem =
    | { kind: "entity"; uid: number; proto: string }
    | { kind: "decal"; grid: number; id: string; proto: string }
    | { kind: "tile"; grid: number; x: number; y: number; id: string };

export interface StackOptions {
    /** Kinds to list (default: all). */
    kinds?: readonly StackKind[];
    /** Entities to list (the multitool takes devices only). */
    accept?: (uid: number) => boolean;
    /** Whether a frame pixel is drawn; without it, pixels do not count and only boxes do. */
    opaque?: OpaqueTest;
}

/** Keeps the items hit by pixel first, then those hit only by their box, each group in the order given. */
function pixelsFirst<T>(items: Array<{ item: T; pixel: boolean }>): T[] {
    return [...items.filter((i) => i.pixel), ...items.filter((i) => !i.pixel)].map((i) => i.item);
}

/** Every entity drawn at a point, topmost first: those whose pixels are there, then those whose sprite box is. */
export function entitiesAt(scene: Scene, view: PickView, x: number, y: number, opaque?: OpaqueTest, accept?: (uid: number) => boolean): number[] {
    const layers = Scene.sortSprites(scene.sprites.query(x, y, x, y).filter((s) => view.visible(s)));
    const seen = new Map<number, boolean>(); // uid → listed with a pixel hit
    const found: Array<{ item: number; pixel: boolean }> = [];
    const add = (s: SpriteLayer, pixel: boolean) => {
        const at = seen.get(s.uid);
        if (at === undefined) {
            seen.set(s.uid, pixel);
            found.push({ item: s.uid, pixel });
        } else if (pixel && !at) {
            // a lower layer of the same entity has the pixel: the entity counts as a pixel hit
            seen.set(s.uid, true);
            found.find((f) => f.item === s.uid)!.pixel = true;
        }
    };
    const ok = new Map<number, boolean>();
    for (let i = layers.length - 1; i >= 0; i--) {
        const s = layers[i]!;
        if (accept) {
            let v = ok.get(s.uid);
            if (v === undefined) ok.set(s.uid, (v = accept(s.uid)));
            if (!v) continue;
        }
        if (s.color && (s.color[3] ?? 1) === 0) continue;
        const [, , , fw, fh] = scene.frames[s.frame]!;
        const t = texelAt(s, fw, fh, x, y);
        if (!t) continue;
        add(s, !opaque || opaque(s.frame, t[0], t[1]));
    }
    // an entity listed by box first may have a pixel hit later; order follows its first (topmost) layer
    return pixelsFirst(found);
}

/** Every decal at a point, topmost first: pixel hits, then box hits. */
export function decalsAt(scene: Scene, x: number, y: number, opaque?: OpaqueTest): Array<{ grid: number; id: string; proto: string }> {
    const list = scene.decals.query(x, y, x, y).sort((a, b) => a.z - b.z || a.seq - b.seq);
    const found: Array<{ item: { grid: number; id: string; proto: string }; pixel: boolean }> = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i]!;
        if (d.color && (d.color[3] ?? 1) === 0) continue;
        const [, , , fw, fh] = scene.frames[d.frame]!;
        const t = texelAt({ ...d, scale: null } as unknown as SpriteLayer, fw, fh, x, y);
        if (t) found.push({ item: { grid: d.grid, id: d.id, proto: d.proto }, pixel: !opaque || opaque(d.frame, t[0], t[1]) });
    }
    return pixelsFirst(found);
}

/** Everything of the wanted kinds under a world point: entities, then decals, then the tile. */
export function stackAt(scene: Scene, view: PickView, x: number, y: number, opts: StackOptions = {}): StackItem[] {
    const kinds = opts.kinds ?? (["entity", "decal", "tile"] as const);
    const out: StackItem[] = [];
    if (kinds.includes("entity")) {
        for (const uid of entitiesAt(scene, view, x, y, opts.opaque, opts.accept)) out.push({ kind: "entity", uid, proto: scene.entities.get(uid)?.[0] ?? "" });
    }
    if (kinds.includes("decal") && (view.decalsShown?.() ?? true)) {
        for (const d of decalsAt(scene, x, y, opts.opaque)) out.push({ kind: "decal", ...d });
    }
    if (kinds.includes("tile") && (view.tilesShown?.() ?? true)) {
        const grid = scene.gridAt(x, y);
        if (grid !== null) {
            const [lx, ly] = scene.toLocal(grid, x, y);
            const tx = Math.floor(lx), ty = Math.floor(ly);
            const id = scene.tileAt(grid, tx, ty);
            if (id !== null) out.push({ kind: "tile", grid, x: tx, y: ty, id });
        }
    }
    return out;
}

/** Whether two items are the same thing. */
export function sameItem(a: StackItem, b: StackItem): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "entity") return a.uid === (b as typeof a).uid;
    if (a.kind === "decal") return a.grid === (b as typeof a).grid && a.id === (b as typeof a).id;
    const t = b as typeof a;
    return a.grid === t.grid && a.x === t.x && a.y === t.y;
}

/** Whether an item is exactly what a selection holds (and nothing else). */
export function isOnlySelected(item: StackItem, sel: Selection): boolean {
    if (sel.size !== 1) return false;
    if (item.kind === "entity") return sel.entities.has(item.uid);
    if (item.kind === "decal") return sel.hasDecal(item.grid, item.id);
    return sel.hasTile(item.grid, item.x, item.y);
}

/** Index of the item a repeated click selects: the one after the single selected item, else the first. */
export function nextIndex(items: readonly StackItem[], sel: Selection): number {
    const at = items.findIndex((i) => isOnlySelected(i, sel));
    return at < 0 ? 0 : (at + 1) % items.length;
}

/** The selection a pick of one item makes (to combine with the current one). */
export function pickOf(item: StackItem, into: Selection): Selection {
    if (item.kind === "entity") into.addEntity(item.uid);
    else if (item.kind === "decal") into.addDecal(item.grid, item.id);
    else into.addTile(item.grid, item.x, item.y);
    return into;
}


/** Remembers where the last left click of the Select mode was, so a click at the same spot cycles. */
export class ClickCycle {
    private at: [number, number] | null = null;

    constructor(private readonly radius = 3) {}

    /** Whether a click at a screen point repeats the last one (same spot, nothing else clicked since). */
    repeats(x: number, y: number): boolean {
        return !!this.at && Math.hypot(x - this.at[0], y - this.at[1]) <= this.radius;
    }

    /** Notes a click at a screen point. */
    mark(x: number, y: number): void {
        this.at = [x, y];
    }

    /** Forgets the last click (anything else was clicked). */
    reset(): void {
        this.at = null;
    }
}

/** What the menu and the status line show about an item. */
export interface ItemInfo {
    name: string;
    id: string;
    tag: string;
    icon: Frame | null;
}

export function describe(item: StackItem, pack: Pack): ItemInfo {
    if (item.kind === "entity") {
        const def = pack.prototypes.entities[item.proto];
        return { name: def?.name || item.proto || translate("uid {{1}}", { 1: item.uid }), id: translate("{{1}} · uid {{2}}", { 1: item.proto, 2: item.uid }), tag: "entity", icon: entityIconFrame(pack, item.proto) };
    }
    if (item.kind === "decal") return { name: item.proto, id: item.id, tag: "decal", icon: decalIconFrame(pack, item.proto) };
    return { name: pack.prototypes.tiles[item.id]?.name || item.id, id: item.id, tag: "tile", icon: tileIconFrame(pack, item.id) };
}

