// Putting entities into containers from the editor, without DOM: the pack's checks (map/container-rules.ts) with the
// document's container edits (map/containers.ts). Which container a drop goes into, several copies in one undo
// step, where an entity taken out lands (the nearest free tile next to the container on the map), and presets
// applied through the same checks.
import type { Check } from "../map/devices";
import type { ContainerInfo, ContainerPack, InsertOptions, MapPlace } from "../map/containers";
import { containerRules, type ContainerRulesEngine } from "../map/container-rules";
import type { MapDocument } from "../map/document";
import type { Pack } from "../pack/loader";
import { applyPreset, presetItems, type ApplyResult, type PresetItem } from "../ui/container-presets";

/** What the checks need of a pack, loaded once per pack. */
export interface ContentsKit {
    pack: ContainerPack;
    /** The game's checks; null for packs built without container rules. */
    rules: ContainerRulesEngine | null;
}

const kits = new WeakMap<Pack, Promise<ContentsKit>>();

/** Loads the prototype data, component schemas and container rules of a pack (once). */
export function contentsKit(pack: Pack): Promise<ContentsKit> {
    let kit = kits.get(pack);
    if (!kit) {
        kit = Promise.all([pack.prototypeData(), pack.containerRules(), pack.componentSchemas()]).then(([data, rules, schemas]) => {
            const migrate = (id: string) => pack.migrate(id);
            return {
                pack: { data, migrate, insideStorageField: !!schemas?.components.InsideEntityStorage?.some((f) => f.name === "storage") },
                rules: containerRules({ data, rules, entities: pack.prototypes.entities, migrate }),
            };
        });
        // a failed load is tried again next time
        kit.catch(() => kits.delete(pack));
        kits.set(pack, kit);
    }
    return kit;
}

/** Order in which a drop looks for a container: lockers and crates, then bags, then slots. */
const ROLE_ORDER: Record<ContainerInfo["role"], number> = { entityStorage: 0, storage: 1, itemSlot: 2, other: 3 };

/** A drop or an add: put in, or why not. */
export type PutResult = { ok: true; uids: number[]; reason?: string } | { ok: false; reason: string };

/** Container edits of one document with a pack's checks. */
export class Contents {
    constructor(
        readonly doc: MapDocument,
        readonly kit: ContentsKit,
    ) {}

    /** Containers the mapper fills (the game's own, such as magazines and machine parts, are left out). */
    containers(uid: number): ContainerInfo[] {
        if (this.doc.proto(uid) === undefined) return [];
        return this.doc.containers(uid, this.kit.pack).filter((c) => c.role !== "other");
    }

    hasContainers(uid: number): boolean {
        return this.containers(uid).length > 0;
    }

    /** Insert options for an item and a container: the pack, the whitelist and, for a bag, its grid. */
    options(owner: number, id: string, item: number | { proto: string }): InsertOptions {
        return { pack: this.kit.pack, ...(this.kit.rules?.insertOptions(this.doc, owner, id, item) ?? {}) };
    }

    /** Whether an item can go into a container now; the pack's reason first (a bag's grid needs an item to place). */
    check(owner: number, id: string, item: number | { proto: string }): Check {
        const c = this.doc.canInsert(owner, id, item, this.options(owner, id, item));
        if (c.ok || !this.kit.rules) return c;
        const proto = typeof item === "number" ? this.doc.proto(item) : item.proto;
        const ownerProto = this.doc.proto(owner);
        const why = proto && ownerProto ? this.kit.rules.refusal(proto, ownerProto, id) : null;
        return why ? { ok: false, reason: why } : c;
    }

