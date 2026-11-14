// Copying a selection and pasting it, into the same map or another one (no DOM, no scene: works on a
// `MapDocument`, so command-line tools can paste too).
//
// The clipboard is JSON with a format name and version, written to the system clipboard as text so it goes
// between tabs, maps and builds. Positions are relative to an anchor in the frame of the copied grid; the
// anchor lies on the tile lattice when tiles or anchored entities were copied, so they land on tiles again.
// Copied entities keep their map component overrides (YAML text) and everything parented to them (container
// contents included). Pasting gives new uids; references between copied entities are renamed to the new
// uids, references to entities that were not copied are dropped.
import type { DecalProps, NewDecal } from "../map/decals";
import type { MapDocument, TileEdit } from "../map/document";
import { entryText, parseDocument, type YEntry, type YItem, type YMap, type YNode } from "../map/yaml";
import { turnAngle, turnPoint, turnTileRotation } from "./group";
import { cellKey } from "./selection";
import type { Point } from "./shapes";
import { solidCells } from "./space-decals";

export const CLIP_FORMAT = "ss14mapper.clipboard";
export const CLIP_VERSION = 1;

export interface ClipComponent {
    type: string;
    /** Its fields as YAML, as `MapDocument.components` gives them. */
    text: string;
}

export interface ClipEntity {
    /** Uid in the copied map (references inside the copy name it). */
    uid: number;
    proto: string;
    /** Copied roots: position from the anchor and rotation, in the copied frame; children: their transform in their parent. */
    x: number;
    y: number;
    rot: number;
    /** Transform fields other than pos, rot and parent, as YAML ("" for none). */
    transform: string;
    components: ClipComponent[];
    children: ClipEntity[];
}

export interface ClipTile {
    /** Tile centre from the anchor. */
    x: number;
    y: number;
    name: string;
    variant: number;
    rot: number;
}

