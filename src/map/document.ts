// A map file with the edits a mapper makes: entities placed, moved, rotated and deleted, tiles painted.
// Edits change only the YAML entries they touch, in the places and style the game's map saver uses,
// so the saved file differs from the original only where the map was edited.

import {
    chunkOf,
    compareProps,
    decalId,
    normalizeColor,
    NODE_FIELDS_NEW,
    NODE_FIELDS_OLD,
    parseDecalId,
    parsePosition,
    readProps,
    type Decal,
    type DecalProps,
    type NewDecal,
} from "./decals";
import { ContainerEdits, type ContainerInfo, type ContainerPack, type ContainerPlace, type InsertOptions, type MapPlace, type StorageGeometry, type StorageLocation } from "./containers";
import { DeviceEdits, type Check, type DevicePack, type SignalLink } from "./devices";
import { Journal, type Change } from "./journal";
import { decodeChunk, encodeChunk, EMPTY_TILE, locate, CHUNK_SIZE, type Tile } from "./tiles";
import {
    entryOf,
    entryText,
    get,
    itemText,
    map,
    parseDocument,
    scalar,
    seq,
    serializeDocument,
    toPlain,
    type YDocument,
    type YEntry,
    type YItem,
    type YMap,
    type YNode,
    type YScalar,
    type YSeq,
} from "./yaml";

/** Order of entity groups and tile names in files saved by the game (case-insensitive). */
const nameOrder = new Intl.Collator("en").compare;

/** Path from the root to an entity's item; every element must be marked changed when the entity is. */
interface EntityRecord {
    uid: number;
    proto: string;
    group: YItem;
    groupEntities: YEntry;
    item: YItem;
}

export interface Transform {
    x: number;
    y: number;
    rotation: number;
    parent: number | null;
}

/** A tile to paint with `setTiles`. */
export interface TileEdit {
    x: number;
    y: number;
    /** Tile name; "Space" erases. */
    name: string;
    variant?: number;
    rotationMirroring?: number;
}

/** A component override of an entity as `MapDocument.components` lists it. */
export interface ComponentOverride {
    type: string;
    /** Its fields as YAML, unindented, without the `type:` line ("" when it has none). */
    text: string;
    /** Its fields as plain data. */
    data: Record<string, unknown>;
}

/** Where a grid keeps decals: its `DecalGrid.chunkCollection`, or a chunk entity's `DecalChunk.decals`. */
interface DecalStore {
    /** The grid, or the chunk entity. */
    uid: number;
    /** Chunk of a chunk entity. */
    chunk?: [number, number];
    component: YItem;
    entry: YEntry;
}

const CHUNK_ENTITY = "ChunkEntity";
/** Indentation of components in an entity ("    - type: X") and of their fields. */
const COMPONENT_INDENT = 4;
const FIELD_INDENT = COMPONENT_INDENT + 2;

const asMap = (node: YNode | undefined): YMap | undefined => (node?.kind === "map" ? node : undefined);
const asSeq = (node: YNode | undefined): YSeq | undefined => (node?.kind === "seq" ? node : undefined);
const text = (node: YNode | undefined): string | undefined => (node?.kind === "scalar" ? node.value : undefined);

const sameChunk = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

function nodeProps(node: YItem): DecalProps {
    const fields = asMap(get(node.value, "node"))?.entries ?? [];
    return readProps(new Map(fields.map((e) => [e.key.value, text(e.value) ?? ""])));
}

/**
 * Decal properties checked and normalised as the game stores them. Decals the map already has may have no
 * prototype (`Decal.Id` defaults to "" and an empty id is not written); new ones need one.
 */
function decalProps(p: DecalProps, existing = false): DecalProps {
    if (!p.proto && !existing) throw new Error("A decal needs a prototype");
    if (!Number.isFinite(p.angle)) throw new Error(`Not an angle: ${p.angle}`);
    if (!Number.isInteger(p.zIndex)) throw new Error(`Not a z index: ${p.zIndex}`);
    return { proto: p.proto, color: normalizeColor(p.color), angle: p.angle, zIndex: p.zIndex, cleanable: !!p.cleanable };
}

function dedent(source: string, n: number): string {
    return source
        .split("\n")
        .map((l) => l.slice(Math.min(n, l.length - l.trimStart().length)))
        .join("\n");
}

/**
 * Fields of a component from YAML text (a mapping at any indentation), checked: what the game's YAML reader would
 * reject is an error, and so is a `type:` naming another component (it is left out of the result).
 */
function parseFields(source: string, type: string): YEntry[] {
    let lines = source.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
    const tab = lines.findIndex((l) => /^\s*\t/.test(l));
    if (tab !== -1) throw new Error(`Line ${tab + 1}: tabs cannot indent YAML`);
    const indent = Math.min(...lines.filter((l) => l.trim() !== "" && !l.trim().startsWith("#")).map((l) => l.length - l.trimStart().length));
    if (Number.isFinite(indent)) lines = lines.map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)));
    const body = lines.join("\n");
    if (body.trim() === "" || body.trim() === "{}") return [];
    let root: YMap;
    try {
        root = parseDocument(body + "\n").root;
    } catch (e) {
        throw new Error((e as Error).message.replace(/^Unsupported YAML/, "Invalid YAML"));
    }
    if (!root.entries.length) throw new Error("Expected component fields (key: value)");
    checkNode(root, "");
    const typeEntry = entryOf(root, "type");
    if (typeEntry && text(typeEntry.value) !== type) throw new Error(`type: ${text(typeEntry.value) ?? "?"} does not match ${type}`);
    return root.entries.filter((e) => e !== typeEntry);
}

function checkNode(node: YNode, path: string): void {
    const where = path || "the component";
    if (node.kind === "map") {
        const keys = new Set<string>();
        for (const e of node.entries) {
            if (keys.has(e.key.value)) throw new Error(`Duplicate key "${e.key.value}" in ${where}`);
            keys.add(e.key.value);
            checkNode(e.value, path ? `${path}.${e.key.value}` : e.key.value);
        }
    } else if (node.kind === "seq") {
        node.items.forEach((i, n) => checkNode(i.value, `${where}[${n}]`));
    } else {
        const raw = node.raw ?? node.value;
        if (node.style === "single" || node.style === "double") {
            const q = node.style === "single" ? "'" : '"';
            if (raw.length < 2 || !raw.endsWith(q)) throw new Error(`Unclosed quote in ${where}`);
        } else if (node.style === "flow") {
            let depth = 0;
            let quote: string | null = null;
            for (const c of raw) {
                if (quote) quote = c === quote ? null : quote;
                else if (c === "'" || c === '"') quote = c;
                else if (c === "{" || c === "[") depth++;
                else if (c === "}" || c === "]") depth--;
            }
            if (depth !== 0 || quote) throw new Error(`Unbalanced brackets in ${where}`);
        } else if (node.style === "plain" && /: |:$/.test(node.value.split("\n")[0]!)) {
            throw new Error(`Unexpected ":" in ${where} (quote the value)`);
        }
    }
}

/** Float as written by .NET for Vector2 components: shortest text that reads back to the same float32. */
export function formatFloat(value: number): string {
    const f = Math.fround(value);
    if (Object.is(f, -0) || f === 0) return "0";
    for (let p = 1; p <= 9; p++) {
        let s = Number(f.toPrecision(p));
        if (Math.fround(s) !== f) continue;
        // a float exactly halfway between two p-digit numbers is rounded to the even one, as .NET does
        const exact = Math.abs(f).toExponential(80);
        const digits = exact.slice(0, exact.indexOf("e")).replace(".", "");
        if (/^50*$/.test(digits.slice(p)) && Number(digits[p - 1]) % 2 === 0) {
            const down = Number(`${f < 0 ? "-" : ""}${digits[0]}.${digits.slice(1, p)}e${exact.slice(exact.indexOf("e") + 1)}`);
            if (Math.fround(down) === f) s = down;
        }
        return dotNetNumber(s);
    }
    return dotNetNumber(f);
}

/** Angle as written by .NET for a double (`Angle` is stored in radians). */
export function formatAngle(radians: number): string {
    return `${dotNetNumber(radians)} rad`;
}

