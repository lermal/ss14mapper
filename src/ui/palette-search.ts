// Palette logic without DOM: entry lists of a pack (entities, tiles, decals), search with ranking, icon resolution.
import type { Frame, Pack } from "../pack/loader";

export type EntryKind = "entity" | "tile" | "decal";

/** Every kind of palette entry, in the order of the palette tabs. */
export const ENTRY_KINDS: readonly EntryKind[] = ["entity", "tile", "decal"];

export interface PaletteEntry {
    kind: EntryKind;
    id: string;
    name: string;
    suffix: string;
    /** Lower-case copies used by the search. */
    lid: string;
    lname: string;
    hay: string;
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function entry(kind: EntryKind, id: string, name: string, suffix: string): PaletteEntry {
    const lid = id.toLowerCase();
    const lname = name.toLowerCase();
    return { kind, id, name, suffix, lid, lname, hay: `${lname}\n${lid}\n${suffix.toLowerCase()}` };
}

const byName = (a: PaletteEntry, b: PaletteEntry) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Visible entity prototypes of a build, alphabetical by name (hidden ones are left out as in the spawn menu). */
export function entityEntries(pack: Pack): PaletteEntry[] {
    const out: PaletteEntry[] = [];
    for (const [id, p] of Object.entries(pack.prototypes.entities)) {
        if (p.hidden) continue;
        out.push(entry("entity", id, p.name || id, p.suffix ?? ""));
    }
    return out.sort(byName);
}

/** Paintable tiles, alphabetical by name; "Space" is the eraser's job. */
export function tileEntries(pack: Pack): PaletteEntry[] {
    const out: PaletteEntry[] = [];
    for (const [id, t] of Object.entries(pack.prototypes.tiles)) {
        if (id === "Space") continue;
        out.push(entry("tile", id, t.name || id, ""));
    }
    return out.sort(byName);
}

/** Decal prototypes of the decal placer, alphabetical by id (those with `showMenu: false` are left out). */
export function decalEntries(pack: Pack): PaletteEntry[] {
    const out: PaletteEntry[] = [];
    for (const [id, d] of Object.entries(pack.prototypes.decals)) {
        if (d.hidden || !d.sprite) continue;
        out.push(entry("decal", id, id, ""));
    }
    return out.sort(byName);
}

/**
 * Entries matching every word of the query (in name, id or suffix), best first:
 * exact id, then id/name prefix, then the rest; the order of `entries` is kept within a rank.
 */
export function search(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return entries.slice();
    const words = q.split(/\s+/);
    const joined = words.join("");
    const ranked: [PaletteEntry[], PaletteEntry[], PaletteEntry[]] = [[], [], []];
    for (const e of entries) {
        let ok = true;
        for (const w of words) {
            if (!e.hay.includes(w)) {
                ok = false;
                break;
            }
        }
        if (!ok) continue;
        if (e.lid === joined) ranked[0].push(e);
        else if (e.lid.startsWith(joined) || e.lname.startsWith(q)) ranked[1].push(e);
        else ranked[2].push(e);
    }
    return ranked[0].concat(ranked[1], ranked[2]);
}

/** Texture path as the renderer normalises it: relative to Textures. */
const texPath = (ref: unknown) => String(ref).replace(/^\/+/, "").replace(/^Textures\//, "");

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Frame of the icon of an entity prototype (Icon component, else its sprite), direction south, or null. */
export function entityIconFrame(pack: Pack, id: string): Frame | null {
    const comps = pack.prototypes.entities[id]?.components;
    if (!comps) return null;
    const rsiState = (rsi: unknown, state: unknown) => {
        const r = str(rsi);
        const s = str(state);
        return r && s ? pack.rsiFrame(texPath(r), s, 0) : null;
    };
    const icon = comps.Icon as { sprite?: unknown; state?: unknown } | undefined;
    if (icon) {
        const f = rsiState(icon.sprite, icon.state);
        if (f) return f;
    }
    const sprite = comps.Sprite as { sprite?: unknown; state?: unknown; texture?: unknown; layers?: unknown } | undefined;
    if (!sprite) return null;
    const layers = Array.isArray(sprite.layers) ? (sprite.layers as Array<Record<string, unknown> | null>) : [];
    // Layers hidden by default are usually overlays; try the visible ones first.
    for (const pass of [true, false]) {
        for (const l of layers) {
            if (!l || typeof l !== "object" || (l.visible !== false) !== pass) continue;
            const f = l.texture ? pack.texture(texPath(l.texture)) : rsiState(l.sprite ?? sprite.sprite, l.state);
            if (f) return f;
        }
    }
    const base = rsiState(sprite.sprite, sprite.state);
    if (base) return base;
    return sprite.texture ? pack.texture(texPath(sprite.texture)) : null;
}

/** Frame of the first variant of a tile, or null. */
export function tileIconFrame(pack: Pack, id: string): Frame | null {
    const sprite = pack.prototypes.tiles[id]?.sprite;
    return sprite ? pack.texture(texPath(sprite), 0) : null;
}

/** Frame of a decal prototype's sprite, or null. */
export function decalIconFrame(pack: Pack, id: string): Frame | null {
    const sprite = pack.prototypes.decals[id]?.sprite;
    if (!sprite) return null;
    return "rsi" in sprite ? pack.rsiFrame(texPath(sprite.rsi), sprite.state, 0) : pack.texture(texPath(sprite.texture));
}

/** Frame of the icon of any palette entry, or null. */
export function entryIconFrame(pack: Pack, kind: EntryKind, id: string): Frame | null {
    return kind === "entity" ? entityIconFrame(pack, id) : kind === "tile" ? tileIconFrame(pack, id) : decalIconFrame(pack, id);
}
