// Container contents as the game saves them: entities put into lockers and crates (EntityStorage), bags and boxes
// (Storage) and slots (ContainerSlot), taken out and moved between them.
//
// What saved maps show (survey of the 904 maps of upstream, Frontier and Goob):
//   - the owner's `ContainerContainer.containers` lists its containers: `id: !type:Container` with `ents: [uids]`,
//     or `id: !type:ContainerSlot` with `ent: uid | null`, and `showEnts`/`occludes` (False/True unless the
//     prototype says otherwise). Engines that write Transform as `parent, rot, pos` write `ents, showEnts,
//     occludes`; older ones (Frontier, Goob, older upstream maps) `showEnts, occludes, ents`;
//   - the override lists every container of the prototype, in the prototype's order, plus those systems add (in
//     no map does one hold only empty prototype containers: such an override equals the prototype and is left
//     out, as on the ~25 000 lockers saved without one);
//   - a stored entity: Transform with only `parent: <owner>` (no pos or rot; `anchored: False` where the prototype
//     anchors), `Physics.canCollide: False` (when it has physics), and, inside an EntityStorage,
//     `InsideEntityStorage` last (older saves lack one or both; taken out and put back, an entity keeps its form). Forks whose InsideEntityStorage saves
//     `storage` write `storage: <owner>` for entities put in during the session (entities loaded from the map
//     lose it, so most maps have it on none or a few);
//   - in a Storage, `Storage.storedItems` maps the item to `{position: "x,y", _rotation: South}`; it is a
//     Dictionary (a new entry takes the slot freed last, else goes last), while `ents` is a List (appended);
//   - slots of ItemSlots and PaperLabel are ContainerSlots; ItemSlots itself is never saved.
// Taking an entity out undoes this; taking it out and putting it back where it was in the same session gives the
// file it had (the game keeps removed fields' places the same way, see devices.ts).

import type { Check } from "./devices";
import type { Transform } from "./document";
import type { Journal } from "./journal";
import { emptyStyle, type EmptyStyle } from "./references";
import { entryOf, get, map, scalar, seq, type YEntry, type YItem, type YMap, type YNode, type YSeq } from "./yaml";
import type { PrototypeData } from "../pack/format";
import { resolveComponents, type Components } from "../pack/prototype-data";

export type ContainerKind = "Container" | "ContainerSlot";
/**
 * What a container is for: EntityStorage's `entity_storage`, Storage's `storagebase`, a slot (ItemSlots,
 * PaperLabel and other ContainerSlots); other containers (machine parts, magazines' ammo...) are the game's own.
 */
export type ContainerRole = "entityStorage" | "storage" | "itemSlot" | "other";

export interface ContainerInfo {
    id: string;
    kind: ContainerKind;
    role: ContainerRole;
    /** Uids inside, in order. */
    contents: number[];
    /** Declared by the prototype's ContainerContainer (else known from the map or the owner's components). */
    declared: boolean;
}

/** Where an entity is stored. */
export interface ContainerPlace {
    owner: number;
    id: string;
    kind: ContainerKind;
    /** Position in `ents` (0 for a slot). */
    index: number;
}

/** What the pack tells about prototypes; every field is optional, the map alone is read without it. */
export interface ContainerPack {
    /** Full prototype data (`Pack.prototypeData()`). */
    data?: PrototypeData | null;
    /** Current id of a prototype the map names (`Pack.migrate`). */
    migrate?(id: string): string | null;
    /** Whether the fork's InsideEntityStorage saves `storage` (component schemas); else the map's habit decides. */
    insideStorageField?: boolean;
}

/** A cell rectangle of a storage grid or item shape as the game's Box2i: left, bottom, right, top (inclusive). */
export type Box = readonly [number, number, number, number];
export type StorageRotation = "South" | "East" | "North" | "West";

/** Where an item lies in a Storage grid (`ItemStorageLocation`). */
export interface StorageLocation {
    x: number;
    y: number;
    rotation: StorageRotation;
}

/** A Storage's grid and an item's shape (from the pack); `shapeOf` gives the shapes of the items already in it. */
export interface StorageGeometry {
    grid: readonly Box[];
    shape: readonly Box[];
    shapeOf?(uid: number): readonly Box[] | null;
    /** `Storage.defaultStorageOrientation`. */
    orientation?: "Horizontal" | "Vertical" | null;
}

export interface InsertOptions {
    pack?: ContainerPack;
    /** Place in `ents` (default: last, as the game appends). */
    index?: number;
    /** Storage: where the item goes; found with `geometry` when left out. */
    location?: StorageLocation;
    geometry?: StorageGeometry;
    /** Whitelist check: true when allowed, else false or the reason. */
    allow?(proto: string, owner: number, containerId: string): boolean | string;
}

/** Where `remove` puts an entity: on a grid (or any parent) at a position. */
export interface MapPlace {
    grid: number;
    x: number;
    y: number;
    rotation?: number;
}

/** `EntityStorageComponent.Capacity` when the prototype does not set it. */
export const DEFAULT_ENTITY_STORAGE_CAPACITY = 30;
/** `StorageComponent.ChunkSize`: the game searches a grid for room chunk by chunk. */
const STORAGE_CHUNK = 8;

const ROTATIONS: readonly StorageRotation[] = ["South", "East", "North", "West"];

/** What the container rules need of the document; `MapDocument` provides it. */
export interface ContainerHost {
    readonly journal: Journal;
    uids(): number[];
    has(uid: number): boolean;
    proto(uid: number): string | undefined;
    transform(uid: number): Transform;
    component(uid: number, type: string): YItem | undefined;
    /** Components of an entity, in file order. */
    components(uid: number): YItem[];
    /** Marks entries and items inside an entity's components changed, with its component and entity path. */
    touch(uid: number, ...targets: Array<YEntry | YItem>): void;
    componentTypes(uid: number): string[];
    /** Component types of the other entities of its prototype. */
    siblingTypes(uid: number): string[][];
    insertComponent(uid: number, item: YItem, at: number): void;
    dropComponent(uid: number, type: string): boolean;
    /** Adds an entity of `proto` made of these components (Transform first) and returns its uid. */
    createEntity(proto: string, components: YItem[]): number;
    deleteEntity(uid: number): number[];
    /** Updates the parent index after Transform.parent changed. */
    reparent(uid: number): void;
    /** Whether the map's engine writes Transform as `parent, rot, pos`. */
    readonly parentFirst: boolean;
    formatPosition(x: number, y: number): string;
    /** Rotation as Transform.rot, or null for none. */
    formatRotation(radians: number): string | null;
}