function dotNetNumber(n: number): string {
    // .NET switches to exponents below 1E-04 (JavaScript below 1e-6) and writes 1E-05 where JavaScript writes 1e-5
    const s = n !== 0 && Math.abs(n) < 1e-4 ? n.toExponential() : String(n);
    if (!s.includes("e")) return s;
    const [m, e] = s.split("e") as [string, string];
    const exp = Number(e);
    return `${m}E${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** Rotation normalised to (-π, π] the way the editor writes it; quarter turns keep exact values. */
function normalizeAngle(radians: number): number {
    const quarter = Math.round(radians / (Math.PI / 2));
    if (Math.abs(radians - quarter * (Math.PI / 2)) < 1e-9) {
        const q = ((quarter % 4) + 4) % 4;
        return [0, Math.PI / 2, Math.PI, -Math.PI / 2][q]!;
    }
    let r = radians % (2 * Math.PI);
    if (r <= -Math.PI) r += 2 * Math.PI;
    if (r > Math.PI) r -= 2 * Math.PI;
    return r;
}

export class MapDocument {
    readonly yaml: YDocument;
    readonly journal = new Journal((entities) => this.resync(entities));
    private readonly records = new Map<number, EntityRecord>();
    /** Every entity record seen, deleted ones included, so undo and redo can put them back. */
    private readonly known = new Map<number, EntityRecord>();
    /** Records of entities whose prototype changed (an entity's item moved between groups), oldest first. */
    private readonly former = new Map<number, EntityRecord[]>();
    /** Transform parent of each entity and the children of each parent (changed by container edits). */
    private readonly parents = new Map<number, number>();
    private readonly childIndex = new Map<number, Set<number>>();
    /** See `newFieldOrder`. */
    private fieldOrder?: boolean;
    /** See `parentFirst`. */
    private transformOrder?: boolean;

    constructor(source: string) {
        this.yaml = parseDocument(source);
        this.reindex();
    }

    get format(): number {
        return Number(text(get(get(this.yaml.root, "meta"), "format")) ?? 0);
    }

    // -----------------------------------------------------------------------------------------
    // Reading

    private get entitiesEntry(): YEntry {
        const e = entryOf(this.yaml.root, "entities");
        if (!e) throw new Error("The file has no entities section");
        return e;
    }

    private get groups(): YSeq {
        const s = asSeq(this.entitiesEntry.value);
        if (!s) throw new Error("Unexpected entities section");
        return s;
    }

    private reindex(): void {
        this.records.clear();
        this.parents.clear();
        this.childIndex.clear();
        for (const group of this.groups.items) {
            const groupMap = asMap(group.value);
            const groupEntities = groupMap && entryOf(groupMap, "entities");
            const list = asSeq(groupEntities?.value);
            if (!groupMap || !groupEntities || !list) continue;
            const proto = text(get(groupMap, "proto")) ?? "";
            for (const item of list.items) {
                const uid = Number(text(get(item.value, "uid")));
                if (Number.isFinite(uid)) this.index({ uid, proto, group, groupEntities, item });
            }
        }
    }

    private index(rec: EntityRecord): void {
        this.records.set(rec.uid, rec);
        this.known.set(rec.uid, rec);
        const parent = this.transform(rec.uid).parent;
        if (parent === null) return;
        this.parents.set(rec.uid, parent);
        let set = this.childIndex.get(parent);
        if (!set) this.childIndex.set(parent, (set = new Set()));
        set.add(rec.uid);
    }

    private unindex(uid: number): void {
        this.records.delete(uid);
        const parent = this.parents.get(uid);
        if (parent === undefined) return;
        this.parents.delete(uid);
        const set = this.childIndex.get(parent);
        set?.delete(uid);
        if (set && !set.size) this.childIndex.delete(parent);
    }

    /** After undo or redo: the entities of the edit are in the file or not, depending on whether their items are. */
    private resync(entities: Iterable<number>): void {
        const groups = new Set(this.groups.items);
        const inFile = (r: EntityRecord) => groups.has(r.group) && !!asSeq(r.groupEntities.value)?.items.includes(r.item);
        for (const uid of entities) {
            let rec = this.known.get(uid);
            // after undoing or redoing a prototype change: the record in the group the item is in now
            const others = this.former.get(uid);
            if (others && rec && !inFile(rec)) rec = others.find(inFile) ?? rec;
            const present = !!rec && inFile(rec);
            // re-indexed too when its parent changed (put into or taken out of a container)
            if (present && (this.records.get(uid) !== rec || (this.parents.get(uid) ?? null) !== this.transform(uid).parent)) {
                this.unindex(uid);
                this.index(rec!);
            } else if (!present && (this.records.get(uid) === rec || others?.includes(this.records.get(uid)!))) {
                this.unindex(uid);
            }
        }
    }

    uids(): number[] {
        return [...this.records.keys()];
    }

    /** Calls `listener` with what changed after every edit, undo and redo. Returns a function that unsubscribes. */
    onChange(listener: (change: Change, label: string) => void): () => void {
        return this.journal.subscribe(listener);
    }

    /** An entity's prototype and components as plain data (see `toPlain`), or undefined when there is no such entity. */
    entityData(uid: number): { proto: string; components: unknown[] } | undefined {
        const rec = this.records.get(uid);
        if (!rec) return undefined;
        const components = get(rec.item.value, "components");
        const list = components ? toPlain(components) : [];
        return { proto: rec.proto, components: Array.isArray(list) ? list : [] };
    }

    /** Grids as the file lists them in `grids` (format 6 and 7), or entities with a MapGrid when it has no such list. */
    listedGrids(): number[] {
        const list = asSeq(get(this.yaml.root, "grids"));
        if (!list) return this.grids();
        return list.items.map((i) => Number(text(i.value))).filter((n) => Number.isFinite(n));
    }

    /** Map entities as the file lists them in `maps` (format 6 and 7), or entities with a `Map` component when it has no such list. */
    mapEntities(): number[] {
        const list = asSeq(get(this.yaml.root, "maps"));
        if (!list) return this.uids().filter((uid) => this.component(uid, "Map") !== undefined);
        return list.items.map((i) => Number(text(i.value))).filter((n) => Number.isFinite(n) && this.records.has(n));
    }

    /** Entities that carry tiles (grids). */
    grids(): number[] {
        return this.uids().filter((uid) => this.component(uid, "MapGrid") !== undefined);
    }

    proto(uid: number): string | undefined {
        return this.records.get(uid)?.proto;
    }

    private componentList(uid: number): { entry: YEntry; list: YSeq } {
        const rec = this.record(uid);
        const entry = entryOf(asMap(rec.item.value)!, "components");
        const list = asSeq(entry?.value);
        if (!entry || !list) throw new Error(`Entity ${uid} has no components`);
        return { entry, list };
    }

    private component(uid: number, type: string): YItem | undefined {
        const entity = this.records.get(uid)?.item.value;
        return asSeq(get(entity, "components"))?.items.find((c) => text(get(c.value, "type")) === type);
    }

    private record(uid: number): EntityRecord {
        const rec = this.records.get(uid);
        if (!rec) throw new Error(`No entity ${uid}`);
        return rec;
    }

    transform(uid: number): Transform {
        const t = this.component(uid, "Transform")?.value;
        const [x, y] = (text(get(t, "pos")) ?? "0,0").split(",").map(Number) as [number, number];
        const rot = text(get(t, "rot"));
        const parent = text(get(t, "parent"));
        return {
            x,
            y,
            rotation: rot ? Number(rot.replace(/ rad$/, "")) : 0,
            parent: parent === undefined || parent === "invalid" ? null : Number(parent),
        };
    }

    /** Entities whose transform parent is `uid`, recursively (contents of containers included). */
    descendants(uid: number): number[] {
        const children = this.children();
        const out: number[] = [];
        const visit = (id: number) => {
            for (const c of children.get(id) ?? []) {
                out.push(c);
                visit(c);
            }
        };
        visit(uid);
        return out;
    }

    /**
     * Entities outside `targets` whose components mention one of `targets` (device lists, links,
     * containers...). Transform parents are not counted: children are deleted with their parent.
     */
    referencesTo(targets: Iterable<number>): Map<number, number[]> {
        const wanted = new Set([...targets].map(String));
        const found = new Map<number, number[]>();
        const visit = (node: YNode, key: string | null, hits: Set<number>) => {
            if (node.kind === "scalar") {
                if (key !== "uid" && key !== "parent" && wanted.has(node.value)) hits.add(Number(node.value));
            } else if (node.kind === "map") {
                for (const e of node.entries) visit(e.value, e.key.value, hits);
            } else {
                for (const i of node.items) visit(i.value, null, hits);
            }
        };
        for (const [uid, rec] of this.records) {
            if (wanted.has(String(uid))) continue;
            const hits = new Set<number>();
            const components = get(rec.item.value, "components");
            if (components) visit(components, null, hits);
            if (hits.size) found.set(uid, [...hits]);
        }
        return found;
    }

    private children(): Map<number, Set<number>> {
        return this.childIndex;
    }

    tilemap(): Map<number, string> {
        const m = asMap(get(this.yaml.root, "tilemap"));
        return new Map((m?.entries ?? []).map((e) => [Number(e.key.value), text(e.value) ?? ""]));
    }

    /** Every non-empty tile of a grid with its grid coordinates. */
    tiles(grid: number): Array<{ x: number; y: number; tile: Tile }> {
        const mapGrid = this.component(grid, "MapGrid");
        const chunks = asMap(get(mapGrid?.value, "chunks"));
        const space = [...this.tilemap()].find(([, n]) => n === "Space")?.[0] ?? 0;
        const out: Array<{ x: number; y: number; tile: Tile }> = [];
        for (const e of chunks?.entries ?? []) {
            const [cx, cy] = (text(get(e.value, "ind")) ?? e.key.value).split(",").map(Number) as [number, number];
            const tiles = decodeChunk(text(get(e.value, "tiles")) ?? "", Number(text(get(e.value, "version")) ?? 6));
            tiles.forEach((tile, i) => {
                if (tile.id !== space) out.push({ x: cx * CHUNK_SIZE + (i % CHUNK_SIZE), y: cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE), tile });
            });
        }
        return out;
    }

    tile(grid: number, x: number, y: number): Tile {
        const chunk = this.chunk(grid, x, y);
        if (!chunk) return EMPTY_TILE;
        return decodeChunk(text(get(chunk.entry.value, "tiles"))!, chunk.version)[locate(x, y).index] ?? EMPTY_TILE;
    }

    // -----------------------------------------------------------------------------------------
    // Decals

    /** Decals of a grid, from its `DecalGrid` or from its chunk entities. */
    decals(grid: number): Decal[] {
        const out: Decal[] = [];
        if (!this.records.has(grid)) return out;
        for (const store of this.decalStores(grid)) for (const d of this.storeDecals(store)) out.push(d.decal);
        return out;
    }

    /** One decal of a grid, or undefined when there is no such decal. */
    decal(grid: number, id: string): Decal | undefined {
        return this.records.has(grid) ? this.findDecal(grid, id)?.decal : undefined;
    }

    private decalStores(grid: number): DecalStore[] {
        const decalGrid = this.component(grid, "DecalGrid");
        if (decalGrid) {
            const entry = entryOf(asMap(decalGrid.value) ?? map([]), "chunkCollection");
            return entry ? [{ uid: grid, component: decalGrid, entry }] : [];
        }
        const out: DecalStore[] = [];
        for (const c of this.chunkEntities(grid)) {
            const component = this.component(c.uid, "DecalChunk");
            const entry = component && entryOf(asMap(component.value)!, "decals");
            if (component && entry) out.push({ uid: c.uid, chunk: c.chunk, component, entry });
        }
        return out;
    }

    /** Chunk entities of a grid (`ChunkEntity` prototype, `root` is the grid). */
    private chunkEntities(grid: number): Array<{ uid: number; chunk: [number, number] }> {
        const group = this.groups.items.find((g) => text(get(g.value, "proto")) === CHUNK_ENTITY);
        const out: Array<{ uid: number; chunk: [number, number] }> = [];
        for (const item of asSeq(get(group?.value, "entities"))?.items ?? []) {
            const uid = Number(text(get(item.value, "uid")));
            if (!this.records.has(uid)) continue;
            const info = this.component(uid, "ChunkEntity")?.value;
            if (Number(text(get(info, "root"))) !== grid) continue;
            const [cx, cy] = (text(get(info, "chunk")) ?? "0,0").split(",").map(Number) as [number, number];
            out.push({ uid, chunk: [cx, cy] });
        }
        return out;
    }

    private *storeDecals(store: DecalStore): Generator<{ decal: Decal; node: YItem; entry: YEntry }> {
        for (const node of asSeq(get(store.entry.value, "nodes"))?.items ?? []) {
            const props = nodeProps(node);
            for (const entry of asMap(get(node.value, "decals"))?.entries ?? []) {
                const [x, y] = parsePosition(text(entry.value) ?? "0,0");
                yield { decal: { id: decalId(Number(entry.key.value), store.chunk), x, y, ...props }, node, entry };
            }
        }
    }

    private findDecal(grid: number, id: string): { store: DecalStore; node: YItem; entry: YEntry; decal: Decal } | undefined {
        const { chunk, local } = parseDecalId(id);
        for (const store of this.decalStores(grid)) {
            if (chunk ? !store.chunk || store.chunk[0] !== chunk[0] || store.chunk[1] !== chunk[1] : store.chunk) continue;
            for (const d of this.storeDecals(store)) if (Number(d.entry.key.value) === local) return { store, ...d };
        }
        return undefined;
    }

    // -----------------------------------------------------------------------------------------
    // Component overrides

    /**
     * The map's component overrides of an entity, in file order: each as YAML text of its fields (as written in
     * the file, without the `type:` line, unindented) and as plain data (see `toPlain`).
     */
    components(uid: number): ComponentOverride[] {
        return this.componentList(uid).list.items.map((item) => this.describeComponent(item));
    }

    /** A single override, without converting or formatting the other components of the entity. */
    componentOverride(uid: number, type: string): ComponentOverride | undefined {
        const item = this.component(uid, type);
        return item && this.describeComponent(item);
    }

    /** A saved component field with its original YAML tags. */
    componentField(uid: number, type: string, field: string): YNode | undefined {
        return get(this.component(uid, type)?.value, field);
    }

    private describeComponent(item: YItem): ComponentOverride {
        const fields = asMap(item.value)?.entries.filter((e) => e.key.value !== "type") ?? [];
        return {
            type: text(get(item.value, "type")) ?? "",
            text: dedent(fields.map((e) => entryText(e, FIELD_INDENT)).join("\n"), FIELD_INDENT),
            data: Object.fromEntries(fields.map((e) => [e.key.value, toPlain(e.value)])),
        };
    }

    // -----------------------------------------------------------------------------------------
    // Edits

    /** Marks entries and items as changed, recorded so undo restores their source text. */
    private touch(...targets: Array<YEntry | YItem>): void {
        for (const t of targets) if (t.src !== undefined) this.journal.set(t, "src", undefined);
    }

    private touchEntity(rec: EntityRecord): void {
        this.touch(this.entitiesEntry, rec.group, rec.groupEntities, rec.item);
    }

    private setScalar(owner: YEntry, value: string): void {
        const node = owner.value as YScalar;
        if (node.value === value) return;
        this.journal.set(node, "value", value);
        this.touch(owner);
    }

    private setTransformField(uid: number, key: "pos" | "rot", value: string | null): void {
        const rec = this.record(uid);
        const { entry: componentsEntry } = this.componentList(uid);
        const item = this.component(uid, "Transform");
        if (!item) throw new Error(`Entity ${uid} has no transform`);
        const fields = asMap(item.value)!;
        const existing = entryOf(fields, key);

        if (value === null) {
            if (!existing) return;
            this.journal.splice(fields, "entries", fields.entries.indexOf(existing), 1);
        } else if (existing) {
            if ((existing.value as YScalar).value === value) return;
            this.setScalar(existing, value);
        } else {
            // the game writes "rot" before "pos"
            const at = key === "rot" ? Math.max(0, fields.entries.findIndex((e) => e.key.value === "pos")) : fields.entries.length;
            this.journal.splice(fields, "entries", at, 0, { key: scalar(key), value: scalar(value) });
        }
        this.touch(item, componentsEntry);
        this.touchEntity(rec);
        this.journal.note([uid]);
    }

    moveEntity(uid: number, x: number, y: number): void {
        this.journal.edit("Move", () => this.setTransformField(uid, "pos", `${formatFloat(x)},${formatFloat(y)}`));
    }

    rotateEntity(uid: number, radians: number): void {
        const r = normalizeAngle(radians);
        this.journal.edit("Rotate", () => this.setTransformField(uid, "rot", r === 0 ? null : formatAngle(r)));
    }

    /**
     * Places a new entity of `proto` and returns its uid. Only the transform is written (in the field order of
     * the map's engine); the rest comes from the prototype. `transformExtra`: more Transform fields as YAML text
     * (`anchored: False`...), written after them; its pos, rot and parent are ignored.
     */
    addEntity(proto: string, parent: number, x: number, y: number, rotation = 0, transformExtra = ""): number {
        const extra = transformExtra.trim() ? this.fieldEntries("Transform", parseFields(transformExtra, "Transform").filter((e) => !["pos", "rot", "parent"].includes(e.key.value))) : [];
        return this.journal.edit("Place", () => {
            const uid = this.nextUid();
            const r = normalizeAngle(rotation);
            const rot: Array<[string, YNode]> = r !== 0 ? [["rot", scalar(formatAngle(r))]] : [];
            const pos: [string, YNode] = ["pos", scalar(`${formatFloat(x)},${formatFloat(y)}`)];
            const par: [string, YNode] = ["parent", scalar(String(parent))];
            const fields: Array<[string, YNode]> = [["type", scalar("Transform")], ...(this.parentFirst ? [par, ...rot, pos] : [...rot, pos, par])];
            const transform = map(fields);
            transform.entries.push(...extra);
            this.insertEntity(proto, uid, { value: map([["uid", scalar(String(uid))], ["components", seq([transform])]]) });
            return uid;
        });
    }

    /** A component item made of fields as written (re-indented to sit in an entity), and its fields. */
    private componentItem(type: string, fields: YEntry[]): YItem {
        const lines = [`${" ".repeat(COMPONENT_INDENT)}- type: ${type}`];
        for (const e of fields) lines.push(...(e.src ?? entryText(e, 0)).split("\n").map((l) => (l === "" ? l : " ".repeat(FIELD_INDENT) + l)));
        return asSeq(get(parseDocument(`c:\n${lines.join("\n")}\n`).root, "c"))!.items[0]!;
    }

    private fieldEntries(type: string, fields: YEntry[]): YEntry[] {
        return fields.length ? asMap(this.componentItem(type, fields).value)!.entries.slice(1) : [];
    }

    /** Whether the map's engine writes Transform as `parent, rot, pos` (newer) rather than `rot, pos, parent`. */
    private get parentFirst(): boolean {
        if (this.transformOrder !== undefined) return this.transformOrder;
        for (const rec of this.records.values()) {
            const t = this.component(rec.uid, "Transform");
            const keys = (asMap(t?.value)?.entries ?? []).map((e) => e.key.value);
            if (keys.includes("parent") && keys.includes("pos")) return (this.transformOrder = keys.indexOf("parent") < keys.indexOf("pos"));
        }
        return (this.transformOrder = false);
    }

    private nextUid(): number {
        let uid = 1;
        for (const id of this.records.keys()) if (id >= uid) uid = id + 1;
        return uid;
    }

    /** Adds an entity's item to the group of its prototype (made when missing) and indexes it. */
    private insertEntity(proto: string, uid: number, item: YItem, counted = true): void {
        const groups = this.groups;
        let group = groups.items.find((g) => text(get(g.value, "proto")) === proto);
        let groupEntities: YEntry;
        if (group) {
            groupEntities = entryOf(asMap(group.value)!, "entities")!;
            const list = asSeq(groupEntities.value)!;
            const at = list.items.findIndex((i) => Number(text(get(i.value, "uid"))) > uid);
            this.journal.splice(list, "items", at === -1 ? list.items.length : at, 0, item);
            this.touch(this.entitiesEntry, group, groupEntities);
        } else {
            group = { value: map([["proto", scalar(proto)], ["entities", seq([])]]) };
            groupEntities = entryOf(asMap(group.value)!, "entities")!;
            asSeq(groupEntities.value)!.items.push(item);
            // groups after the map/grid group ("") are in name order
            const at = groups.items.findIndex((g, i) => i > 0 && nameOrder(text(get(g.value, "proto")) ?? "", proto) > 0);
            this.journal.splice(groups, "items", at === -1 ? groups.items.length : at, 0, group);
            this.touch(this.entitiesEntry);
        }
        if (counted) this.changeEntityCount(1);
        this.index({ uid, proto, group, groupEntities, item });
        this.journal.note([uid]);
    }

    /** Deletes an entity together with everything parented to it (container contents included). */
    deleteEntity(uid: number): number[] {
        return this.journal.edit("Delete", () => {
            const removed = [uid, ...this.descendants(uid)];
            // links, device list entries, container slots and other references naming them go too
            this.devices.forget(new Set(removed));
            for (const id of removed) {
                const rec = this.records.get(id);
                if (!rec) continue;
                const list = asSeq(rec.groupEntities.value)!;
                if (list.items.length === 1) {
                    const groups = this.groups;
                    this.journal.splice(groups, "items", groups.items.indexOf(rec.group), 1);
                    this.touch(this.entitiesEntry);
                } else {
                    this.journal.splice(list, "items", list.items.indexOf(rec.item), 1);
                    this.touch(this.entitiesEntry, rec.group, rec.groupEntities);
                }
                this.unindex(id);
            }
            this.changeEntityCount(-removed.length);
            // entities of no map (chunk entities) are listed at the top
            const nullspace = entryOf(this.yaml.root, "nullspace");
            const listed = asSeq(nullspace?.value);
            if (nullspace && listed) {
                const gone = new Set(removed);
                const keep = listed.items.filter((i) => !gone.has(Number(text(i.value))));
                if (keep.length !== listed.items.length) {
                    this.journal.set(listed, "items", keep);
                    this.touch(nullspace);
                }
            }
            this.journal.note(removed);
            return removed;
        });
    }

    private changeEntityCount(delta: number): void {
        const meta = entryOf(this.yaml.root, "meta")!;
        const count = entryOf(asMap(meta.value)!, "entityCount");
        if (!count) return;
        this.setScalar(count, String(Number(text(count.value)) + delta));
        this.touch(meta);
    }

    private chunk(grid: number, x: number, y: number): { entry: YEntry; chunks: YEntry; version: number } | undefined {
        const mapGrid = this.component(grid, "MapGrid");
        const chunks = mapGrid && entryOf(asMap(mapGrid.value)!, "chunks");
        if (!chunks) return undefined;
        const { chunkX, chunkY } = locate(x, y);
        const entry = asMap(chunks.value)?.entries.find((e) => e.key.value === `${chunkX},${chunkY}`);
        return entry && { entry, chunks, version: Number(text(get(entry.value, "version")) ?? 6) };
    }

    /** Paints a tile by name (adding it to the tilemap if the map does not use it yet). "Space" erases. */
    setTile(grid: number, x: number, y: number, name: string, variant = 0, rotationMirroring = 0): void {
        this.journal.edit("Paint", () => this.setTiles(grid, [{ x, y, name, variant, rotationMirroring }]));
    }

    /**
     * Paints many tiles of a grid as one edit, decoding and encoding each chunk once (see `setTile`). Later cells
     * win over earlier ones at the same place.
     */
    setTiles(grid: number, cells: Iterable<TileEdit>): void {
        this.journal.edit("Paint", () => {
            const mapGrid = this.component(grid, "MapGrid");
            if (!mapGrid) throw new Error(`Entity ${grid} is not a grid`);
            const version = this.format >= 7 ? 7 : 6;
            const ids = new Map<string, number>();
            const idOf = (name: string) => {
                let id = ids.get(name);
                if (id === undefined) ids.set(name, (id = this.tileId(name)));
                return id;
            };
            // by chunk: index in the chunk → tile
            const byChunk = new Map<string, { chunkX: number; chunkY: number; tiles: Map<number, Tile> }>();
            const noted: Array<[number, number, number]> = [];
            for (const c of cells) {
                const { chunkX, chunkY, index } = locate(c.x, c.y);
                const key = `${chunkX},${chunkY}`;
                let chunk = byChunk.get(key);
                if (!chunk) byChunk.set(key, (chunk = { chunkX, chunkY, tiles: new Map() }));
                chunk.tiles.set(index, { id: idOf(c.name), flags: 0, variant: c.variant ?? 0, rotationMirroring: version >= 7 ? c.rotationMirroring ?? 0 : 0 });
                noted.push([grid, c.x, c.y]);
            }
            if (!byChunk.size) return;
            const gridFields = asMap(mapGrid.value)!;
            let chunksEntry = entryOf(gridFields, "chunks");
            if (!chunksEntry) {
                chunksEntry = { key: scalar("chunks"), value: map([]) };
                this.journal.splice(gridFields, "entries", gridFields.entries.length, 0, chunksEntry);
            }
            // a grid without tiles has "chunks: {}"
            const chunksMap = this.ensureMap(chunksEntry);
            const existing = new Map(chunksMap.entries.map((e) => [e.key.value, e]));
            const added: YEntry[] = [];
            for (const [key, { tiles }] of byChunk) {
                const chunk = existing.get(key);
                if (chunk) {
                    const tilesEntry = entryOf(asMap(chunk.value)!, "tiles")!;
                    const chunkVersion = Number(text(get(chunk.value, "version")) ?? version);
                    const list = decodeChunk(text(tilesEntry.value)!, chunkVersion);
                    for (const [i, t] of tiles) list[i] = chunkVersion >= 7 ? t : { ...t, rotationMirroring: 0 };
                    this.setScalar(tilesEntry, encodeChunk(list, chunkVersion));
                    this.touch(chunk);
                } else {
                    const space = idOf("Space");
                    const list = Array.from({ length: CHUNK_SIZE * CHUNK_SIZE }, () => ({ ...EMPTY_TILE, id: space }));
                    for (const [i, t] of tiles) list[i] = t;
                    added.push({
                        key: scalar(key),
                        value: map([
                            ["ind", scalar(key)],
                            ["tiles", scalar(encodeChunk(list, version))],
                            ["version", scalar(String(version))],
                        ]),
                    });
                }
            }
            if (added.length) this.journal.splice(chunksMap, "entries", chunksMap.entries.length, 0, ...added);
            this.touch(chunksEntry, mapGrid, this.componentList(grid).entry);
            this.touchEntity(this.record(grid));
            this.journal.note([], noted);
        });
    }

    /** Runs several edits as one: one undo step (or one step of an open edit), one change notification. */
    batch<T>(label: string, fn: () => T): T {
        return this.journal.edit(label, fn);
    }

    private tileId(name: string): number {
        const tilemap = this.tilemap();
        for (const [id, n] of tilemap) if (n === name) return id;
        const entry = entryOf(this.yaml.root, "tilemap")!;
        const m = this.ensureMap(entry);
        const id = Math.max(-1, ...tilemap.keys()) + 1;
        // "Space" first, then by name
        const at = m.entries.findIndex((e) => text(e.value) !== "Space" && nameOrder(text(e.value) ?? "", name) > 0);
        this.journal.splice(m, "entries", at === -1 ? m.entries.length : at, 0, { key: scalar(String(id)), value: scalar(name) });
        this.touch(entry);
        return id;
    }

    // -----------------------------------------------------------------------------------------
    // Decal edits

    /**
     * Places a decal of prototype `proto` with its bottom left corner at grid coordinates (x, y) and returns its id
     * (the next free one, as the game gives it). Grids without decal storage get a `DecalGrid`, or a chunk entity
     * when the map keeps decals on chunk entities.
     */
    addDecal(grid: number, proto: string, x: number, y: number, props: Partial<Omit<DecalProps, "proto">> = {}): string {
        return this.journal.edit("Place decal", () => {
            const p = decalProps({ proto, color: null, angle: 0, zIndex: 0, cleanable: false, ...props });
            const id = this.insertDecal(grid, p, x, y);
            this.journal.note([], [], [[grid, id]]);
            return id;
        });
    }

    /**
     * Moves a decal (its bottom left corner) to grid coordinates (x, y). Returns its id afterwards: it changes only when
     * a decal on chunk entities moves to another chunk, where the game gives it the next free id of that chunk.
     */
    moveDecal(grid: number, id: string, x: number, y: number): string {
        return this.journal.edit("Move decal", () => {
            const found = this.findDecal(grid, id);
            if (!found) throw new Error(`No decal ${id} on grid ${grid}`);
            const { store, node, entry, decal } = found;
            let result = id;
            if (store.chunk && !sameChunk(store.chunk, chunkOf(x, y))) {
                result = this.insertDecal(grid, decal, x, y);
                this.removeDecalEntry(store, node, entry);
            } else {
                this.setScalar(entry, `${formatFloat(x)},${formatFloat(y)}`);
                this.touchDecals(store, node, entryOf(asMap(node.value)!, "decals")!);
            }
            this.journal.note([], [], [[grid, id], [grid, result]]);
            return result;
        });
    }

    /** Changes the prototype, colour, angle, z or cleanability of a decal; it moves to the node of its new properties. */
    setDecalProperties(grid: number, id: string, props: Partial<DecalProps>): void {
        this.journal.edit("Change decal", () => {
            const found = this.findDecal(grid, id);
            if (!found) throw new Error(`No decal ${id} on grid ${grid}`);
            const { store, node, entry, decal } = found;
            const next = decalProps({ ...decal, ...props }, !decal.proto);
            if (compareProps(next, decal) === 0) return;
            // added before removing, so a chunk entity left without decals for a moment is not deleted
            const local = Number(entry.key.value);
            this.addToStore(store, local, next, text(entry.value) ?? "0,0");
            this.removeDecalEntry(store, node, entry);
            this.journal.note([], [], [[grid, id]]);
        });
    }

    deleteDecal(grid: number, id: string): void {
        this.journal.edit("Delete decal", () => {
            const found = this.findDecal(grid, id);
            if (!found) throw new Error(`No decal ${id} on grid ${grid}`);
            this.removeDecalEntry(found.store, found.node, found.entry);
            this.journal.note([], [], [[grid, id]]);
        });
    }

    /**
     * Several decal edits of a grid as one edit, the decals looked up once (for many decals at a time): each
     * changes properties (as `setDecalProperties`) and/or moves (as `moveDecal`). Returns the ids afterwards.
     */
    editDecals(grid: number, edits: ReadonlyArray<{ id: string; x?: number; y?: number; props?: Partial<DecalProps> }>): string[] {
        return this.journal.edit("Change decals", () => {
            const index = this.decalIndex(grid);
            return edits.map((e) => {
                const found = index.get(e.id);
                if (!found) throw new Error(`No decal ${e.id} on grid ${grid}`);
                let { node, entry, decal } = found;
                const { store } = found;
                if (e.props) {
                    const next = decalProps({ ...decal, ...e.props }, !decal.proto);
                    if (compareProps(next, decal) !== 0) {
                        const added = this.addToStore(store, Number(entry.key.value), next, text(entry.value) ?? "0,0");
                        this.removeDecalEntry(store, node, entry);
                        ({ node, entry } = added);
                        decal = { ...decal, ...next };
                    }
                }
                let id = e.id;
                if (e.x !== undefined && e.y !== undefined && (e.x !== decal.x || e.y !== decal.y)) {
                    if (store.chunk && !sameChunk(store.chunk, chunkOf(e.x, e.y))) {
                        id = this.insertDecal(grid, decal, e.x, e.y);
                        this.removeDecalEntry(store, node, entry);
                    } else {
                        this.setScalar(entry, `${formatFloat(e.x)},${formatFloat(e.y)}`);
                        this.touchDecals(store, node, entryOf(asMap(node.value)!, "decals")!);
                    }
                }
                this.journal.note([], [], [[grid, e.id], [grid, id]]);
                return id;
            });
        });
    }

    /** Deletes several decals of a grid as one edit. */
    deleteDecals(grid: number, ids: Iterable<string>): void {
        this.journal.edit("Delete decals", () => {
            const index = this.decalIndex(grid);
            for (const id of ids) {
                const found = index.get(id);
                if (!found) throw new Error(`No decal ${id} on grid ${grid}`);
                this.removeDecalEntry(found.store, found.node, found.entry);
                this.journal.note([], [], [[grid, id]]);
            }
        });
    }

    /**
     * Places several decals on a grid as one edit; the file and the ids are those `addDecal` one after another
     * would give, but the grid's ids are read once and every node and chunk is written once (for thousands of
     * decals at a time). Returns the ids in the order of `list`.
     */
    addDecals(grid: number, list: readonly NewDecal[]): string[] {
        return this.journal.edit("Place decals", () => {
            if (!list.length) return [];
            if (!this.component(grid, "MapGrid")) throw new Error(`Entity ${grid} is not a grid`);
            const items = list.map((d) => ({
                props: decalProps({ proto: d.proto, color: null, angle: 0, zIndex: 0, cleanable: false, ...d.props }),
                position: `${formatFloat(d.x)},${formatFloat(d.y)}`,
                chunk: chunkOf(d.x, d.y),
                local: 0,
            }));
            const ids: string[] = [];
            if (this.component(grid, "DecalGrid") || !this.usesChunkEntities(grid)) {
                const { store, fresh } = this.decalGridStore(grid);
                // as insertDecal: after the highest id, from 0 in a new collection
                let local = fresh ? 0 : 1;
                let any = false;
                for (const d of this.storeDecals(store)) {
                    const n = Number(d.entry.key.value);
                    if (!any || n + 1 > local) local = n + 1;
                    any = true;
                }
                for (const it of items) {
                    it.local = local++;
                    ids.push(decalId(it.local));
                }
                this.addManyToStore(store, items);
            } else {
                // chunks in the order their first decal comes, so new chunk entities get the same uids
                const byChunk = new Map<string, typeof items>();
                for (const it of items) {
                    const key = `${it.chunk[0]},${it.chunk[1]}`;
                    const group = byChunk.get(key);
                    if (group) group.push(it);
                    else byChunk.set(key, [it]);
                }
                for (const group of byChunk.values()) {
                    const store = this.chunkStore(grid, group[0]!.chunk);
                    const fields = asMap(store.component.value)!;
                    const maxEntry = entryOf(fields, "maxDecalId");
                    const first = Number(text(maxEntry?.value) ?? 0);
                    let max = first;
                    const used = new Set([...this.storeDecals(store)].map((d) => Number(d.entry.key.value)));
                    for (const it of group) {
                        // TryAllocateDecalId, as insertDecal
                        let local = used.size === 0 && max === 0 ? 0 : max + 1;
                        while (used.has(local)) local++;
                        used.add(local);
                        if (local > max) max = local;
                        it.local = local;
                    }
                    if (max > first) {
                        if (maxEntry) this.setScalar(maxEntry, String(max));
                        else this.journal.splice(fields, "entries", 1, 0, { key: scalar("maxDecalId"), value: scalar(String(max)) });
                    }
                    this.addManyToStore(store, group);
                }
                for (const it of items) ids.push(decalId(it.local, it.chunk));
            }
            this.journal.note([], [], ids.map((id): [number, string] => [grid, id]));
            return ids;
        });
    }

    /** Every decal of a grid with where it is stored, by id. */
    private decalIndex(grid: number): Map<string, { store: DecalStore; node: YItem; entry: YEntry; decal: Decal }> {
        const index = new Map<string, { store: DecalStore; node: YItem; entry: YEntry; decal: Decal }>();
        for (const store of this.decalStores(grid)) for (const d of this.storeDecals(store)) index.set(d.decal.id, { store, ...d });
        return index;
    }

    /** Adds a decal where the game keeps decals of the grid; returns its id. */
    private insertDecal(grid: number, props: DecalProps, x: number, y: number): string {
        if (!this.component(grid, "MapGrid")) throw new Error(`Entity ${grid} is not a grid`);
        const position = `${formatFloat(x)},${formatFloat(y)}`;
        if (this.component(grid, "DecalGrid") || !this.usesChunkEntities(grid)) {
            const { store, fresh } = this.decalGridStore(grid);
            // a loaded collection continues after its highest id (NextDecalId), a new one starts at 0
            let local = fresh ? 0 : 1;
            let any = false;
            for (const d of this.storeDecals(store)) {
                const n = Number(d.entry.key.value);
                if (!any || n + 1 > local) local = n + 1;
                any = true;
            }
            this.addToStore(store, local, props, position);
            return decalId(local);
        }
        const chunk = chunkOf(x, y);
        const store = this.chunkStore(grid, chunk);
        const fields = asMap(store.component.value)!;
        const maxEntry = entryOf(fields, "maxDecalId");
        const max = Number(text(maxEntry?.value) ?? 0);
        const used = new Set([...this.storeDecals(store)].map((d) => Number(d.entry.key.value)));
        // TryAllocateDecalId: 0 for an empty chunk, else after the highest id given so far
        let local = used.size === 0 && max === 0 ? 0 : max + 1;
        while (used.has(local)) local++;
        if (local > max) {
            if (maxEntry) this.setScalar(maxEntry, String(local));
            else this.journal.splice(fields, "entries", 1, 0, { key: scalar("maxDecalId"), value: scalar(String(local)) });
        }
        this.addToStore(store, local, props, position);
        return decalId(local, chunk);
    }

    /** Adds a decal entry to the node of its properties (made when missing, in the game's node order). */
    private addToStore(store: DecalStore, local: number, props: DecalProps, position: string): { node: YItem; entry: YEntry } {
        const collection = this.ensureMap(store.entry);
        let nodesEntry = entryOf(collection, "nodes");
        if (!nodesEntry) {
            nodesEntry = { key: scalar("nodes"), value: seq([]) };
            this.journal.splice(collection, "entries", collection.entries.length, 0, nodesEntry);
        }
        const nodes = this.ensureSeq(nodesEntry);
        const entry: YEntry = { key: scalar(String(local)), value: scalar(position) };
        const node = nodes.items.find((n) => compareProps(nodeProps(n), props) === 0);
        let target = node;
        if (node) {
            const decalsEntry = entryOf(asMap(node.value)!, "decals")!;
            const list = this.ensureMap(decalsEntry);
            const at = list.entries.findIndex((e) => Number(e.key.value) > local);
            this.journal.splice(list, "entries", at === -1 ? list.entries.length : at, 0, entry);
            this.touch(decalsEntry, node);
        } else {
            target = { value: map([["node", this.nodeFields(props)], ["decals", { kind: "map", entries: [entry] }]]) };
            const at = nodes.items.findIndex((n) => compareProps(nodeProps(n), props) > 0);
            this.journal.splice(nodes, "items", at === -1 ? nodes.items.length : at, 0, target);
        }
        this.touch(nodesEntry);
        this.touchDecals(store);
        return { node: target!, entry };
    }

    /**
     * Adds decal entries to a store as `addToStore` one after another would, each node's list and the node list
     * written once. Ids must ascend (as they are given).
     */
    private addManyToStore(store: DecalStore, items: ReadonlyArray<{ local: number; props: DecalProps; position: string }>): void {
        const collection = this.ensureMap(store.entry);
        let nodesEntry = entryOf(collection, "nodes");
        if (!nodesEntry) {
            nodesEntry = { key: scalar("nodes"), value: seq([]) };
            this.journal.splice(collection, "entries", collection.entries.length, 0, nodesEntry);
        }
        const nodes = this.ensureSeq(nodesEntry);
        const key = (p: DecalProps) => JSON.stringify([p.proto, p.color, p.angle, p.zIndex, p.cleanable]);
        const existing = new Map<string, YItem>();
        for (const n of nodes.items) {
            const k = key(nodeProps(n));
            if (!existing.has(k)) existing.set(k, n);
        }
        const groups = new Map<string, { props: DecalProps; entries: YEntry[] }>();
        for (const it of items) {
            const k = key(it.props);
            let group = groups.get(k);
            if (!group) groups.set(k, (group = { props: it.props, entries: [] }));
            group.entries.push({ key: scalar(String(it.local)), value: scalar(it.position) });
        }
        let nodeItems: YItem[] | null = null;
        for (const [k, { props, entries }] of groups) {
            const node = existing.get(k);
            if (node) {
                const decalsEntry = entryOf(asMap(node.value)!, "decals")!;
                const list = this.ensureMap(decalsEntry);
                // each entry goes before the first one with a higher id, as addToStore puts it
                const old = list.entries, merged: YEntry[] = [];
                let i = 0;
                for (const e of entries) {
                    const local = Number(e.key.value);
                    while (i < old.length && !(Number(old[i]!.key.value) > local)) merged.push(old[i++]!);
                    merged.push(e);
                }
                while (i < old.length) merged.push(old[i++]!);
                this.journal.set(list, "entries", merged);
                this.touch(decalsEntry, node);
            } else {
                nodeItems ??= nodes.items.slice();
                const made: YItem = { value: map([["node", this.nodeFields(props)], ["decals", { kind: "map", entries }]]) };
                const at = nodeItems.findIndex((n) => compareProps(nodeProps(n), props) > 0);
                nodeItems.splice(at === -1 ? nodeItems.length : at, 0, made);
            }
        }
        if (nodeItems) this.journal.set(nodes, "items", nodeItems);
        this.touch(nodesEntry);
        this.touchDecals(store);
    }

    /** Removes a decal entry, its node when it was the last one, and a chunk entity left without decals. */
    private removeDecalEntry(store: DecalStore, node: YItem, entry: YEntry): void {
        const nodesEntry = entryOf(asMap(store.entry.value)!, "nodes")!;
        const nodes = asSeq(nodesEntry.value)!;
        const decalsEntry = entryOf(asMap(node.value)!, "decals")!;
        const list = asMap(decalsEntry.value)!;
        if (list.entries.length === 1) this.journal.splice(nodes, "items", nodes.items.indexOf(node), 1);
        else {
            this.journal.splice(list, "entries", list.entries.indexOf(entry), 1);
            this.touch(decalsEntry, node);
        }
        this.touch(nodesEntry);
        this.touchDecals(store);
        // the game removes DecalChunk from a chunk without decals, and the chunk entity with nothing else on it
        if (store.chunk && !nodes.items.length) {
            const { list: components } = this.componentList(store.uid);
            if (components.items.every((c) => ["ChunkEntity", "DecalChunk"].includes(text(get(c.value, "type")) ?? ""))) this.deleteChunkEntity(store.uid);
            else this.dropComponent(store.uid, "DecalChunk");
        }
    }

    private touchDecals(store: DecalStore, ...inner: Array<YEntry | YItem>): void {
        const nodes = entryOf(asMap(store.entry.value) ?? map([]), "nodes");
        this.touch(...inner, ...(nodes ? [nodes] : []), store.entry, store.component, this.componentList(store.uid).entry);
        this.touchEntity(this.record(store.uid));
    }

    /** Node fields in the order of the map's engine; fields at their defaults are left out. */
    private nodeFields(p: DecalProps): YMap {
        const values: Record<string, string | undefined> = {
            id: p.proto || undefined,
            color: p.color ?? undefined,
            angle: p.angle !== 0 ? formatAngle(p.angle) : undefined,
            zIndex: p.zIndex !== 0 ? String(p.zIndex) : undefined,
            cleanable: p.cleanable ? "True" : undefined,
        };
        const order = this.newFieldOrder ? NODE_FIELDS_NEW : NODE_FIELDS_OLD;
        return map(order.filter((k) => values[k] !== undefined).map((k) => [k, scalar(values[k]!)]));
    }

    /**
     * Whether the map was saved by an engine that writes decal node fields as `zIndex, id, color, cleanable, angle`
     * (and transforms as `parent, rot, pos`) rather than reversed (`cleanable, zIndex, angle, color, id`).
     */
    private get newFieldOrder(): boolean {
        if (this.fieldOrder !== undefined) return this.fieldOrder;
        const inOrder = (keys: string[], order: readonly string[]) =>
            keys.every((k, i) => order.includes(k) && (i === 0 || order.indexOf(k) > order.indexOf(keys[i - 1]!)));
        let transform: boolean | undefined;
        for (const rec of this.records.values()) {
            for (const c of asSeq(get(rec.item.value, "components"))?.items ?? []) {
                const type = text(get(c.value, "type"));
                if (type === "Transform" && transform === undefined) {
                    const keys = (asMap(c.value)?.entries ?? []).map((e) => e.key.value);
                    if (keys.includes("parent") && keys.includes("pos")) transform = keys.indexOf("parent") < keys.indexOf("pos");
                }
                if (type !== "DecalGrid" && type !== "DecalChunk") continue;
                const nodes = asSeq(get(get(c.value, type === "DecalGrid" ? "chunkCollection" : "decals"), "nodes"))?.items ?? [];
                for (const n of nodes) {
                    const keys = (asMap(get(n.value, "node"))?.entries ?? []).map((e) => e.key.value);
                    if (keys.length < 2) continue;
                    const old = inOrder(keys, NODE_FIELDS_OLD), recent = inOrder(keys, NODE_FIELDS_NEW);
                    if (old !== recent) return (this.fieldOrder = recent);
                }
            }
        }
        return (this.fieldOrder = transform ?? false);
    }

    private usesChunkEntities(grid: number): boolean {
        return !!this.component(grid, "ChunkContainer") || this.groups.items.some((g) => text(get(g.value, "proto")) === CHUNK_ENTITY);
    }

    /** The grid's `DecalGrid` collection, made when missing; `fresh` when it was made now. */
    private decalGridStore(grid: number): { store: DecalStore; fresh: boolean } {
        const emptyCollection = () => map([["version", scalar("2")], ["nodes", seq([])]]);
        let component = this.component(grid, "DecalGrid");
        let fresh = false;
        if (!component) {
            component = { value: map([["type", scalar("DecalGrid")], ["chunkCollection", emptyCollection()]]) };
            // saved maps have DecalGrid after Gravity, before GridAtmosphere
            const { list } = this.componentList(grid);
            const types = list.items.map((i) => text(get(i.value, "type")));
            const after = types.indexOf("Gravity"), before = types.indexOf("GridAtmosphere");
            this.journal.splice(list, "items", after !== -1 ? after + 1 : before !== -1 ? before : list.items.length, 0, component);
            fresh = true;
        }
        const fields = asMap(component.value)!;
        let entry = entryOf(fields, "chunkCollection");
        if (!entry) {
            entry = { key: scalar("chunkCollection"), value: emptyCollection() };
            this.journal.splice(fields, "entries", fields.entries.length, 0, entry);
            fresh = true;
        }
        return { store: { uid: grid, component, entry }, fresh };
    }

    /** The `DecalChunk` collection of a grid's chunk, with the chunk entity made when missing. */
    private chunkStore(grid: number, chunk: [number, number]): DecalStore {
        let uid = this.chunkEntities(grid).find((c) => sameChunk(c.chunk, chunk))?.uid;
        if (uid === undefined) {
            uid = this.nextUid();
            const info: Array<[string, YNode]> = [["type", scalar("ChunkEntity")], ["root", scalar(String(grid))]];
            if (chunk[0] !== 0 || chunk[1] !== 0) info.push(["chunk", scalar(`${chunk[0]},${chunk[1]}`)]);
            this.insertEntity(CHUNK_ENTITY, uid, { value: map([["uid", scalar(String(uid))], ["components", seq([map(info)])]]) });
            // chunk entities are listed in "nullspace" and in the grid's ChunkContainer
            let nullspace = entryOf(this.yaml.root, "nullspace");
            if (!nullspace) {
                nullspace = { key: scalar("nullspace"), value: seq([]) };
                const keys = this.yaml.root.entries.map((e) => e.key.value);
                const at = keys.indexOf("orphans") !== -1 ? keys.indexOf("orphans") + 1 : Math.max(0, keys.indexOf("tilemap"));
                this.journal.splice(this.yaml.root, "entries", at, 0, nullspace);
            }
            this.insertUid(nullspace, uid);
            let container = this.component(grid, "ChunkContainer");
            const { entry: gridComponents, list } = this.componentList(grid);
            if (!container) {
                container = { value: map([["type", scalar("ChunkContainer")], ["chunkEntities", seq([])]]) };
                this.journal.splice(list, "items", list.items.length, 0, container);
            }
            const fields = asMap(container.value)!;
            let entities = entryOf(fields, "chunkEntities");
            if (!entities) {
                entities = { key: scalar("chunkEntities"), value: seq([]) };
                this.journal.splice(fields, "entries", fields.entries.length, 0, entities);
            }
            this.insertUid(entities, uid);
            this.touch(container, gridComponents);
            this.touchEntity(this.record(grid));
        }
        let component = this.component(uid, "DecalChunk");
        if (!component) {
            component = { value: map([["type", scalar("DecalChunk")], ["decals", map([["version", scalar("1")], ["nodes", seq([])]])]]) };
            const { list } = this.componentList(uid);
            this.journal.splice(list, "items", list.items.length, 0, component);
        }
        return { uid, chunk, component, entry: entryOf(asMap(component.value)!, "decals")! };
    }

    private deleteChunkEntity(uid: number): void {
        const grid = Number(text(get(this.component(uid, "ChunkEntity")?.value, "root")));
        this.deleteEntity(uid);
        const container = this.records.has(grid) ? this.component(grid, "ChunkContainer") : undefined;
        const entities = container && entryOf(asMap(container.value)!, "chunkEntities");
        if (container && entities) {
            this.removeUid(entities, uid);
            this.touch(container, this.componentList(grid).entry);
            this.touchEntity(this.record(grid));
        }
    }

    /** Adds a uid to a list of uids in ascending order. */
    private insertUid(entry: YEntry, uid: number): void {
        const list = this.ensureSeq(entry);
        const at = list.items.findIndex((i) => Number(text(i.value)) > uid);
        this.journal.splice(list, "items", at === -1 ? list.items.length : at, 0, { value: scalar(String(uid)) });
        this.touch(entry);
    }

    private removeUid(entry: YEntry, uid: number): void {
        const list = asSeq(entry.value);
        const at = list?.items.findIndex((i) => Number(text(i.value)) === uid) ?? -1;
        if (!list || at === -1) return;
        this.journal.splice(list, "items", at, 1);
        this.touch(entry);
    }

    /** The mapping of an entry, replacing an empty flow value ("{}") or null with an empty mapping. */
    private ensureMap(entry: YEntry): YMap {
        if (entry.value.kind === "map") return entry.value;
        if (entry.value.kind === "seq" || !/^(\{\s*\}|~|null)?$/.test(entry.value.value.trim())) throw new Error(`"${entry.key.value}" is not a mapping`);
        const node = map([]);
        this.journal.set(entry, "value", node);
        this.touch(entry);
        return node;
    }

    /** The sequence of an entry, replacing an empty flow value ("[]") or null with an empty sequence. */
    private ensureSeq(entry: YEntry): YSeq {
        if (entry.value.kind === "seq") return entry.value;
        if (entry.value.kind === "map" || !/^(\[\s*\]|~|null)?$/.test(entry.value.value.trim())) throw new Error(`"${entry.key.value}" is not a sequence`);
        const node = seq([]);
        this.journal.set(entry, "value", node);
        this.touch(entry);
        return node;
    }

    // -----------------------------------------------------------------------------------------
    // Component edits

    /**
     * Replaces the map's override of component `type` on an entity, or adds it, from YAML text of its fields (a
     * mapping; a `type:` key may be included and must name the same component; "" or "{}" for no fields). The text
     * is kept as written, under `- type: <type>`. New components go where other entities of the prototype have them
     * in this map (MetaData first, Transform next), else last; `options.after` lists components a new one goes
     * after instead (right after the last of them the entity has). A `Transform` must keep its parent and valid
     * `pos`/`rot`, since the editor places entities by them.
     */
    setComponent(uid: number, type: string, yamlText: string, options: { after?: readonly string[] } = {}): void {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) throw new Error(`Not a component name: ${type}`);
        const record = this.record(uid);
        const fields = parseFields(yamlText, type);
        const item = this.componentItem(type, fields);
        if (type === "Transform") this.checkTransform(uid, asMap(item.value)!);

        this.journal.edit(`Edit ${type}`, () => {
            const { entry, list } = this.componentList(uid);
            const old = list.items.find((i) => text(get(i.value, "type")) === type);
            if (old) {
                if (itemText(old, COMPONENT_INDENT) === itemText(item, COMPONENT_INDENT)) return;
                this.journal.splice(list, "items", list.items.indexOf(old), 1, item);
            } else {
                const types = list.items.map((i) => text(get(i.value, "type")) ?? "");
                const after = options.after ? types.reduce((at, t, i) => (options.after!.includes(t) ? i + 1 : at), -1) : -1;
                this.journal.splice(list, "items", after >= 0 ? after : this.componentPosition(record, list, type), 0, item);
            }
            this.touch(entry);
            this.touchEntity(record);
            this.journal.note([uid]);
        });
    }

    /**
     * Removes the map's override of a component (the prototype's values apply again). Returns whether there was one.
     * Transform and a grid's MapGrid cannot be removed: the editor and the game need them on every such entity.
     */
    removeComponent(uid: number, type: string): boolean {
        if (type === "Transform") throw new Error("Transform cannot be removed");
        if (type === "MapGrid") throw new Error("MapGrid cannot be removed from a grid");
        return this.journal.edit(`Remove ${type}`, () => this.dropComponent(uid, type));
    }

    private dropComponent(uid: number, type: string): boolean {
        const { entry, list } = this.componentList(uid);
        const old = list.items.find((i) => text(get(i.value, "type")) === type);
        if (!old) return false;
        this.journal.splice(list, "items", list.items.indexOf(old), 1);
        this.touch(entry);
        this.touchEntity(this.record(uid));
        this.journal.note([uid]);
        return true;
    }

    /** Where a new component goes: after the components that precede it on entities of the same prototype. */
    private componentPosition(record: EntityRecord, list: YSeq, type: string): number {
        const types = list.items.map((i) => text(get(i.value, "type")) ?? "");
        if (type === "MetaData") return 0;
        const first = types[0] === "MetaData" ? 1 : 0;
        if (type === "Transform") return first;
        const head = first + (types[first] === "Transform" ? 1 : 0);
        for (const other of asSeq(record.groupEntities.value)?.items ?? []) {
            const theirs = (asSeq(get(other.value, "components"))?.items ?? []).map((i) => text(get(i.value, "type")) ?? "");
            const k = theirs.indexOf(type);
            if (k === -1) continue;
            const before = new Set(theirs.slice(0, k));
            let at = head;
            types.forEach((t, i) => {
                if (before.has(t) && i + 1 > at) at = i + 1;
            });
            return at;
        }
        return types.length;
    }

    private checkTransform(uid: number, fields: YMap): void {
        const parent = text(get(fields, "parent"));
        const current = this.transform(uid).parent;
        if ((parent === undefined || parent === "invalid" ? null : Number(parent)) !== current) {
            throw new Error(`Transform.parent must stay ${current ?? "invalid"}`);
        }
        const number = String.raw`\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*`;
        const pos = get(fields, "pos");
        if (pos && !(pos.kind === "scalar" && new RegExp(`^${number},${number}$`).test(pos.value))) throw new Error("Transform.pos must be x,y");
        const rot = get(fields, "rot");
        if (rot && !(rot.kind === "scalar" && new RegExp(`^${number}( rad)?$`).test(rot.value))) throw new Error("Transform.rot must be an angle in radians");
    }

    // -----------------------------------------------------------------------------------------
    // Device links and device lists (format rules in ./devices)

    private deviceEdits?: DeviceEdits;

    private get devices(): DeviceEdits {
        return (this.deviceEdits ??= new DeviceEdits({
            journal: this.journal,
            uids: () => this.uids(),
            has: (uid) => this.records.has(uid),
            proto: (uid) => this.proto(uid),
            transform: (uid) => this.transform(uid),
            component: (uid, type) => this.component(uid, type),
            components: (uid) => this.componentList(uid).list.items,
            touch: (uid, ...targets) => {
                this.touch(...targets, this.componentList(uid).entry);
                this.touchEntity(this.record(uid));
            },
            componentTypes: (uid) => this.componentList(uid).list.items.map((i) => text(get(i.value, "type")) ?? ""),
            siblingTypes: (uid) => {
                const rec = this.record(uid);
                return (asSeq(rec.groupEntities.value)?.items ?? []).filter((o) => o !== rec.item).map((o) => (asSeq(get(o.value, "components"))?.items ?? []).map((i) => text(get(i.value, "type")) ?? ""));
            },
            insertComponent: (uid, item, at) => {
                const { entry, list } = this.componentList(uid);
                this.journal.splice(list, "items", at, 0, item);
                this.touch(entry);
                this.touchEntity(this.record(uid));
            },
            dropComponent: (uid, type) => this.dropComponent(uid, type),
            onChange: (listener) => void this.journal.subscribe(listener),
        }));
    }

    /** Signal links of a source entity (`DeviceLinkSource.linkedPorts`), in file order. */
    links(uid: number): SignalLink[] {
        return this.devices.links(uid);
    }

    /** Signal links of every source into a sink entity. */
    linksTo(uid: number): SignalLink[] {
        return this.devices.linksTo(uid);
    }

    /** Signal ports of an entity: the pack's (game code's included) and those its overrides add. */
    signalPorts(uid: number, pack: DevicePack): { source: string[]; sink: string[] } {
        return this.devices.signalPorts(uid, pack);
    }

    /** Whether two ports can be linked (ports on both sides, in range), and why not. */
    canLink(source: number, sink: number, sourcePort: string, sinkPort: string, pack: DevicePack): Check {
        return this.devices.canLink(source, sink, sourcePort, sinkPort, pack);
    }

    /** Links `sourcePort` of `source` to `sinkPort` of `sink`; false when they are linked already. Throws why it cannot. */
    link(source: number, sink: number, sourcePort: string, sinkPort: string, pack: DevicePack): boolean {
        return this.journal.edit("Link", () => this.devices.link(source, sink, sourcePort, sinkPort, pack));
    }

    /** Replaces the links between two entities by the default links of the source's ports; returns how many were made. */
    linkDefaults(source: number, sink: number, pack: DevicePack): number {
        return this.journal.edit("Link defaults", () => this.devices.linkDefaults(source, sink, pack));
    }

    /** Removes one link; false when there is no such link. */
    unlink(source: number, sink: number, sourcePort: string, sinkPort: string): boolean {
        return this.journal.edit("Unlink", () => this.devices.unlink(source, sink, sourcePort, sinkPort));
    }

    /** Removes the links of a source to one sink, or to every sink; returns how many. */
    unlinkAll(source: number, sink?: number): number {
        return this.journal.edit("Unlink", () => this.devices.unlinkAll(source, sink));
    }

    /** Devices in an entity's device list (`DeviceList.devices`), in file order. */
    deviceList(uid: number): number[] {
        return this.devices.deviceList(uid);
    }

    /** Entities whose device list has `uid`. */
    deviceListsWith(uid: number): number[] {
        return this.devices.deviceListsWith(uid);
    }

    /** Whether a device can join an entity's device list (network, limit...), and why not. */
    canAddToDeviceList(config: number, device: number, pack: DevicePack): Check {
        return this.devices.canAddToDeviceList(config, device, pack);
    }

    /** Adds a device to an entity's device list with the fork's back reference; false when it is there already. */
    addToDeviceList(config: number, device: number, pack: DevicePack): boolean {
        return this.journal.edit("Add to device list", () => this.devices.addToDeviceList(config, device, pack));
    }

    /** Removes a device from an entity's device list and its back reference; false when it was not there. */
    removeFromDeviceList(config: number, device: number, pack: DevicePack): boolean {
        return this.journal.edit("Remove from device list", () => this.devices.removeFromDeviceList(config, device, pack));
    }

    // -----------------------------------------------------------------------------------------
    // Container contents (format rules in ./containers)

    private containerEdits?: ContainerEdits;

    private get contents(): ContainerEdits {
        const doc = this;
        return (this.containerEdits ??= new ContainerEdits({
            journal: this.journal,
            uids: () => this.uids(),
            has: (uid) => this.records.has(uid),
            proto: (uid) => this.proto(uid),
            transform: (uid) => this.transform(uid),
            component: (uid, type) => this.component(uid, type),
            components: (uid) => this.componentList(uid).list.items,
            touch: (uid, ...targets) => {
                this.touch(...targets, this.componentList(uid).entry);
                this.touchEntity(this.record(uid));
            },
            componentTypes: (uid) => this.componentList(uid).list.items.map((i) => text(get(i.value, "type")) ?? ""),
            siblingTypes: (uid) => {
                const rec = this.record(uid);
                return (asSeq(rec.groupEntities.value)?.items ?? []).filter((o) => o !== rec.item).map((o) => (asSeq(get(o.value, "components"))?.items ?? []).map((i) => text(get(i.value, "type")) ?? ""));
            },
            insertComponent: (uid, item, at) => {
                const { entry, list } = this.componentList(uid);
                this.journal.splice(list, "items", at, 0, item);
                this.touch(entry);
                this.touchEntity(this.record(uid));
                this.journal.note([uid]);
            },
            dropComponent: (uid, type) => this.dropComponent(uid, type),
            createEntity: (proto, components) => {
                const uid = this.nextUid();
                this.insertEntity(proto, uid, { value: map([["uid", scalar(String(uid))], ["components", seq(components.map((c) => c.value))]]) });
                return uid;
            },
            deleteEntity: (uid) => this.deleteEntity(uid),
            reparent: (uid) => {
                const rec = this.record(uid);
                this.unindex(uid);
                this.index(rec);
                this.journal.note([uid]);
            },
            get parentFirst() {
                return doc.parentFirst;
            },
            formatPosition: (x, y) => `${formatFloat(x)},${formatFloat(y)}`,
            formatRotation: (radians) => {
                const r = normalizeAngle(radians);
                return r === 0 ? null : formatAngle(r);
            },
        }));
    }

    /**
     * Containers of an entity: id, kind, what it is for and what it holds. The prototype's and those its components
     * add come from `pack` (prototype data); without it, those of the map's override.
     */
    containers(uid: number, pack?: ContainerPack): ContainerInfo[] {
        return this.contents.containers(uid, pack);
    }

    /** The container an entity is stored in, or null. */
    containerOf(uid: number): ContainerPlace | null {
        return this.contents.containerOf(uid);
    }

    /** Whether an entity (or a new one of `{proto}`) can go into a container (capacity, slot taken, whitelist...). */
    canInsert(owner: number, containerId: string, item: number | { proto: string }, opts?: InsertOptions): Check {
        return this.contents.canInsert(owner, containerId, item, opts);
    }

    /**
     * Puts an entity into a container of `owner` (out of where it is), or a new entity of `{proto}`, written as the
     * game stores it; returns its uid. A Storage needs `opts.location` or `opts.geometry`. Throws why it cannot.
     */
    insertIntoContainer(owner: number, containerId: string, item: number | { proto: string }, opts?: InsertOptions): number {
        return this.journal.edit("Put in", () => this.contents.insert(owner, containerId, item, opts));
    }

    /** Takes a stored entity out onto the map at a position, or deletes it with what it holds. */
    removeFromContainer(uid: number, to: MapPlace | "delete", pack?: ContainerPack): void {
        this.journal.edit(to === "delete" ? "Delete" : "Take out", () => this.contents.remove(uid, to, pack));
    }

    /** Moves a stored entity into another container, or to another place (`opts.index`, `opts.location`) in its own. */
    moveToContainer(uid: number, owner: number, containerId: string, opts?: InsertOptions): void {
        this.journal.edit("Move", () => this.contents.move(uid, owner, containerId, opts));
    }

    /**
     * Gives an entity another prototype (a Filled locker its plain base): its item, with the same uid, components
     * and position, moves to the group of the new prototype, where the game would list it (groups by name, items
     * by uid). A group left empty goes; a new one is made where the game sorts it.
     */
    changePrototype(uid: number, proto: string): void {
        if (!proto) throw new Error("A prototype is needed");
        const rec = this.record(uid);
        if (!rec.proto) throw new Error("Maps and grids have no prototype");
        if (rec.proto === proto) return;
        this.journal.edit("Change prototype", () => {
            const list = asSeq(rec.groupEntities.value)!;
            if (list.items.length === 1) {
                const groups = this.groups;
                this.journal.splice(groups, "items", groups.items.indexOf(rec.group), 1);
                this.touch(this.entitiesEntry);
            } else {
                this.journal.splice(list, "items", list.items.indexOf(rec.item), 1);
                this.touch(this.entitiesEntry, rec.group, rec.groupEntities);
            }
            this.unindex(uid);
            const others = this.former.get(uid) ?? [];
            if (!others.includes(rec)) others.push(rec);
            this.former.set(uid, others);
            this.insertEntity(proto, uid, rec.item, false);
            others.push(this.record(uid));
            this.journal.note([uid]);
        });
    }

    /** Reads how the map writes containers ahead of the first container edit (it scans every entity once). */
    prepareContainers(): void {
        this.contents.prepare();
    }

    /** The first place in a Storage where an item fits, as the game picks it; null when there is no room. */
    storageSpot(owner: number, geometry: StorageGeometry, except?: number): StorageLocation | null {
        return this.contents.storageSpot(owner, geometry, except);
    }

    // -----------------------------------------------------------------------------------------
    // Saving

    /**
     * Opens an edit made of several steps (dragging an entity, a brush stroke): every step is applied and
     * reported by `onChange` at once, and `commit` makes them one undo step.
     */
    begin(label: string): void {
        this.journal.begin(label);
    }

    /** Closes the edit opened by `begin`; returns whether it became an undo step. */
    commit(): boolean {
        return this.journal.commit();
    }

    /** Closes the edit opened by `begin`, reverting it. */
    cancel(): void {
        this.journal.cancel();
    }

    /** Handle of the edit `undo` would revert, and of the one `redo` would apply (see `Journal.lastDone`). */
    get lastEdit(): object | null {
        return this.journal.lastDone;
    }

    get nextRedo(): object | null {
        return this.journal.nextRedo;
    }

    get canUndo(): boolean {
        return this.journal.canUndo;
    }

    get canRedo(): boolean {
        return this.journal.canRedo;
    }

    /** Whether there are edits since the map was opened or `markSaved` last called. */
    get modified(): boolean {
        return this.journal.isModified;
    }

    markSaved(): void {
        this.journal.markSaved();
    }

    undo(): string | null {
        return this.journal.undo();
    }

    redo(): string | null {
        return this.journal.redo();
    }

    /** The file as the game would write it; `meta.time` is updated only when the map was edited. */
    serialize(now: Date = new Date()): string {
        if (!this.journal.isDirty) return serializeDocument(this.yaml);
        const meta = entryOf(this.yaml.root, "meta")!;
        const time = entryOf(asMap(meta.value)!, "time");
        if (!time) return serializeDocument(this.yaml);

        // written without recording it as an edit, so undoing everything restores the original
        const node = time.value as YScalar;
        const saved = { value: node.value, timeSrc: time.src, metaSrc: meta.src };
        node.value = formatSaveTime(now);
        delete time.src;
        delete meta.src;
        try {
            return serializeDocument(this.yaml);
        } finally {
            node.value = saved.value;
            if (saved.timeSrc !== undefined) time.src = saved.timeSrc;
            if (saved.metaSrc !== undefined) meta.src = saved.metaSrc;
        }
    }
}

/** `meta.time` as the game writes it: MM/dd/yyyy HH:mm:ss. */
export function formatSaveTime(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
