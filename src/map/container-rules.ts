// The game's checks for putting an entity into a container, evaluated on prototypes: EntityStorage (whitelist,
// blacklist, bounds against MaxSize), Storage (whitelist, item size, nested storage, grid) and item slots
// (whitelist, blacklist, locked). Pure: built from the pack's prototype data and container rules; the pack
// knows nothing of a map's own component overrides, so these are the checks for the prototypes alone.
//
// Sources (SharedEntityStorageSystem.CanInsert, SharedStorageSystem.CanInsert, ItemSlotsSystem.CanInsert,
// EntityWhitelistSystem.IsValid, SharedItemSystem): the whitelist matches by component names, item sizes and tags
// (`requireAll` turns the component and tag tests into "all"); a prototype's tags are its Tag component's, its
// components those of the prototype with parents applied; stored items need an Item component.
import type { ContainerRules, EntityPrototype, PrototypeData, WhitelistData } from "../pack/format";
import { resolveComponents, type Components } from "../pack/prototype-data";
import { parseBox, type Box, type InsertOptions, type StorageGeometry } from "./containers";

export interface ContainerRulesSource {
    data: PrototypeData;
    rules: ContainerRules;
    /** `Pack.prototypes.entities`: Filled prototypes and their plain bases. */
    entities?: Record<string, Pick<EntityPrototype, "fills" | "plainBase">>;
    /** Current id of a prototype a map names (`Pack.migrate`). */
    migrate?(id: string): string | null;
}

/** What the rules need of a map: the prototype of an entity (`MapDocument` has it). */
export interface ContainerRulesHost {
    proto(uid: number): string | undefined;
}

type Fields = Record<string, unknown>;

const isObject = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
const isTrue = (v: unknown) => v === true || /^true$/i.test(String(v));
const number = (v: unknown): number | undefined => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));

/** The container id of PaperLabel's slot (LabelSystem). */
const PAPER_LABEL = "paper_label";

export class ContainerRulesEngine {
    private readonly cache = new Map<string, Components>();

    constructor(private readonly src: ContainerRulesSource) {}

    /** The id of a prototype as the pack knows it, or null (unknown or deleted by a migration). */
    resolve(proto: string): string | null {
        const id = this.src.migrate ? this.src.migrate(proto) : proto;
        return id !== null && this.src.data.entities[id] ? id : null;
    }

    /** Components of a prototype with parents applied. */
    components(proto: string): Components {
        const id = this.resolve(proto);
        return id === null ? {} : resolveComponents(this.src.data, id, this.cache);
    }

    /** Tags of the prototype's Tag component. */
    tags(proto: string): string[] {
        return strings(this.components(proto).Tag?.tags);
    }

    // -----------------------------------------------------------------------------------------
    // Filled prototypes

    /** Whether the game fills the prototype's containers when a map starts, and the prototype without the fill. */
    fill(proto: string): { fills: boolean; plainBase?: string } {
        const id = this.resolve(proto);
        const e = id === null ? undefined : this.src.entities?.[id];
        return e?.fills ? { fills: true, ...(e.plainBase ? { plainBase: e.plainBase } : {}) } : { fills: false };
    }

    // -----------------------------------------------------------------------------------------
    // Items

    /** Size id of an item prototype (`Item.size`, else the game's default), or null when it is no item. */
    itemSize(proto: string): string | null {
        const item = this.components(proto).Item;
        if (!item) return null;
        return typeof item.size === "string" ? item.size : this.src.rules.defaultItemSize;
    }

    /** Weight of an item size (larger is bigger); unknown sizes count as 0. */
    sizeWeight(size: string): number {
        return this.src.rules.itemSizes[size]?.weight ?? 0;
    }

    /** Shape of an item prototype in storage grids (`Item.shape`, else its size's default), or null for non-items. */
    itemShape(proto: string): Box[] | null {
        const item = this.components(proto).Item;
        if (!item) return null;
        const own = Array.isArray(item.shape) ? item.shape.map(String) : null;
        const size = this.itemSize(proto)!;
        const boxes = own ?? this.src.rules.itemSizes[size]?.shape ?? [];
        try {
            return boxes.map(parseBox);
        } catch {
            return null;
        }
    }

    // -----------------------------------------------------------------------------------------
    // Whitelists