const asMap = (node: YNode | undefined): YMap | undefined => (node?.kind === "map" ? node : undefined);
const asSeq = (node: YNode | undefined): YSeq | undefined => (node?.kind === "seq" ? node : undefined);
const text = (node: YNode | undefined): string | undefined => (node?.kind === "scalar" ? node.value : undefined);
const typeOf = (c: YItem) => text(get(c.value, "type"));
const isUid = (s: string | undefined) => /^\d+$/.test(s ?? "");
const isFalse = (v: unknown) => v === false || /^false$/i.test(String(v));
const isTrue = (v: unknown) => v === true || /^true$/i.test(String(v));
const bool = (b: boolean) => scalar(b ? "True" : "False");
const component = (type: string, fields: Array<[string, YNode]> = []): YItem => ({ value: map([["type", scalar(type)], ...fields]) });
const fail = (reason: string): Check => ({ ok: false, reason });

/** Container definition of a prototype (`{"!type": "ContainerSlot", ...}`, or null when written without fields). */
type ContainerDef = Record<string, unknown> | null;

/** Field order of containers in a map: `ents` first (newer engines), flags first, or `ents` alone (old saves). */
type Layout = "entsFirst" | "flagsFirst" | "bare";

/** Container edits of a document (run inside its edits). */
export class ContainerEdits {
    /**
     * Components this removed, by "uid type", with the component types before them: put back in the same session,
     * they go where they were (the game keeps Physics and the like on the entity, it just does not save them).
     */
    private readonly dropped = new Map<string, { before: string[]; item: YItem; owner?: number }>();
    /**
     * Slots entries were removed from, by mapping, last on top, while the mapping is unchanged since: a Dictionary
     * puts new entries into freed slots, last freed first (see devices.ts).
     */
    private readonly freed = new WeakMap<YMap, { list: YEntry[]; holes: Array<{ at: number; removed: YEntry }> }>();
    private readonly resolved = new WeakMap<PrototypeData, Map<string, Components>>();
    private readonly orders = new WeakMap<PrototypeData, Map<string, string[]>>();
    private habits?: { kinds: Map<string, ContainerKind>; layout: Record<ContainerKind, Layout>; inside: boolean; insideStorage: boolean; sorted: boolean };
    /** Storage items taken out that had no place in `storedItems` (old saves), by "owner uid". */
    private readonly unplaced = new Set<string>();
    /** Entities taken out without InsideEntityStorage or `canCollide: False` (older saves), by "owner uid". */
    private readonly bare = new Set<string>();
    private readonly colliding = new Set<string>();

    constructor(private readonly host: ContainerHost) {}

    // -----------------------------------------------------------------------------------------
    // Reading

    /** The containers of an entity: those of its map override, then the prototype's, then those its components add. */
    containers(uid: number, pack?: ContainerPack): ContainerInfo[] {
        if (!this.host.has(uid)) return [];
        const full = this.full(uid, pack);
        const defs = containerDefs(full);
        const roles = rolesOf(full);
        const out: ContainerInfo[] = [];
        const seen = new Set<string>();
        const add = (id: string, entry?: YEntry) => {
            if (seen.has(id)) return;
            seen.add(id);
            const hint = roles.get(id);
            const kind = this.kindOf(id, entry, defs[id], hint);
            // slots of other systems (id cards, gas tanks, stashes) hold one entity just the same
            const role = hint ?? (kind === "ContainerSlot" && !gameSlot(id, full) ? "itemSlot" : fallbackRole(id, full));
            out.push({ id, kind, role, contents: entry ? contentsOf(entry) : [], declared: id in defs });
        };
        for (const e of this.boxEntries(uid)) add(e.key.value, e);
        for (const id of Object.keys(defs)) add(id);
        for (const id of roles.keys()) add(id);
        return out;
    }

    /** The container an entity is in, or null. */
    containerOf(uid: number): ContainerPlace | null {
        if (!this.host.has(uid)) return null;
        const owner = this.host.transform(uid).parent;
        if (owner === null || !this.host.has(owner)) return null;
        for (const e of this.boxEntries(owner)) {
            const index = contentsOf(e).indexOf(uid);
            if (index !== -1) return { owner, id: e.key.value, kind: e.value.tag === "!type:ContainerSlot" || !!entryOf(asMap(e.value)!, "ent") ? "ContainerSlot" : "Container", index };
        }
        return null;
    }

    /** Where an item fits in a Storage, as the game finds it (first free spot); null when there is no room. */
    storageSpot(owner: number, geometry: StorageGeometry, except?: number): StorageLocation | null {
        return findStorageSpot(geometry.grid, geometry.shape, this.storedShapes(owner, geometry, except), geometry.orientation);
    }

    /** Whether an entity (or a new one of a prototype) can go into a container, and why not. */
    canInsert(owner: number, containerId: string, item: number | { proto: string }, opts: InsertOptions = {}): Check {
        const { host } = this;
        if (!host.has(owner)) return fail(`No entity ${owner}`);
        const box = this.containers(owner, opts.pack).find((c) => c.id === containerId);
        const name = host.proto(owner) || String(owner);
        if (!box) return fail(`${name} has no container ${containerId}`);
        if (box.role === "other") return fail(`${containerId} is filled by the game`);
        let proto: string;
        if (typeof item === "number") {
            if (!host.has(item)) return fail(`No entity ${item}`);
            if (item === owner || this.isInside(owner, item)) return fail("An entity cannot go inside itself");
            if (host.transform(item).parent === null || host.component(item, "MapGrid") || host.component(item, "Map")) return fail("Maps and grids cannot be stored");
            if (box.contents.includes(item)) return fail(`Already in ${containerId}`);
            proto = host.proto(item) ?? "";
        } else {
            proto = item.proto;
            if (!proto) return fail("No prototype");
            const id = opts.pack?.migrate ? opts.pack.migrate(proto) : proto;
            if (id === null || (opts.pack?.data && !opts.pack.data.entities[id])) return fail(`Unknown prototype ${proto}`);
        }
        if (box.kind === "ContainerSlot" && box.contents.length) return fail(`${containerId} is taken`);
        if (box.role === "entityStorage") {
            if (this.isOpen(owner, opts.pack)) return fail(`${name} is open`);
            const capacity = this.capacity(owner, opts.pack);
            if (box.contents.length >= capacity) return fail(`${name} is full (${capacity})`);
        }
        if (box.role === "storage") {
            const uid = typeof item === "number" ? item : undefined;
            const location = opts.location ?? (uid !== undefined ? this.rememberedLocation(owner, uid) : undefined);
            if (location && opts.geometry && !fitsInStorage(opts.geometry.grid, this.storedShapes(owner, opts.geometry, uid), opts.geometry.shape, location)) return fail("It does not fit there");
            const unplaced = uid !== undefined && this.unplaced.has(`${owner} ${uid}`);
            if (!location && !opts.geometry && !unplaced) return fail("A place in the storage grid is needed");
            if (!location && opts.geometry && !this.storageSpot(owner, opts.geometry, uid)) return fail(`No room in ${name}`);
        }
        if (opts.allow) {
            const r = opts.allow(proto, owner, containerId);
            if (r !== true) return fail(typeof r === "string" ? r : `${proto} does not fit in ${containerId}`);
        }
        return { ok: true };
    }

