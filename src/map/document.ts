// A map file with the edits a mapper makes: entities placed, moved, rotated and deleted, tiles painted.
// Edits change only the YAML entries they touch, in the places and style the game's map saver uses,
// so the saved file differs from the original only where the map was edited.

import { Journal } from "./journal";
import { decodeChunk, encodeChunk, EMPTY_TILE, locate, CHUNK_SIZE, type Tile } from "./tiles";
import {
    entryOf,
    get,
    map,
    parseDocument,
    scalar,
    seq,
    serializeDocument,
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

const asMap = (node: YNode | undefined): YMap | undefined => (node?.kind === "map" ? node : undefined);
const asSeq = (node: YNode | undefined): YSeq | undefined => (node?.kind === "seq" ? node : undefined);
const text = (node: YNode | undefined): string | undefined => (node?.kind === "scalar" ? node.value : undefined);

/** Float as written by .NET for Vector2 components: shortest text that reads back to the same float32. */
export function formatFloat(value: number): string {
    const f = Math.fround(value);
    if (Object.is(f, -0) || f === 0) return "0";
    for (let p = 1; p <= 9; p++) {
        const s = Number(f.toPrecision(p));
        if (Math.fround(s) === f) return dotNetNumber(s);
    }
    return dotNetNumber(f);
}

/** Angle as written by .NET for a double (`Angle` is stored in radians). */
export function formatAngle(radians: number): string {
    return `${dotNetNumber(radians)} rad`;
}

function dotNetNumber(n: number): string {
    const s = String(n);
    if (!s.includes("e")) return s;
    // .NET writes 1E-05 where JavaScript writes 1e-5
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
    readonly journal = new Journal();
    private readonly records = new Map<number, EntityRecord>();
    /** Children of each entity by transform parent; built on first use after every change. */
    private childIndex: Map<number, number[]> | null = null;

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
        this.childIndex = null;
        this.records.clear();
        for (const group of this.groups.items) {
            const groupMap = asMap(group.value);
            const groupEntities = groupMap && entryOf(groupMap, "entities");
            const list = asSeq(groupEntities?.value);
            if (!groupMap || !groupEntities || !list) continue;
            const proto = text(get(groupMap, "proto")) ?? "";
            for (const item of list.items) {
                const uid = Number(text(get(item.value, "uid")));
                if (Number.isFinite(uid)) this.records.set(uid, { uid, proto, group, groupEntities, item });
            }
        }
    }

    uids(): number[] {
        return [...this.records.keys()];
    }

    /** Entities that carry tiles (grids). */
    grids(): number[] {
        return this.uids().filter((uid) => this.component(uid, "MapGrid") !== undefined);
    }

    proto(uid: number): string | undefined {
        return this.records.get(uid)?.proto;
    }

    private components(uid: number): { entry: YEntry; list: YSeq } {
        const rec = this.record(uid);
        const entry = entryOf(asMap(rec.item.value)!, "components");
        const list = asSeq(entry?.value);
        if (!entry || !list) throw new Error(`Entity ${uid} has no components`);
        return { entry, list };
    }

    private component(uid: number, type: string): YItem | undefined {
        return this.components(uid).list.items.find((i) => text(get(i.value, "type")) === type);
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

    private children(): Map<number, number[]> {
        if (this.childIndex) return this.childIndex;
        const index = new Map<number, number[]>();
        for (const id of this.records.keys()) {
            const parent = this.transform(id).parent;
            if (parent === null) continue;
            const list = index.get(parent);
            if (list) list.push(id);
            else index.set(parent, [id]);
        }
        return (this.childIndex = index);
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
        this.childIndex = null;
        const rec = this.record(uid);
        const { entry: componentsEntry } = this.components(uid);
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
    }

    moveEntity(uid: number, x: number, y: number): void {
        this.journal.edit("Move", () => this.setTransformField(uid, "pos", `${formatFloat(x)},${formatFloat(y)}`));
    }

    rotateEntity(uid: number, radians: number): void {
        const r = normalizeAngle(radians);
        this.journal.edit("Rotate", () => this.setTransformField(uid, "rot", r === 0 ? null : formatAngle(r)));
    }

    /** Places a new entity of `proto` and returns its uid. Only the transform is written; the rest comes from the prototype. */
    addEntity(proto: string, parent: number, x: number, y: number, rotation = 0): number {
        return this.journal.edit("Place", () => {
            const uid = Math.max(0, ...this.records.keys()) + 1;
            const r = normalizeAngle(rotation);
            const fields: Array<[string, YNode]> = [["type", scalar("Transform")]];
            if (r !== 0) fields.push(["rot", scalar(formatAngle(r))]);
            fields.push(["pos", scalar(`${formatFloat(x)},${formatFloat(y)}`)], ["parent", scalar(String(parent))]);
            const item: YItem = { value: map([["uid", scalar(String(uid))], ["components", seq([map(fields)])]]) };

            const groups = this.groups;
            let group = groups.items.find((g) => text(get(g.value, "proto")) === proto);
            if (group) {
                const groupEntities = entryOf(asMap(group.value)!, "entities")!;
                const list = asSeq(groupEntities.value)!;
                const at = list.items.findIndex((i) => Number(text(get(i.value, "uid"))) > uid);
                this.journal.splice(list, "items", at === -1 ? list.items.length : at, 0, item);
                this.touch(this.entitiesEntry, group, groupEntities);
            } else {
                group = { value: map([["proto", scalar(proto)], ["entities", seq([])]]) };
                asSeq(entryOf(asMap(group.value)!, "entities")!.value)!.items.push(item);
                // groups after the map/grid group ("") are in name order
                const at = groups.items.findIndex((g, i) => i > 0 && nameOrder(text(get(g.value, "proto")) ?? "", proto) > 0);
                this.journal.splice(groups, "items", at === -1 ? groups.items.length : at, 0, group);
                this.touch(this.entitiesEntry);
            }
            this.changeEntityCount(1);
            this.reindex();
            return uid;
        });
    }

    /** Deletes an entity together with everything parented to it (container contents included). */
    deleteEntity(uid: number): number[] {
        return this.journal.edit("Delete", () => {
            const removed = [uid, ...this.descendants(uid)];
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
                this.records.delete(id);
            }
            this.changeEntityCount(-removed.length);
            this.reindex();
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
        this.journal.edit("Paint", () => {
            const id = this.tileId(name);
            const mapGrid = this.component(grid, "MapGrid");
            if (!mapGrid) throw new Error(`Entity ${grid} is not a grid`);
            const gridFields = asMap(mapGrid.value)!;
            const chunksEntry = entryOf(gridFields, "chunks")!;
            const chunksMap = asMap(chunksEntry.value)!;
            const { chunkX, chunkY, index } = locate(x, y);
            const version = this.format >= 7 ? 7 : 6;
            const tile: Tile = { id, flags: 0, variant, rotationMirroring: version >= 7 ? rotationMirroring : 0 };

            let chunk = chunksMap.entries.find((e) => e.key.value === `${chunkX},${chunkY}`);
            if (chunk) {
                const tilesEntry = entryOf(asMap(chunk.value)!, "tiles")!;
                const chunkVersion = Number(text(get(chunk.value, "version")) ?? version);
                const tiles = decodeChunk(text(tilesEntry.value)!, chunkVersion);
                tiles[index] = tile;
                this.setScalar(tilesEntry, encodeChunk(tiles, chunkVersion));
                this.touch(chunk);
            } else {
                const tiles = Array.from({ length: CHUNK_SIZE * CHUNK_SIZE }, () => ({ ...EMPTY_TILE, id: this.tileId("Space") }));
                tiles[index] = tile;
                chunk = {
                    key: scalar(`${chunkX},${chunkY}`),
                    value: map([
                        ["ind", scalar(`${chunkX},${chunkY}`)],
                        ["tiles", scalar(encodeChunk(tiles, version))],
                        ["version", scalar(String(version))],
                    ]),
                };
                this.journal.splice(chunksMap, "entries", chunksMap.entries.length, 0, chunk);
            }
            this.touch(chunksEntry, mapGrid, this.components(grid).entry);
            this.touchEntity(this.record(grid));
        });
    }

    private tileId(name: string): number {
        const tilemap = this.tilemap();
        for (const [id, n] of tilemap) if (n === name) return id;
        const entry = entryOf(this.yaml.root, "tilemap")!;
        const m = asMap(entry.value)!;
        const id = Math.max(-1, ...tilemap.keys()) + 1;
        // "Space" first, then by name
        const at = m.entries.findIndex((e) => text(e.value) !== "Space" && nameOrder(text(e.value) ?? "", name) > 0);
        this.journal.splice(m, "entries", at === -1 ? m.entries.length : at, 0, { key: scalar(String(id)), value: scalar(name) });
        this.touch(entry);
        return id;
    }

    // -----------------------------------------------------------------------------------------
    // Saving

    undo(): string | null {
        const label = this.journal.undo();
        this.reindex();
        return label;
    }

    redo(): string | null {
        const label = this.journal.redo();
        this.reindex();
        return label;
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