    /** `EntityWhitelistSystem.IsValid`: whether a prototype is on the list. */
    matches(list: WhitelistData | Fields, proto: string): boolean {
        const components = this.components(proto);
        const all = isTrue(list.requireAll);
        for (const name of strings(list.components)) {
            if (name in components) {
                if (!all) return true;
            } else if (all) return false;
        }
        const sizes = strings(list.sizes);
        if (list.sizes !== undefined && list.sizes !== null) {
            const size = this.itemSize(proto);
            if (size !== null && sizes.includes(size)) return true;
        }
        if (list.tags !== undefined && list.tags !== null) {
            const tags = this.tags(proto);
            const wanted = strings(list.tags);
            return all ? wanted.every((t) => tags.includes(t)) : wanted.some((t) => tags.includes(t));
        }
        return all;
    }

    /** Whitelist and blacklist as the game combines them: the blacklist wins, a missing whitelist admits everything. */
    private passes(proto: string, whitelist: unknown, blacklist: unknown): boolean {
        if (isObject(blacklist) && this.matches(blacklist, proto)) return false;
        return !isObject(whitelist) || this.matches(whitelist, proto);
    }

    // -----------------------------------------------------------------------------------------
    // EntityStorage

    /** Width and height of a prototype's bounds (0 for those at most `boundsFloor` across: unknown). */
    bounds(proto: string): [number, number] {
        const id = this.resolve(proto);
        return (id !== null && this.src.rules.bounds[id]) || [0, 0];
    }

    /** `EntityStorageComponent.MaxSize` of an owner prototype. */
    entityStorageMaxSize(owner: string): number {
        return number(this.components(owner).EntityStorage?.maxSize) ?? this.src.rules.entityStorage.maxSize;
    }

    /** `EntityStorageComponent.Capacity` of an owner prototype. */
    entityStorageCapacity(owner: string): number {
        return number(this.components(owner).EntityStorage?.capacity) ?? this.src.rules.entityStorage.capacity;
    }

    /** Whether the prototype's bounds are within the owner's `maxSize` (unknown bounds count as fitting). */
    entityFits(item: string, owner: string): boolean {
        const max = this.entityStorageMaxSize(owner);
        const [w, h] = this.bounds(item);
        return !(max < w || max < h);
    }

    /** Why an entity of a prototype cannot go into a prototype's EntityStorage (not counting capacity and open), or null. */
    entityStorageRefusal(item: string, owner: string): string | null {
        const storage = this.components(owner).EntityStorage;
        if (!storage) return `${owner} has no entity storage`;
        if (!this.entityFits(item, owner)) return `${item} is too big for ${owner}`;
        const { rules } = this.src;
        const whitelist = isObject(storage.whitelist) ? storage.whitelist : rules.entityStorage.whitelist;
        const blacklist = rules.entityStorage.blacklist ? storage.blacklist : null;
        return this.passes(item, whitelist, blacklist) ? null : `${owner} does not take ${item}`;
    }

    // -----------------------------------------------------------------------------------------
    // Storage

    /** `GetMaxItemSize`: Storage.maxItemSize, else one size below the owner's own item size, else the default. */
    storageMaxItemSize(owner: string): string {
        const comps = this.components(owner);
        const own = comps.Storage?.maxItemSize;
        const { rules } = this.src;
        if (typeof own === "string" && rules.itemSizes[own]) return own;
        const size = this.itemSize(owner);
        if (size === null) return rules.defaultStorageMaxItemSize;
        const sorted = Object.entries(rules.itemSizes).sort((a, b) => a[1].weight - b[1].weight).map(([id]) => id);
        const at = sorted.indexOf(size);
        return at > 0 ? sorted[at - 1]! : sorted[0] ?? size;
    }

    /** Grid of a storage prototype. */
    storageGrid(owner: string): Box[] {
        try {
            return strings(this.components(owner).Storage?.grid).map(parseBox);
        } catch {
            return [];
        }
    }

    /** Why a prototype cannot go into a prototype's Storage (not counting room in the grid), or null. */
    storageRefusal(item: string, owner: string): string | null {
        const comps = this.components(owner);
        const storage = comps.Storage;
        if (!storage) return `${owner} has no storage`;
        const size = this.itemSize(item);
        if (size === null) return `${item} is not an item`;
        const itemComps = this.components(item);
        if (isTrue(itemComps.Transform?.anchored)) return `${item} is anchored`;
        if (!this.passes(item, storage.whitelist, storage.blacklist)) return `${owner} does not take ${item}`;
        const max = this.storageMaxItemSize(owner);
        if (this.sizeWeight(size) > this.sizeWeight(max)) return `${item} is too big for ${owner}`;
        if (itemComps.Storage && this.sizeWeight(this.storageMaxItemSize(item)) >= this.sizeWeight(max)) return `${item} is too big for ${owner}`;
        return null;
    }