    // -----------------------------------------------------------------------------------------
    // Edits

    /**
     * Puts an entity into a container (taking it out of the one it is in) or makes a new entity of a prototype in
     * it; returns its uid. Throws why it cannot.
     */
    insert(owner: number, containerId: string, item: number | { proto: string }, opts: InsertOptions = {}): number {
        const check = this.canInsert(owner, containerId, item, opts);
        if (!check.ok) throw new Error(check.reason);
        const box = this.containers(owner, opts.pack).find((c) => c.id === containerId)!;
        const style = this.styleOnce();
        let uid: number;
        let location: StorageLocation | undefined;
        if (box.role === "storage") {
            const known = typeof item === "number" ? item : undefined;
            location = opts.location ?? (known !== undefined ? this.rememberedLocation(owner, known) : undefined) ?? (opts.geometry ? this.storageSpot(owner, opts.geometry, known)! : undefined);
        }
        if (typeof item === "number") {
            uid = item;
            const from = this.containerOf(uid);
            if (from) this.detach(uid, from, opts.pack, style);
            this.store(uid, owner, box.role, opts.pack);
            if (from) this.host.journal.note([from.owner]);
        } else {
            const parts = [this.newComponent("Transform", [["parent", scalar(String(owner))]])];
            const proto = opts.pack?.migrate?.(item.proto) ?? item.proto;
            if (this.hasPhysics(proto, null, opts.pack)) parts.push(this.newComponent("Physics", [["canCollide", bool(false)]]));
            if (box.role === "entityStorage" && this.habit().inside) parts.push(this.insideItem(owner, opts.pack));
            uid = this.host.createEntity(item.proto, parts);
        }
        this.attach(owner, box, uid, opts.index, opts.pack, style);
        if (location) this.addStored(owner, uid, location, opts.pack);
        this.unplaced.delete(`${owner} ${uid}`);
        this.bare.delete(`${owner} ${uid}`);
        this.colliding.delete(`${owner} ${uid}`);
        this.host.journal.note([uid, owner]);
        return uid;
    }

    /** Takes an entity out of its container onto the map, or deletes it (with what it holds). */
    remove(uid: number, to: MapPlace | "delete", pack?: ContainerPack): void {
        const from = this.containerOf(uid);
        if (!from) throw new Error(`${uid} is not in a container`);
        if (to === "delete") {
            this.host.deleteEntity(uid);
            if (this.host.has(from.owner) && this.droppable(from.owner, pack)) this.dropContainers(from.owner);
            this.host.journal.note([from.owner]);
            return;
        }
        if (!this.host.has(to.grid)) throw new Error(`No entity ${to.grid}`);
        if (to.grid === uid || this.isInside(to.grid, uid)) throw new Error("An entity cannot go inside itself");
        this.detach(uid, from, pack, this.styleOnce());
        this.placeOnMap(uid, to);
        this.host.journal.note([uid, from.owner]);
    }

    /** Moves an entity into another container (or to another place in its own). */
    move(uid: number, owner: number, containerId: string, opts: InsertOptions = {}): void {
        const from = this.containerOf(uid);
        if (!from) throw new Error(`${uid} is not in a container`);
        if (from.owner === owner && from.id === containerId) {
            // a new place in the same container: out, then back in
            const style = this.styleOnce();
            const box = this.containers(owner, opts.pack).find((c) => c.id === containerId)!;
            const location = box.role === "storage" ? opts.location ?? this.rememberedLocation(owner, uid) : undefined;
            this.detach(uid, from, opts.pack, style);
            this.store(uid, owner, box.role, opts.pack);
            this.attach(owner, box, uid, opts.index, opts.pack, style);
            if (location) this.addStored(owner, uid, location, opts.pack);
            this.host.journal.note([uid, owner]);
            return;
        }
        this.insert(owner, containerId, uid, opts);
    }

    // -----------------------------------------------------------------------------------------
    // The container side

    private boxEntries(owner: number): YEntry[] {
        const cc = this.host.component(owner, "ContainerContainer");
        return asMap(get(cc?.value, "containers"))?.entries.filter((e) => e.value.kind === "map" || e.value.tag) ?? [];
    }

    /** Adds `uid` to a container of `owner`, writing the owner's ContainerContainer when it has none. */
    private attach(owner: number, info: ContainerInfo, uid: number, index: number | undefined, pack: ContainerPack | undefined, style: () => EmptyStyle): void {
        const { host } = this;
        const { journal } = host;
        let cc = host.component(owner, "ContainerContainer");
        if (!cc) {
            const was = this.dropped.get(`${owner} ContainerContainer`);
            cc = was && !host.components(owner).includes(was.item) ? was.item : this.newContainers(owner, pack, style);
            host.insertComponent(owner, cc, this.componentAt(owner, "ContainerContainer", pack));
        }
        const fields = asMap(cc.value)!;
        let containers = entryOf(fields, "containers");
        if (!containers) {
            containers = { key: scalar("containers"), value: map([]) };
            journal.splice(fields, "entries", fields.entries.length, 0, containers);
        }
        const boxes = this.ensure(containers, "map") as YMap;
        let box = boxes.entries.find((e) => e.key.value === info.id);
        if (!box) {
            box = { key: scalar(info.id), value: this.newBox(info.kind, containerDefs(this.full(owner, pack))[info.id] ?? null, style()) };
            journal.splice(boxes, "entries", boxes.entries.length, 0, box);
        } else if (box.value.kind !== "map") {
            // `stash: !type:ContainerSlot {}` (old saves)
            journal.set(box, "value", map([], box.value.tag));
        }
        const fieldsOfBox = box.value as YMap;
        const key = info.kind === "ContainerSlot" ? "ent" : "ents";
        let field = entryOf(fieldsOfBox, key);
        if (!field) {
            field = { key: scalar(key), value: info.kind === "ContainerSlot" ? scalar("null") : seq([]) };
            this.addEntry(fieldsOfBox, field, this.fieldAt(fieldsOfBox, info.kind));
        }
        if (info.kind === "ContainerSlot") journal.set(field, "value", scalar(String(uid)));
        else {
            const list = this.ensure(field, "seq") as YSeq;
            const at = index === undefined ? list.items.length : Math.max(0, Math.min(index, list.items.length));
            journal.splice(list, "items", at, 0, { value: scalar(String(uid)) });
        }
        host.touch(owner, cc, containers, box, field);
    }