    /** The container a drop goes into: the first that takes it (entity storage, then storage, then slots). */
    target(owner: number, item: number | { proto: string }): { id: string } | { reason: string } {
        const boxes = this.containers(owner).sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role]);
        let reason = "";
        for (const box of boxes) {
            const c = this.check(owner, box.id, item);
            if (c.ok) return { id: box.id };
            reason ||= c.reason;
        }
        return { reason: reason || `${this.doc.proto(owner) || owner} has no containers` };
    }

    /**
     * Puts an entity (out of where it is) or `count` new ones of a prototype into a container, as one undo step.
     * Stops at the first refusal: `reason` says why when some went in.
     */
    put(owner: number, id: string, item: number | { proto: string }, count = 1): PutResult {
        const first = this.check(owner, id, item);
        if (!first.ok) return first;
        const doc = this.doc;
        return doc.batch("Put in", (): PutResult => {
            if (typeof item === "number") {
                if (doc.containerOf(item)) doc.moveToContainer(item, owner, id, this.options(owner, id, item));
                else doc.insertIntoContainer(owner, id, item, this.options(owner, id, item));
                return { ok: true, uids: [item] };
            }
            const uids: number[] = [];
            for (let i = 0; i < Math.max(1, Math.floor(count)); i++) {
                const c = i ? this.check(owner, id, item) : first;
                if (!c.ok) return { ok: true, uids, reason: c.reason };
                uids.push(doc.insertIntoContainer(owner, id, item, this.options(owner, id, item)));
            }
            return { ok: true, uids };
        });
    }

    /** Takes an entity out onto a place on the map. */
    takeOut(uid: number, place: MapPlace): void {
        this.doc.removeFromContainer(uid, place, this.kit.pack);
    }

    /** Deletes a stored entity with what it holds. */
    delete(uid: number): void {
        this.doc.removeFromContainer(uid, "delete", this.kit.pack);
    }

    /** The outermost entity holding `uid` (itself when it is on the map). */
    outermost(uid: number): number {
        let top = uid;
        for (let place = this.doc.containerOf(top); place; place = this.doc.containerOf(top)) top = place.owner;
        return top;
    }

    /** Uids in a container and everything inside them. */
    nested(owner: number): number[] {
        return this.doc.descendants(owner);
    }

    /** A container's contents as preset items (same items with the same contents counted together). */
    preset(owner: number, id: string): PresetItem[] {
        const box = this.containers(owner).find((c) => c.id === id);
        if (!box) return [];
        return presetItems({ proto: (uid) => this.doc.proto(uid), containers: (uid) => this.containers(uid) }, box.contents);
    }

    /** Puts a preset's items into a container as one undo step; refused ones (and what they would hold) are skipped. */
    applyPreset(owner: number, id: string, items: readonly PresetItem[]): ApplyResult {
        return this.doc.batch("Apply preset", () =>
            applyPreset(
                {
                    refusal: (o, cid, proto) => {
                        const c = this.check(o, cid, { proto });
                        return c.ok ? null : c.reason;
                    },
                    insert: (o, cid, proto) => this.doc.insertIntoContainer(o, cid, { proto }, this.options(o, cid, { proto })),
                },
                owner,
                id,
                items,
            ),
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Where an entity taken out goes

/** What the search for a free tile reads of the map (the scene has it). */
export interface Floor {
    /** Tile name, or null for space. */
    tileAt(grid: number, x: number, y: number): string | null;
    anchoredAt(grid: number, x: number, y: number): readonly number[];
    /** Whether an entity that is not anchored stands on the tile. */
    looseAt?(grid: number, x: number, y: number): boolean;
}

/** How far from the container the search for a free tile goes. */
const SEARCH_RADIUS = 6;

/**
 * The nearest tile next to (x, y) to put something on: first one with nothing on it, else one without anchored
 * entities (walls, tables, machines), nearest first (sides before corners); the tile itself when there is none.
 * Null when (x, y) is not on a tile.
 */
export function freeTileNear(floor: Floor, grid: number, x: number, y: number, radius = SEARCH_RADIUS): [number, number] | null {
    const tx = Math.floor(x), ty = Math.floor(y);
    const cells: Array<[number, number, number]> = [];
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) if (dx || dy) cells.push([dx * dx + dy * dy, dx, dy]);
    // nearest first; at equal distance east, north, west, south as the game's directions go round
    const turn = (dx: number, dy: number) => (Math.atan2(dy, dx) + 2 * Math.PI) % (2 * Math.PI);
    cells.sort((a, b) => a[0] - b[0] || turn(a[1], a[2]) - turn(b[1], b[2]));
    let unanchored: [number, number] | null = null;
    for (const [, dx, dy] of cells) {
        const cx = tx + dx, cy = ty + dy;
        if (floor.tileAt(grid, cx, cy) === null || floor.anchoredAt(grid, cx, cy).length) continue;
        if (!floor.looseAt?.(grid, cx, cy)) return [cx, cy];
        unanchored ??= [cx, cy];
    }
    if (unanchored) return unanchored;
    return floor.tileAt(grid, tx, ty) === null ? null : [tx, ty];
}

/**
 * Where an entity taken out of a container goes: on the tile of the outermost holder, as in the game, where
 * things come out at the container's own position.
 */
export function takeOutPlace(contents: Contents, floor: Floor, uid: number): MapPlace | null {
    const doc = contents.doc;
    const top = contents.outermost(uid);
    const t = doc.transform(top);
    if (t.parent === null) return null;
    const tx = Math.floor(t.x), ty = Math.floor(t.y);
    if (floor.tileAt(t.parent, tx, ty) === null) return null;
    return { grid: t.parent, x: tx + 0.5, y: ty + 0.5 };
}