    /** Grid, item shape and orientation for placing an item prototype in a storage prototype, or null without them. */
    geometry(item: string, owner: string, shapeOf?: (uid: number) => readonly Box[] | null): StorageGeometry | null {
        const grid = this.storageGrid(owner);
        const shape = this.itemShape(item);
        if (!grid.length || !shape) return null;
        const o = this.components(owner).Storage?.defaultStorageOrientation;
        return { grid, shape, shapeOf, orientation: o === "Horizontal" || o === "Vertical" ? o : null };
    }

    // -----------------------------------------------------------------------------------------
    // Item slots

    /** The slot definition of a container id: `ItemSlots.slots.<id>` or PaperLabel's `labelSlot`. */
    slot(owner: string, id: string): Fields | null {
        const comps = this.components(owner);
        const slots = comps.ItemSlots?.slots;
        if (isObject(slots) && id in slots) return isObject(slots[id]) ? slots[id] : {};
        if (id === PAPER_LABEL && comps.PaperLabel) return isObject(comps.PaperLabel.labelSlot) ? comps.PaperLabel.labelSlot : {};
        return null;
    }

    /** Why a prototype cannot go into an item slot, or null. */
    slotRefusal(item: string, owner: string, id: string): string | null {
        const slot = this.slot(owner, id);
        if (!slot) return `${owner} has no slot ${id}`;
        if (isTrue(slot.locked)) return `${id} is locked`;
        return this.passes(item, slot.whitelist, slot.blacklist) ? null : `${item} does not fit in ${id}`;
    }

    // -----------------------------------------------------------------------------------------
    // For src/map/containers.ts

    /**
     * Why a prototype cannot go into container `id` of a prototype, or null. Containers the checks do not know
     * (the game's own: ammunition, solutions...) are not judged here.
     */
    refusal(item: string, owner: string, id: string): string | null {
        const proto = this.resolve(item);
        if (proto === null) return `Unknown prototype ${item}`;
        const ownerId = this.resolve(owner);
        if (ownerId === null) return null;
        const comps = this.components(ownerId);
        if (id === "entity_storage" && comps.EntityStorage) return this.entityStorageRefusal(proto, ownerId);
        if (id === "storagebase" && comps.Storage) return this.storageRefusal(proto, ownerId);
        if (this.slot(ownerId, id)) return this.slotRefusal(proto, ownerId, id);
        return null;
    }

    /** `InsertOptions.allow` for a map: looks the owner's prototype up in the document. */
    allow(host: ContainerRulesHost): NonNullable<InsertOptions["allow"]> {
        return (proto, owner, id) => {
            const ownerProto = host.proto(owner);
            return (ownerProto === undefined ? null : this.refusal(proto, ownerProto, id)) ?? true;
        };
    }

    /**
     * `allow` and, for a storage, `geometry` for putting an item (an entity of the map or a new one of a prototype)
     * into container `id` of `owner`. `shapeOf` gives the shapes of the items already inside, by uid.
     */
    insertOptions(host: ContainerRulesHost, owner: number, id: string, item: number | { proto: string }): Pick<InsertOptions, "allow" | "geometry"> {
        const out: Pick<InsertOptions, "allow" | "geometry"> = { allow: this.allow(host) };
        const ownerProto = host.proto(owner);
        const itemProto = typeof item === "number" ? host.proto(item) : item.proto;
        const ownerId = ownerProto === undefined ? null : this.resolve(ownerProto);
        const itemId = itemProto === undefined ? null : this.resolve(itemProto);
        if (ownerId !== null && itemId !== null && id === "storagebase") {
            const geometry = this.geometry(itemId, ownerId, (uid) => {
                const p = host.proto(uid);
                return p === undefined ? null : this.itemShape(p);
            });
            if (geometry) out.geometry = geometry;
        }
        return out;
    }
}

/** Builds the rules from a pack's data (`Pack.prototypeData()`, `Pack.containerRules()`), or null when the pack has none. */
export function containerRules(source: Omit<Partial<ContainerRulesSource>, "data" | "rules"> & { data?: PrototypeData | null; rules?: ContainerRules | null }): ContainerRulesEngine | null {
    return source.data && source.rules ? new ContainerRulesEngine({ ...source, data: source.data, rules: source.rules }) : null;
}