    /** Takes `uid` out of its container (both sides), leaving its Transform for the caller. */
    private detach(uid: number, from: ContainerPlace, pack: ContainerPack | undefined, style: () => EmptyStyle): void {
        const { host } = this;
        const { journal } = host;
        const owner = from.owner;
        const cc = host.component(owner, "ContainerContainer")!;
        const containers = entryOf(asMap(cc.value)!, "containers")!;
        const box = asMap(containers.value)!.entries.find((e) => e.key.value === from.id)!;
        const fields = box.value as YMap;
        const touched: Array<YEntry | YItem> = [containers, box];
        if (from.kind === "ContainerSlot") {
            const ent = entryOf(fields, "ent")!;
            if (style().slot) {
                journal.set(ent, "value", scalar("null"));
                touched.push(ent);
            } else this.removeEntry(fields, ent);
        } else {
            const ents = entryOf(fields, "ents")!;
            const list = ents.value as YSeq;
            const keep = list.items.filter((i) => Number(text(i.value)) !== uid);
            const leave = !keep.length && !style().list;
            journal.set(list, "items", keep);
            if (leave) this.removeEntry(fields, ents);
            else touched.push(ents);
        }
        host.touch(owner, cc, ...touched);
        this.removeStored(owner, uid);
        if (this.droppable(owner, pack)) this.dropContainers(owner);
        this.unstore(uid);
    }

    /** A ContainerContainer listing every container of the owner (the prototype's in its order), all empty. */
    private newContainers(owner: number, pack: ContainerPack | undefined, style: () => EmptyStyle): YItem {
        const defs = containerDefs(this.full(owner, pack));
        const entries: Array<[string, YNode]> = this.containers(owner, pack).map((c) => [c.id, this.newBox(c.kind, defs[c.id] ?? null, style())]);
        return this.newComponent("ContainerContainer", [["containers", map(entries)]]);
    }

    private newBox(kind: ContainerKind, def: ContainerDef, style: EmptyStyle): YMap {
        const flag = (name: string, fallback: boolean) => (def && name in def ? isTrue(def[name]) : fallback);
        const layout = this.habit().layout[kind];
        const field: Array<[string, YNode]> = kind === "ContainerSlot" ? (style.slot ? [["ent", scalar("null")]] : []) : style.list ? [["ents", seq([])]] : [];
        const flags: Array<[string, YNode]> = layout === "bare" ? [] : [["showEnts", bool(flag("showEnts", false))], ["occludes", bool(flag("occludes", true))]];
        const box = map(layout === "flagsFirst" ? [...flags, ...field] : [...field, ...flags], kind === "ContainerSlot" ? "!type:ContainerSlot" : "!type:Container");
        if (this.habit().sorted) box.entries = sortEntries(box.entries);
        return box;
    }

    /** Where `ents`/`ent` goes in a container that lacks it. */
    private fieldAt(box: YMap, kind: ContainerKind): number {
        return this.habit().layout[kind] === "flagsFirst" ? box.entries.length : 0;
    }

    /** Whether the owner's ContainerContainer equals its prototype's (every container declared, empty, default flags). */
    private droppable(owner: number, pack: ContainerPack | undefined): boolean {
        const full = this.full(owner, pack);
        if (!full) return false;
        const defs = containerDefs(full);
        const cc = this.host.component(owner, "ContainerContainer");
        if (!cc || asMap(cc.value)!.entries.some((e) => e.key.value !== "type" && e.key.value !== "containers")) return false;
        const entries = asMap(get(cc.value, "containers"))?.entries ?? [];
        return entries.every((e) => {
            if (!(e.key.value in defs)) return false;
            if (contentsOf(e).length) return false;
            const def = defs[e.key.value] ?? null;
            const flag = (name: string, fallback: boolean) => (def && name in def ? isTrue(def[name]) : fallback);
            const show = text(get(e.value, "showEnts")), occ = text(get(e.value, "occludes"));
            return (show === undefined || isTrue(show) === flag("showEnts", false)) && (occ === undefined || isTrue(occ) === flag("occludes", true));
        });
    }

    private dropContainers(owner: number): void {
        this.dropComponent(owner, "ContainerContainer");
    }

    // -----------------------------------------------------------------------------------------
    // Storage grid places

    private storedItems(owner: number): YMap | undefined {
        return asMap(get(this.host.component(owner, "Storage")?.value, "storedItems"));
    }

    /** The place an item had in a Storage it was taken out of in this session, when its slot is still free. */
    private rememberedLocation(owner: number, uid: number): StorageLocation | undefined {
        const items = this.storedItems(owner) ?? asMap(get(this.dropped.get(`${owner} Storage`)?.item.value, "storedItems"));
        const entry = items && this.holes(items).find((h) => Number(h.removed.key.value) === uid)?.removed;
        return entry && readLocation(entry.value);
    }

    private storedShapes(owner: number, geometry: StorageGeometry, except?: number): Array<{ shape: readonly Box[]; location: StorageLocation }> {
        const out: Array<{ shape: readonly Box[]; location: StorageLocation }> = [];
        for (const e of this.storedItems(owner)?.entries ?? []) {
            const uid = Number(e.key.value);
            const shape = uid === except ? null : geometry.shapeOf?.(uid);
            const location = readLocation(e.value);
            if (shape && location) out.push({ shape, location });
        }
        return out;
    }

    private addStored(owner: number, uid: number, location: StorageLocation, pack: ContainerPack | undefined): void {
        const { host } = this;
        let storage = host.component(owner, "Storage");
        if (!storage) {
            const was = this.dropped.get(`${owner} Storage`);
            storage = was && !host.components(owner).includes(was.item) ? was.item : this.newComponent("Storage", [["storedItems", map([])]]);
            host.insertComponent(owner, storage, this.componentAt(owner, "Storage", pack));
        }
        const fields = asMap(storage.value)!;
        let items = entryOf(fields, "storedItems");
        if (!items) {
            items = { key: scalar("storedItems"), value: map([]) };
            this.addEntry(fields, items, fields.entries.length);
        }
        const list = this.ensure(items, "map") as YMap;
        const old = list.entries.find((e) => Number(e.key.value) === uid);
        if (old) this.removeEntry(list, old);
        const removed = this.holes(list).find((h) => Number(h.removed.key.value) === uid)?.removed;
        const entry: YEntry = removed && sameLocation(readLocation(removed.value), location)
            ? removed
            : { key: scalar(String(uid)), value: map([["position", scalar(`${location.x},${location.y}`)], ["_rotation", scalar(location.rotation)]]) };
        this.addEntry(list, entry, list.entries.length);
        host.touch(owner, storage, items);
    }