export interface ClipDecal extends DecalProps {
    /** Decal centre from the anchor, and its size in tiles (it turns around its centre). */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface Clip {
    format: typeof CLIP_FORMAT;
    version: typeof CLIP_VERSION;
    /** The anchor's place on the tile lattice: a tile corner ("whole"), a tile centre ("half"), or anywhere (null). */
    lattice: "whole" | "half" | null;
    entities: ClipEntity[];
    tiles: ClipTile[];
    decals: ClipDecal[];
}

/** A copied root entity: where it is in the copied frame (relative to the anchor), and its rotation there. */
export interface CopyRoot {
    uid: number;
    x: number;
    y: number;
    rot: number;
}

/** What to copy, already in the copied frame and relative to the anchor. */
export interface CopyParts {
    roots: CopyRoot[];
    tiles: ClipTile[];
    decals: ClipDecal[];
    lattice: Clip["lattice"];
}

/** Transform fields that pasting writes again. */
const PLACED = new Set(["pos", "rot", "parent"]);

/** Fields of a component's YAML text, read with the document's own reader. */
function fieldsOf(text: string): YEntry[] {
    if (!text.trim() || text.trim() === "{}") return [];
    return parseDocument(text + "\n").root.entries;
}

const textOf = (entries: YEntry[]) => entries.map((e) => entryText(e, 0)).join("\n");

/** An entity with its component overrides and everything parented to it. */
function captureEntity(doc: MapDocument, uid: number, x: number, y: number, rot: number, children: Map<number, number[]>): ClipEntity {
    const components: ClipComponent[] = [];
    let transform = "";
    for (const c of doc.components(uid)) {
        if (c.type === "Transform") transform = textOf(fieldsOf(c.text).filter((e) => !PLACED.has(e.key.value)));
        else components.push({ type: c.type, text: c.text });
    }
    return {
        uid,
        proto: doc.proto(uid) ?? "",
        x,
        y,
        rot,
        transform,
        components,
        children: (children.get(uid) ?? []).map((c) => {
            const t = doc.transform(c);
            return captureEntity(doc, c, t.x, t.y, t.rotation, children);
        }),
    };
}

/** The clipboard for parts of a map. */
export function copyParts(doc: MapDocument, parts: CopyParts): Clip {
    // direct children of everything copied
    const children = new Map<number, number[]>();
    for (const r of parts.roots) {
        for (const d of doc.descendants(r.uid)) {
            const p = doc.transform(d).parent;
            if (p === null) continue;
            const list = children.get(p);
            if (list) list.push(d);
            else children.set(p, [d]);
        }
    }
    return {
        format: CLIP_FORMAT,
        version: CLIP_VERSION,
        lattice: parts.lattice,
        entities: parts.roots.map((r) => captureEntity(doc, r.uid, r.x, r.y, r.rot, children)),
        tiles: parts.tiles,
        decals: parts.decals,
    };
}

/** The clipboard as text. */
export function clipText(clip: Clip): string {
    return JSON.stringify(clip);
}

/** A clipboard read back from text, or null when the text is not one (or of a newer version). */
export function readClip(text: string | null | undefined): Clip | null {
    if (!text) return null;
    try {
        const data = JSON.parse(text) as Partial<Clip>;
        if (data?.format !== CLIP_FORMAT || data.version !== CLIP_VERSION) return null;
        if (!Array.isArray(data.entities) || !Array.isArray(data.tiles) || !Array.isArray(data.decals)) return null;
        return data as Clip;
    } catch {
        return null;
    }
}

/** How many entities, tiles and decals a clipboard holds (entities with everything inside them). */
export function clipCounts(clip: Clip): { entities: number; tiles: number; decals: number } {
    const count = (list: ClipEntity[]): number => list.reduce((n, e) => n + 1 + count(e.children), 0);
    return { entities: count(clip.entities), tiles: clip.tiles.length, decals: clip.decals.length };
}

// ---------------------------------------------------------------------------------------------
// References

/** Fields whose values (one or a list) name entities. */
const ENTITY_FIELDS = new Set(["ent", "ents", "devices", "deviceLists", "links", "dockedWith", "entity", "entities", "owner", "target", "linkedEntity"]);
const ENTITY_FIELD = /(Uid|Entity|Entities)$/;
/** Fields whose mapping keys name entities (`linkedPorts: {uid: [...]}`). */
const ENTITY_KEYED = new Set(["linkedPorts", "storedItems"]);

const isUid = (v: string) => /^\d+$/.test(v);

/**
 * A component's YAML text with entity references renamed by `ids` (old uid → new uid); references to entities
 * not in `ids` are dropped (from lists and keyed mappings) or become null. Returns the text and how many were
 * dropped. Only fields known to hold entities are looked at, so numbers elsewhere are left alone.
 */
export function remapReferences(text: string, ids: ReadonlyMap<number, number>): { text: string; dropped: number } {
    const entries = fieldsOf(text);
    let dropped = 0;
    // returns whether the node changed
    const visit = (node: YNode, refs: boolean, keyed: boolean): boolean => {
        if (node.kind === "scalar") {
            if (!refs || !isUid(node.value)) return false;
            const to = ids.get(Number(node.value));
            if (to === undefined) {
                dropped++;
                node.value = "null";
            } else node.value = String(to);
            return true;
        }
        let changed = false;
        if (node.kind === "seq") {
            const keep: YItem[] = [];
            for (const item of node.items) {
                if (refs && item.value.kind === "scalar" && isUid(item.value.value) && !ids.has(Number(item.value.value))) {
                    dropped++;
                    changed = true;
                    continue;
                }
                if (visit(item.value, refs, false)) {
                    delete item.src;
                    changed = true;
                }
                keep.push(item);
            }
            node.items = keep;
            return changed;
        }
        return visitMap(node, refs, keyed) || changed;
    };
    const visitMap = (node: YMap, refs: boolean, keyed: boolean): boolean => {
        let changed = false;
        const keep: YEntry[] = [];
        for (const e of node.entries) {
            if (keyed && isUid(e.key.value)) {
                const to = ids.get(Number(e.key.value));
                if (to === undefined) {
                    dropped++;
                    changed = true;
                    continue;
                }
                e.key = { ...e.key, value: String(to), raw: undefined, rawValue: undefined };
                delete e.src;
                changed = true;
            }
            const key = e.key.value;
            if (visit(e.value, refs || ENTITY_FIELDS.has(key) || ENTITY_FIELD.test(key), ENTITY_KEYED.has(key))) {
                delete e.src;
                changed = true;
            }
            keep.push(e);
        }
        node.entries = keep;
        return changed;
    };
    const root: YMap = { kind: "map", entries };
    if (!visitMap(root, false, false)) return { text, dropped };
    return { text: textOf(root.entries), dropped };
}

// ---------------------------------------------------------------------------------------------
// Pasting

/** What the target build has (missing prototypes and tiles are skipped). */
export interface PasteKnown {
    entity(proto: string): boolean;
    tile(name: string): boolean;
    decal(proto: string): boolean;
}

export interface PasteTarget {
    grid: number;
    /** Where the anchor goes, in the grid's coordinates. */
    anchor: Point;
    /** Quarter turns (counter-clockwise) around the anchor. */
    turns: number;
}

export interface PasteResult {
    /** New uids of the pasted roots, and of everything pasted. */
    roots: number[];
    entities: number[];
    tiles: Array<[number, number]>;
    decals: string[];
    /** Prototypes and tiles the target build lacks (skipped), and references to entities that were not copied (dropped). */
    missing: string[];
    dropped: number;
    /** Decals not pasted because they would land on space. */
    onSpace: number;
    /** Root entities (with their children) not pasted because they would land on space. */
    entitiesOnSpace: number;
}

const ALL_KNOWN: PasteKnown = { entity: () => true, tile: () => true, decal: () => true };

/** A copied position placed on the target: turned around the anchor, then moved to it. */
export function placeAt(target: PasteTarget, [x, y]: Point): Point {
    const [tx, ty] = turnPoint([x, y], [0, 0], target.turns);
    return [target.anchor[0] + tx, target.anchor[1] + ty];
}

/** Where tiles and entities of a clipboard land for a target (tile cells, root positions, decal centres). */
export function pastePlan(clip: Clip, target: PasteTarget) {
    return {
        tiles: clip.tiles.map((t) => {
            const [x, y] = placeAt(target, [t.x, t.y]);
            return { x: Math.floor(x), y: Math.floor(y), tile: t };
        }),
        entities: clip.entities.map((e) => ({ at: placeAt(target, [e.x, e.y]), rot: turnAngle(e.rot, target.turns), entity: e })),
        decals: clip.decals.map((d) => ({ at: placeAt(target, [d.x, d.y]), angle: turnAngle(d.angle, target.turns), decal: d })),
    };
}

/** Pastes a clipboard onto a grid as one edit (one undo step). */
export function pasteClip(doc: MapDocument, clip: Clip, target: PasteTarget, known: PasteKnown = ALL_KNOWN): PasteResult {
    const plan = pastePlan(clip, target);
    const result: PasteResult = { roots: [], entities: [], tiles: [], decals: [], missing: [], dropped: 0, onSpace: 0, entitiesOnSpace: 0 };
    const missing = new Set<string>();
    const ids = new Map<number, number>();
    const made: Array<{ uid: number; entity: ClipEntity }> = [];
    const { grid, turns } = target;
    doc.batch("Paste", () => {
        const edits: TileEdit[] = [];
        for (const { x, y, tile } of plan.tiles) {
            if (!known.tile(tile.name)) {
                missing.add(`tile ${tile.name}`);
                continue;
            }
            edits.push({ x, y, name: tile.name, variant: tile.variant, rotationMirroring: doc.format >= 7 ? turnTileRotation(tile.rot, turns) : 0 });
            result.tiles.push([x, y]);
        }
        if (edits.length) doc.setTiles(grid, edits);

        const place = (e: ClipEntity, parent: number, x: number, y: number, rot: number): number | null => {
            if (!known.entity(e.proto)) {
                missing.add(e.proto);
                return null;
            }
            const uid = doc.addEntity(e.proto, parent, x, y, rot, e.transform);
            ids.set(e.uid, uid);
            made.push({ uid, entity: e });
            result.entities.push(uid);
            for (const c of e.children) place(c, uid, c.x, c.y, c.rot);
            return uid;
        };
        // nothing is placed over space (as in single placement), as seen after the tiles above
        const floor = plan.entities.length ? solidCells(doc, grid) : null;
        for (const { at, rot, entity } of plan.entities) {
            if (!known.entity(entity.proto)) {
                missing.add(entity.proto);
                continue;
            }
            if (!floor!.has(cellKey(Math.floor(at[0]), Math.floor(at[1])))) {
                result.entitiesOnSpace++;
                continue;
            }
            const uid = place(entity, grid, at[0], at[1], rot);
            if (uid !== null) result.roots.push(uid);
        }
        // overrides once every new uid is known, so references inside the copy point at the copies
        for (const { uid, entity } of made) {
            for (const c of entity.components) {
                const { text, dropped } = remapReferences(c.text, ids);
                result.dropped += dropped;
                doc.setComponent(uid, c.type, text);
            }
        }

        const decals: NewDecal[] = [];
        // decals on space are not taken (DecalSystem.TryAddDecal), as seen after the tiles above
        const solid = plan.decals.length ? solidCells(doc, grid) : null;
        for (const { at, angle, decal } of plan.decals) {
            if (!known.decal(decal.proto)) {
                missing.add(`decal ${decal.proto}`);
                continue;
            }
            const { proto, color, zIndex, cleanable, w, h } = decal;
            const x = at[0] - w / 2, y = at[1] - h / 2;
            if (!solid!.has(cellKey(Math.floor(x), Math.floor(y)))) {
                result.onSpace++;
                continue;
            }
            decals.push({ proto, x, y, props: { color, angle, zIndex, cleanable } });
        }
        if (decals.length) result.decals.push(...doc.addDecals(grid, decals));
    });
    result.missing = [...missing].sort();
    return result;
}

/** Where the anchor of a clipboard goes for a point on a grid: the nearest point of its lattice. */
export function snapAnchor(clip: Clip, [x, y]: Point): Point {
    if (clip.lattice === "whole") return [Math.round(x), Math.round(y)];
    if (clip.lattice === "half") return [Math.floor(x) + 0.5, Math.floor(y) + 0.5];
    return [Math.round(x * 32) / 32, Math.round(y * 32) / 32];
}