    private removeStored(owner: number, uid: number): void {
        const storage = this.host.component(owner, "Storage");
        const fields = asMap(storage?.value);
        const items = fields && entryOf(fields, "storedItems");
        const list = asMap(items?.value);
        const entry = list?.entries.find((e) => Number(e.key.value) === uid);
        if (!storage || !fields || !items || !list || !entry) {
            this.unplaced.add(`${owner} ${uid}`);
            return;
        }
        this.removeEntry(list, entry);
        if (list.entries.length) return this.host.touch(owner, storage, items);
        // emptied: the default, left out (with the component when nothing else is in it)
        const others = fields.entries.filter((e) => e !== items && e.key.value !== "type");
        if (!others.length) this.dropComponent(owner, "Storage");
        else if (others.some((e) => isEmptyValue(e.value))) this.host.touch(owner, storage, items);
        else {
            this.removeEntry(fields, items);
            this.host.touch(owner, storage);
        }
    }

    // -----------------------------------------------------------------------------------------
    // The stored entity

    /** Writes an entity as stored in `owner`: Transform parent only, no collision, InsideEntityStorage in lockers. */
    private store(uid: number, owner: number, role: ContainerRole, pack: ContainerPack | undefined): void {
        this.setTransform(uid, owner, null, pack);
        if (this.hasPhysics(this.protoId(uid, pack), uid, pack) && !this.colliding.has(`${owner} ${uid}`)) this.setNoCollide(uid, pack);
        if (this.host.component(uid, "InsideEntityStorage")) return;
        // put back where it was taken from: as it was (with or without InsideEntityStorage)
        const was = this.dropped.get(`${uid} InsideEntityStorage`);
        const back = was && was.owner === owner && !this.host.components(uid).includes(was.item) ? was.item : undefined;
        if (back) this.host.insertComponent(uid, back, this.componentAt(uid, "InsideEntityStorage", pack));
        else if (role === "entityStorage" && this.habit().inside && !this.bare.has(`${owner} ${uid}`)) {
            // the game adds it, so it comes last
            this.host.insertComponent(uid, this.insideItem(owner, pack), this.host.componentTypes(uid).length);
        }
    }

    /** Drops what only a stored entity has (InsideEntityStorage first: put back, it comes after Physics again). */
    private unstore(uid: number): void {
        const owner = this.host.transform(uid).parent ?? undefined;
        if (this.host.component(uid, "InsideEntityStorage")) this.dropComponent(uid, "InsideEntityStorage", owner);
        else this.bare.add(`${owner} ${uid}`);
        const physics = this.host.component(uid, "Physics");
        const fields = asMap(physics?.value);
        const collide = fields && entryOf(fields, "canCollide");
        if (!collide) this.colliding.add(`${owner} ${uid}`);
        if (physics && fields && collide) {
            if (fields.entries.every((e) => e === collide || e.key.value === "type")) this.dropComponent(uid, "Physics");
            else {
                this.removeEntry(fields, collide);
                this.host.touch(uid, physics);
            }
        }
    }

    /** A component item, its keys in order in maps that write them so. */
    private newComponent(type: string, fields: Array<[string, YNode]> = []): YItem {
        const item = component(type, fields);
        if (this.habit().sorted) (item.value as YMap).entries = sortEntries((item.value as YMap).entries);
        return item;
    }

    private insideItem(owner: number, pack: ContainerPack | undefined): YItem {
        const field = pack?.insideStorageField ?? this.habit().insideStorage;
        return this.newComponent("InsideEntityStorage", field ? [["storage", scalar(String(owner))]] : []);
    }

    private setNoCollide(uid: number, pack: ContainerPack | undefined): void {
        const { host } = this;
        const physics = host.component(uid, "Physics");
        if (!physics) {
            const was = this.dropped.get(`${uid} Physics`);
            const item = was && !host.components(uid).includes(was.item) ? was.item : this.newComponent("Physics", [["canCollide", bool(false)]]);
            host.insertComponent(uid, item, this.componentAt(uid, "Physics", pack));
            return;
        }
        const fields = asMap(physics.value)!;
        const collide = entryOf(fields, "canCollide");
        if (collide) {
            if (text(collide.value) === "False") return;
            host.journal.set(collide, "value", scalar("False"));
            host.touch(uid, physics, collide);
            return;
        }
        // with the Physics fields the game writes around it (`linearDamping, canCollide`, `canCollide, bodyType`)
        const keys = fields.entries.map((e) => e.key.value);
        const after = keys.indexOf("linearDamping");
        const before = keys.findIndex((k) => k === "fixedRotation" || k === "bodyType");
        const removed = this.holes(fields).find((h) => h.removed.key.value === "canCollide")?.removed;
        this.addEntry(fields, removed && text(removed.value) === "False" ? removed : { key: scalar("canCollide"), value: bool(false) }, after !== -1 ? after + 1 : before !== -1 ? before : keys.length);
        host.touch(uid, physics);
    }

    /**
     * Transform as the game writes it: `parent` alone inside a container (and `anchored: False` when the prototype
     * anchors it), with `pos` (and `rot`) on the map.
     */
    private setTransform(uid: number, parent: number, place: MapPlace | null, pack?: ContainerPack): void {
        const { host } = this;
        const item = host.component(uid, "Transform");
        if (!item) throw new Error(`Entity ${uid} has no transform`);
        const fields = asMap(item.value)!;
        const p: YEntry = { key: scalar("parent"), value: scalar(String(parent)) };
        let entries: YEntry[];
        if (place) {
            const rot = host.formatRotation(place.rotation ?? 0);
            const r: YEntry[] = rot ? [{ key: scalar("rot"), value: scalar(rot) }] : [];
            const pos: YEntry = { key: scalar("pos"), value: scalar(host.formatPosition(place.x, place.y)) };
            const type = fields.entries.filter((e) => e.key.value === "type");
            const rest = fields.entries.filter((e) => !["type", "parent", "pos", "rot"].includes(e.key.value));
            entries = [...type, ...(host.parentFirst ? [p, ...r, pos] : [...r, pos, p]), ...rest];
        } else {
            // a stored entity is never anchored: the field goes, or says so where the prototype anchors it
            const anchors = isTrue(this.full(uid, pack)?.Transform?.anchored ?? false);
            const unanchored: YEntry = { key: scalar("anchored"), value: bool(false) };
            entries = [];
            for (const e of fields.entries) {
                const key = e.key.value;
                if (key === "parent") entries.push(p);
                else if (key === "anchored") {
                    if (anchors) entries.push(text(e.value) === "False" ? e : unanchored);
                } else if (key !== "pos" && key !== "rot") entries.push(e);
            }
            if (!entries.includes(p)) entries.splice(entries[0]?.key.value === "type" ? 1 : 0, 0, p);
            if (anchors && !entries.some((e) => e.key.value === "anchored")) entries.push(unanchored);
        }
        // in the engine's field order: `parent, rot, pos, anchored` (newer) or `anchored, rot, pos, parent`
        const order = host.parentFirst ? ["parent", "rot", "pos", "anchored"] : ["anchored", "rot", "pos", "parent"];
        const rank = (e: YEntry) => (e.key.value === "type" ? -1 : order.includes(e.key.value) ? order.indexOf(e.key.value) : order.length);
        entries = entries.map((e, i) => [e, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
        // old saves write every mapping's keys in order, `type` included
        if (fields.entries[0]?.key.value !== "type") entries = sortEntries(entries);
        host.journal.set(fields, "entries", entries);
        host.touch(uid, item);
        host.reparent(uid);
    }

    private placeOnMap(uid: number, to: MapPlace): void {
        this.setTransform(uid, to.grid, to);
    }

    // -----------------------------------------------------------------------------------------
    // Prototype data

    private protoId(uid: number, pack: ContainerPack | undefined): string {
        const p = this.host.proto(uid) ?? "";
        return (pack?.migrate ? pack.migrate(p) : p) ?? "";
    }

    /** Components of an entity's prototype with inheritance applied, or null without prototype data. */
    private full(uid: number, pack: ContainerPack | undefined): Components | null {
        return this.fullOf(this.protoId(uid, pack), pack);
    }

    private fullOf(id: string, pack: ContainerPack | undefined): Components | null {
        const data = pack?.data;
        if (!data || !data.entities[id]) return null;
        let cache = this.resolved.get(data);
        if (!cache) this.resolved.set(data, (cache = new Map()));
        return resolveComponents(data, id, cache);
    }

    /** Whether a stored entity gets `canCollide: False`: it has physics that collide (unknown: assumed). */
    private hasPhysics(proto: string, uid: number | null, pack: ContainerPack | undefined): boolean {
        if (uid !== null && this.host.component(uid, "Physics")) return true;
        if (!pack?.data) return true;
        const full = this.fullOf(proto, pack);
        if (!full) return false;
        return "Physics" in full && !isFalse(full.Physics!.canCollide ?? true);
    }

    private capacity(owner: number, pack: ContainerPack | undefined): number {
        const own = Number(text(get(this.host.component(owner, "EntityStorage")?.value, "capacity")));
        if (Number.isFinite(own)) return own;
        const proto = Number(this.full(owner, pack)?.EntityStorage?.capacity);
        return Number.isFinite(proto) ? proto : DEFAULT_ENTITY_STORAGE_CAPACITY;
    }

    private isOpen(owner: number, pack: ContainerPack | undefined): boolean {
        const own = text(get(this.host.component(owner, "EntityStorage")?.value, "open"));
        if (own !== undefined) return isTrue(own);
        return isTrue(this.full(owner, pack)?.EntityStorage?.open ?? false);
    }

    /**
     * Component order of a prototype as the game builds the entity: its own components in order, then each
     * parent's that it lacks (saved maps list components in this order, those added at runtime after).
     */
    private engineOrder(id: string, data: PrototypeData): string[] {
        let cache = this.orders.get(data);
        if (!cache) this.orders.set(data, (cache = new Map()));
        const done = cache.get(id);
        if (done) return done;
        const out: string[] = [];
        cache.set(id, out);
        const p = data.entities[id];
        if (!p) return out;
        out.push(...Object.keys(p.components));
        for (const parent of p.parents ?? []) for (const t of this.engineOrder(parent, data)) if (!out.includes(t)) out.push(t);
        return out;
    }

    // -----------------------------------------------------------------------------------------
    // Writing helpers

    /**
     * Where a component goes: where it was if this removed it, else after the components that precede it on most
     * entities of the prototype that have it, else in the prototype's order, else after the transform.
     */
    private componentAt(uid: number, type: string, pack: ContainerPack | undefined): number {
        const types = this.host.componentTypes(uid);
        const first = types[0] === "MetaData" ? 1 : 0;
        const head = first + (types[first] === "Transform" ? 1 : 0);
        let at = head;
        const was = this.dropped.get(`${uid} ${type}`);
        if (was) {
            types.forEach((t, i) => {
                if (was.before.includes(t)) at = Math.max(at, i + 1);
            });
            return at;
        }
        const siblings = this.host.siblingTypes(uid).filter((s) => s.includes(type));
        if (siblings.length) {
            for (let i = head; i < types.length; i++) {
                let before = 0, after = 0;
                for (const s of siblings) {
                    const k = s.indexOf(types[i]!);
                    if (k !== -1) k < s.indexOf(type) ? before++ : after++;
                }
                if (before > after) at = i + 1;
            }
            return at;
        }
        const data = pack?.data;
        const id = this.protoId(uid, pack);
        if (data?.entities[id]) {
            const order = this.engineOrder(id, data);
            const rank = order.indexOf(type);
            if (rank === -1) return types.length;
            for (let i = head; i < types.length; i++) {
                const k = order.indexOf(types[i]!);
                if (k !== -1 && k < rank) at = i + 1;
            }
            return at;
        }
        return type === "Physics" ? head : types.length;
    }

    private dropComponent(uid: number, type: string, owner?: number): void {
        const types = this.host.componentTypes(uid);
        const item = this.host.component(uid, type);
        if (!item) return;
        this.dropped.set(`${uid} ${type}`, { before: types.slice(0, types.indexOf(type)), item, owner });
        this.host.dropComponent(uid, type);
    }

    private removeEntry(owner: YMap, entry: YEntry): void {
        const at = owner.entries.indexOf(entry);
        if (at === -1) return;
        const holes = this.holes(owner);
        this.host.journal.splice(owner, "entries", at, 1);
        this.freed.set(owner, { list: owner.entries, holes: [...holes, { at, removed: entry }] });
    }

    /** Adds an entry: into the slot freed last when the mapping has not changed since, else at `at`. */
    private addEntry(owner: YMap, entry: YEntry, at: number): void {
        const holes = this.holes(owner);
        const hole = holes.pop();
        this.host.journal.splice(owner, "entries", hole ? hole.at : at, 0, entry);
        if (holes.length) this.freed.set(owner, { list: owner.entries, holes });
        else this.freed.delete(owner);
    }

    /** The freed slots of a mapping still valid (it has not changed since), last freed last. */
    private holes(owner: YMap): Array<{ at: number; removed: YEntry }> {
        const record = this.freed.get(owner);
        return record && record.list === owner.entries ? [...record.holes] : [];
    }

    /** The mapping or sequence of an entry, replacing an empty flow value or null with an empty one. */
    private ensure(entry: YEntry, kind: "map" | "seq"): YMap | YSeq {
        if (entry.value.kind === kind) return entry.value;
        if (entry.value.kind !== "scalar" || !isEmptyValue(entry.value)) throw new Error(`"${entry.key.value}" is not a ${kind === "map" ? "mapping" : "sequence"}`);
        const node = kind === "map" ? map([]) : seq([]);
        this.host.journal.set(entry, "value", node);
        return node;
    }

    /** How the map writes emptied containers, read once per edit when first needed. */
    /** Reads the map's habits ahead of the first edit (each is a scan of every entity). */
    prepare(): void {
        this.habit();
        this.styleOnce()();
    }

    /** How the map writes empty containers, read once (a scan of every entity; edits follow it, so it holds). */
    private emptyStyle?: EmptyStyle;

    private styleOnce(): () => EmptyStyle {
        return () => (this.emptyStyle ??= emptyStyle(this.host, this.host.uids()));
    }

    private isInside(uid: number, ancestor: number): boolean {
        let p = this.host.transform(uid).parent;
        for (let i = 0; p !== null && i < 64; i++) {
            if (p === ancestor) return true;
            if (!this.host.has(p)) return false;
            p = this.host.transform(p).parent;
        }
        return false;
    }

    private kindOf(id: string, entry: YEntry | undefined, def: ContainerDef | undefined, role: ContainerRole | undefined): ContainerKind {
        const tag = entry?.value.tag;
        if (tag) return tag === "!type:ContainerSlot" ? "ContainerSlot" : "Container";
        if (entry) return entryOf(asMap(entry.value)!, "ent") ? "ContainerSlot" : "Container";
        const t = def?.["!type"];
        if (typeof t === "string") return t === "ContainerSlot" ? "ContainerSlot" : "Container";
        const seen = this.habit().kinds.get(id);
        if (seen) return seen;
        return role === "itemSlot" ? "ContainerSlot" : "Container";
    }

    /** What the map shows of its engine: container kinds by id, field layouts, InsideEntityStorage forms. */
    private habit() {
        if (this.habits) return this.habits;
        const kinds = new Map<string, Map<ContainerKind, number>>();
        const layouts: Record<ContainerKind, Record<Layout, number>> = { Container: { entsFirst: 0, flagsFirst: 0, bare: 0 }, ContainerSlot: { entsFirst: 0, flagsFirst: 0, bare: 0 } };
        let stored = 0, inside = 0, storage = 0, sorted = 0, typeFirst = 0;
        for (const uid of this.host.uids()) {
            for (const c of this.host.components(uid)) {
                const keys = (asMap(c.value)?.entries ?? []).map((e) => e.key.value);
                if (keys.length > 1) keys[0] === "type" ? typeFirst++ : sorted++;
            }
            const ies = this.host.component(uid, "InsideEntityStorage");
            if (ies && get(ies.value, "storage")) storage++;
            for (const e of this.boxEntries(uid)) {
                const kind: ContainerKind = e.value.tag === "!type:ContainerSlot" ? "ContainerSlot" : "Container";
                const byKind = kinds.get(e.key.value) ?? new Map<ContainerKind, number>();
                kinds.set(e.key.value, byKind.set(kind, (byKind.get(kind) ?? 0) + 1));
                const keys = (asMap(e.value)?.entries ?? []).map((x) => x.key.value);
                const field = kind === "ContainerSlot" ? "ent" : "ents";
                if (keys.length === 1 && keys[0] === field) layouts[kind].bare++;
                else if (keys.includes(field) && keys.includes("showEnts")) layouts[kind][keys.indexOf(field) < keys.indexOf("showEnts") ? "entsFirst" : "flagsFirst"]++;
                if (e.key.value !== "entity_storage") continue;
                for (const c of contentsOf(e)) {
                    if (!this.host.has(c)) continue;
                    stored++;
                    if (this.host.component(c, "InsideEntityStorage")) inside++;
                }
            }
        }
        const fallback: Layout = this.host.parentFirst ? "entsFirst" : "flagsFirst";
        const pick = (n: Record<Layout, number>): Layout => {
            const best = (["entsFirst", "flagsFirst", "bare"] as const).reduce((a, b) => (n[b] > n[a] ? b : a));
            return n[best] ? best : fallback;
        };
        this.habits = {
            kinds: new Map([...kinds].map(([id, n]) => [id, (n.get("ContainerSlot") ?? 0) > (n.get("Container") ?? 0) ? "ContainerSlot" : "Container"])),
            layout: { Container: pick(layouts.Container), ContainerSlot: pick(layouts.ContainerSlot) },
            // maps saved before InsideEntityStorage was written have none on their stored entities
            inside: !stored || inside > 0,
            insideStorage: storage > 0,
            sorted: sorted > typeFirst,
        };
        return this.habits;
    }
}

const sortEntries = (entries: YEntry[]) => [...entries].sort((a, b) => (a.key.value < b.key.value ? -1 : a.key.value > b.key.value ? 1 : 0));

/** Slots the game fills itself: solutions, toggled clothing, the inventory of mobs. */
function gameSlot(id: string, full: Components | null): boolean {
    return id.startsWith("solution@") || id === "toggleable-clothing" || !!full?.Inventory;
}

const isEmptyValue = (node: YNode) => (node.kind === "scalar" ? /^(\[\s*\]|\{\s*\}|~|null)?$/.test(node.value.trim()) : node.kind === "seq" ? !node.items.length : !node.entries.length);

function contentsOf(entry: YEntry): number[] {
    const box = asMap(entry.value);
    const ent = text(get(box, "ent"));
    if (isUid(ent)) return [Number(ent)];
    return (asSeq(get(box, "ents"))?.items ?? []).map((i) => text(i.value)).filter(isUid).map(Number);
}

function containerDefs(full: Components | null): Record<string, ContainerDef> {
    const defs = full?.ContainerContainer?.containers;
    return defs && typeof defs === "object" ? (defs as Record<string, ContainerDef>) : {};
}

/** Containers the owner's components hold: EntityStorage, Storage, item slots. */
function rolesOf(full: Components | null): Map<string, ContainerRole> {
    const roles = new Map<string, ContainerRole>();
    if (!full) return roles;
    if (full.EntityStorage) roles.set("entity_storage", "entityStorage");
    if (full.Storage) roles.set("storagebase", "storage");
    if (full.PaperLabel) roles.set("paper_label", "itemSlot");
    const slots = full.ItemSlots?.slots;
    if (slots && typeof slots === "object") for (const id of Object.keys(slots)) roles.set(id, "itemSlot");
    return roles;
}

/** Without prototype data, the containers named by the game's systems. */
function fallbackRole(id: string, full: Components | null): ContainerRole {
    if (full) return "other";
    return id === "entity_storage" ? "entityStorage" : id === "storagebase" ? "storage" : "other";
}

function readLocation(node: YNode): StorageLocation | undefined {
    const [x, y] = (text(get(node, "position")) ?? "").split(",").map(Number);
    const rotation = (text(get(node, "_rotation")) ?? "South") as StorageRotation;
    if (!Number.isInteger(x) || !Number.isInteger(y) || !ROTATIONS.includes(rotation)) return undefined;
    return { x: x!, y: y!, rotation };
}

const sameLocation = (a: StorageLocation | undefined, b: StorageLocation) => !!a && a.x === b.x && a.y === b.y && a.rotation === b.rotation;

// ---------------------------------------------------------------------------------------------
// Storage grids (SharedStorageSystem, SharedItemSystem.GetAdjustedItemShape)

/** A Box2i as written in prototypes ("0,0,6,3"). */
export function parseBox(s: string): Box {
    const n = s.split(",").map((v) => Number(v.trim()));
    if (n.length !== 4 || n.some((v) => !Number.isInteger(v))) throw new Error(`Not a box: ${s}`);
    return n as unknown as Box;
}

const turn = (x: number, y: number, q: number): [number, number] => (q === 1 ? [-y, x] : q === 2 ? [-x, -y] : q === 3 ? [y, -x] : [x, y]);

function turnBox(b: Box, q: number): Box {
    const [ax, ay] = turn(b[0], b[1], q), [bx, by] = turn(b[2], b[3], q);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

function bounds(boxes: readonly Box[]): Box {
    return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

/** An item's shape turned and moved to a place in the grid: turned around its bounds, kept at their corner. */
export function placedShape(shape: readonly Box[], location: StorageLocation): Box[] {
    const q = ROTATIONS.indexOf(location.rotation);
    const whole = bounds(shape);
    const turned = turnBox(whole, q);
    const dx = whole[0] - turned[0] + location.x, dy = whole[1] - turned[1] + location.y;
    return shape.map((b) => {
        const t = turnBox(b, q);
        return [t[0] + dx, t[1] + dy, t[2] + dx, t[3] + dy];
    });
}

function* cells(boxes: readonly Box[]): Generator<[number, number]> {
    for (const b of boxes) for (let x = b[0]; x <= b[2]; x++) for (let y = b[1]; y <= b[3]; y++) yield [x, y];
}

const inGrid = (grid: readonly Box[], x: number, y: number) => grid.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);

function occupiedBy(stored: ReadonlyArray<{ shape: readonly Box[]; location: StorageLocation }>): Set<string> {
    const out = new Set<string>();
    for (const s of stored) for (const [x, y] of cells(placedShape(s.shape, s.location))) out.add(`${x},${y}`);
    return out;
}

function fitsCells(grid: readonly Box[], occupied: ReadonlySet<string>, placed: readonly Box[]): boolean {
    for (const [x, y] of cells(placed)) if (!inGrid(grid, x, y) || occupied.has(`${x},${y}`)) return false;
    return true;
}

/** Whether an item fits at a place of a grid holding `stored` (`ItemFitsInGridLocation`). */
export function fitsInStorage(grid: readonly Box[], stored: ReadonlyArray<{ shape: readonly Box[]; location: StorageLocation }>, shape: readonly Box[], location: StorageLocation): boolean {
    if (!grid.length || !shape.length) return false;
    const b = bounds(grid);
    if (location.x < b[0] || location.x > b[2] || location.y < b[1] || location.y > b[3]) return false;
    return fitsCells(grid, occupiedBy(stored), placedShape(shape, location));
}

/**
 * The first place an item fits, as `TryGetAvailableGridSpace` searches: chunk by chunk of 8×8 cells (chunk
 * columns, then rows, as the engine's chunk enumerator goes), each row from the bottom (the top of the grid in
 * the game's window), cells from the left; at each cell the default rotation, then a quarter turn for an oblong
 * item (every turn for an item of several boxes). Null when it fits nowhere.
 */
export function findStorageSpot(
    grid: readonly Box[],
    shape: readonly Box[],
    stored: ReadonlyArray<{ shape: readonly Box[]; location: StorageLocation }> = [],
    orientation?: "Horizontal" | "Vertical" | null,
): StorageLocation | null {
    if (!grid.length || !shape.length) return null;
    const b = bounds(grid);
    let start = 0;
    if (orientation) start = b[2] - b[0] < b[3] - b[1] ? (orientation === "Horizontal" ? 0 : 1) : orientation === "Vertical" ? 0 : 1;
    const turns: number[] = [];
    if (shape.length === 1) {
        turns.push(start);
        if (shape[0]![2] - shape[0]![0] !== shape[0]![3] - shape[0]![1]) turns.push(start + 1);
    } else for (let q = start; q <= 4 - start; q++) turns.push(q % 4);
    const occupied = occupiedBy(stored);
    const chunk = (v: number) => Math.floor(v / STORAGE_CHUNK);
    for (let cx = chunk(b[0]); cx <= chunk(b[2]); cx++) {
        for (let cy = chunk(b[1]); cy <= chunk(b[3]); cy++) {
            const left = Math.max(cx * STORAGE_CHUNK, b[0]), right = Math.min(cx * STORAGE_CHUNK + STORAGE_CHUNK - 1, b[2]);
            const bottom = Math.max(cy * STORAGE_CHUNK, b[1]), top = Math.min(cy * STORAGE_CHUNK + STORAGE_CHUNK - 1, b[3]);
            // the game keeps no cells for a chunk outside the grid
            if (!grid.some((g) => g[0] <= right && g[2] >= left && g[1] <= top && g[3] >= bottom)) continue;
            for (let y = bottom; y <= top; y++) {
                for (let x = left; x <= right; x++) {
                    for (const q of turns) {
                        const location: StorageLocation = { x, y, rotation: ROTATIONS[q % 4]! };
                        if (fitsCells(grid, occupied, placedShape(shape, location))) return location;
                    }
                }
            }
        }
    }
    return null;
}
