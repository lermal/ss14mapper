// References to other entities held in component fields (besides signal links and device lists, see devices.ts).
//
// What the game does when the entity a field names is deleted, as saved maps show:
//   - containers: a list loses the uid (`ents: []` when emptied) and a slot becomes `ent: null`; some forks
//     (Frontier, Goob mostly) leave the field out of an empty container instead, so the map's own habit is followed;
//   - fields of other components with a single uid are reset to null, which is a default and not saved: the field
//     goes, and a component left with no fields goes with it (it is on the prototype, or the game does not save it);
//   - lists and mappings keyed by uid lose the entry; emptied, they are left out, except where the game writes
//     them (the lists the game writes whatever they hold, as `[]`, are not among these fields);
//   - a docking port that loses its partner loses `dockJointId` too, and the joint of the dock leaves the grids.
// The fields are the ones that hold uids in the corpus (survey of 904 maps); other numbers are not touched.

import type { Transform } from "./document";
import type { Journal } from "./journal";
import { entryOf, get, scalar, type YEntry, type YItem, type YMap, type YNode, type YSeq } from "./yaml";

/** How a field holds uids: one uid, a list of uids, a mapping keyed by uid, or one whose values are uids. */
type Kind = "uid" | "list" | "keyed" | "values";

interface Field {
    kind: Kind;
}

const uid: Field = { kind: "uid" };
const list: Field = { kind: "list" };

/**
 * Fields by component type (ContainerContainer, Joint and Biome are read by their own code). Chunk entities
 * (ChunkContainer.chunkEntities, ChunkEntity.root) and `nullspace` are kept by the decal code and `deleteEntity`.
 */
const FIELDS: Record<string, Record<string, Field>> = {
    Storage: { storedItems: { kind: "keyed" } },
    Action: { container: uid, attachedEntity: uid },
    InsideEntityStorage: { storage: uid },
    ContainedSolution: { container: uid },
    AtmosDevice: { joinedGrid: uid },
    DeltaPressure: { gridUid: uid },
    HandheldLight: { toggleActionEntity: uid, selfToggleActionEntity: uid },
    GasTank: { toggleActionEntity: uid },
    Jetpack: { toggleActionEntity: uid },
    Blocking: { blockingToggleActionEntity: uid },
    ToggleableClothing: { actionEntity: uid, clothingUid: uid },
    AttachedClothing: { attachedUid: uid },
    Summonable: { summonActionEntity: uid },
    AnalysisConsole: { analyzerEntity: uid },
    OreSiloClient: { silo: uid },
    LinkedEntity: { linkedEntities: list },
    Bin: { items: list },
    ItemPlacer: { placedEntities: list },
    BallisticAmmoProvider: { entities: list },
    ActionGrant: { actionEntities: list },
    NetworkConfigurator: { devices: { kind: "values" }, activeDeviceList: uid },
    Docking: { dockedWith: uid },
};

const asMap = (node: YNode | undefined): YMap | undefined => (node?.kind === "map" ? node : undefined);
const asSeq = (node: YNode | undefined): YSeq | undefined => (node?.kind === "seq" ? node : undefined);
const text = (node: YNode | undefined): string | undefined => (node?.kind === "scalar" ? node.value : undefined);
const num = (node: YNode | undefined): number => (/^\d+$/.test(text(node) ?? "") ? Number(text(node)) : NaN);
const typeOf = (c: YItem) => text(get(c.value, "type"));
const isEmpty = (node: YNode) => (node.kind === "scalar" ? /^(\[\s*\]|\{\s*\}|~|null)?$/.test(node.value.trim()) : node.kind === "seq" ? !node.items.length : !node.entries.length);

/** Uids named by the fields of these components (those of devices.ts excluded). */
export function referencedBy(components: readonly YItem[]): number[] {
    const out: number[] = [];
    const add = (n: number) => void (Number.isFinite(n) && out.push(n));
    for (const c of components) {
        const type = typeOf(c);
        const fields = asMap(c.value);
        if (!type || !fields) continue;
        for (const [name, f] of Object.entries(FIELDS[type] ?? {})) {
            const node = get(fields, name);
            if (f.kind === "uid") add(num(node));
            else if (f.kind === "list") asSeq(node)?.items.forEach((i) => add(num(i.value)));
            else if (f.kind === "keyed") asMap(node)?.entries.forEach((e) => add(num(e.key)));
            else asMap(node)?.entries.forEach((e) => add(num(e.value)));
        }
        if (type === "ContainerContainer") {
            for (const e of asMap(get(fields, "containers"))?.entries ?? []) {
                add(num(get(e.value, "ent")));
                asSeq(get(e.value, "ents"))?.items.forEach((i) => add(num(i.value)));
            }
        } else if (type === "Joint") {
            for (const e of asMap(get(fields, "joints"))?.entries ?? []) {
                add(num(get(e.value, "bodyA")));
                add(num(get(e.value, "bodyB")));
            }
        } else if (type === "Biome") {
            for (const chunk of asMap(get(fields, "entities"))?.entries ?? []) asMap(chunk.value)?.entries.forEach((e) => add(num(e.key)));
        }
    }
    return out;
}

/** What `clearReferences` needs of a document (`DeviceHost` provides it). */
export interface ReferenceHost {
    readonly journal: Journal;
    has(uid: number): boolean;
    transform(uid: number): Transform;
    /** Components of an entity, in file order. */
    components(uid: number): YItem[];
    touch(uid: number, ...targets: Array<YEntry | YItem>): void;
    dropComponent(uid: number, type: string): boolean;
}

/** How a map writes an emptied container: the field kept (`ents: []`, `ent: null`) or left out. */
export interface EmptyStyle {
    list: boolean;
    slot: boolean;
}

/** The joints of docks being removed, by the dock's joint id, and the grids they connect. */
export interface DockInfo {
    joints: Set<string>;
    grids: Set<number>;
}

/** Joint ids and grids of the docks among `removed` (read before they are gone). */
export function dockInfo(host: ReferenceHost, removed: ReadonlySet<number>): DockInfo {
    const info: DockInfo = { joints: new Set(), grids: new Set() };
    for (const id of removed) {
        const dock = host.components(id).find((c) => typeOf(c) === "Docking");
        if (!dock) continue;
        const joint = text(get(dock.value, "dockJointId"));
        if (joint) info.joints.add(joint);
        const partner = num(get(dock.value, "dockedWith"));
        for (const e of [id, partner]) {
            if (!host.has(e)) continue;
            const parent = host.transform(e).parent;
            if (parent !== null && !removed.has(parent)) info.grids.add(parent);
        }
    }
    return info;
}

/** Whether a map writes emptied containers in full, judged by the empty ones it holds (in full when none). */
export function emptyStyle(host: ReferenceHost, uids: Iterable<number>): EmptyStyle {
    const seen = { list: [0, 0], slot: [0, 0] };
    for (const id of uids) {
        for (const c of host.components(id)) {
            if (typeOf(c) !== "ContainerContainer") continue;
            for (const e of asMap(get(c.value, "containers"))?.entries ?? []) {
                const box = asMap(e.value);
                if (!box) continue;
                const slot = box.tag?.endsWith("Slot") || !!entryOf(box, "ent");
                const field = entryOf(box, slot ? "ent" : "ents");
                const empty = !field ? 1 : isEmpty(field.value) ? 0 : -1;
                if (empty >= 0) seen[slot ? "slot" : "list"]![empty]!++;
            }
        }
    }
    return { list: seen.list[0]! >= seen.list[1]!, slot: seen.slot[0]! >= seen.slot[1]! };
}

/**
 * Removes the references to `removed` from the components of a surviving entity. Returns whether anything
 * changed. `style` is read lazily, since only emptied containers need it.
 */
export function clearReferences(host: ReferenceHost, id: number, removed: ReadonlySet<number>, docks: DockInfo, style: () => EmptyStyle): boolean {
    const { journal } = host;
    const gone = (node: YNode | undefined) => removed.has(num(node));
    let changed = false;
    for (const component of [...host.components(id)]) {
        const type = typeOf(component);
        const fields = asMap(component.value);
        if (!type || !fields) continue;
        const touched: Array<YEntry | YItem> = [];
        const dropEntry = (entry: YEntry) => {
            journal.splice(fields, "entries", fields.entries.indexOf(entry), 1);
        };
        // an emptied field: kept as `[]`/`{}` in a component written in full, else left out
        const emptied = (entry: YEntry) => {
            const others = fields.entries.filter((e) => e !== entry && e.key.value !== "type");
            if (others.some((e) => isEmpty(e.value))) touched.push(entry);
            else dropEntry(entry);
        };
        let any = false;

        for (const [name, f] of Object.entries(FIELDS[type] ?? {})) {
            const entry = entryOf(fields, name);
            if (!entry) continue;
            const node = entry.value;
            if (f.kind === "uid") {
                if (!gone(node)) continue;
                dropEntry(entry);
                if (type === "Docking") {
                    const joint = entryOf(fields, "dockJointId");
                    if (joint) dropEntry(joint);
                }
            } else if (f.kind === "list") {
                const items = asSeq(node)?.items;
                const keep = items?.filter((i) => !gone(i.value));
                if (!items || keep!.length === items.length) continue;
                journal.set(node as YSeq, "items", keep!);
                if (!keep!.length) emptied(entry);
                else touched.push(entry);
            } else {
                const entries = asMap(node)?.entries;
                const keep = entries?.filter((e) => !gone(f.kind === "keyed" ? e.key : e.value));
                if (!entries || keep!.length === entries.length) continue;
                journal.set(node as YMap, "entries", keep!);
                if (!keep!.length) emptied(entry);
                else touched.push(entry);
            }
            any = true;
        }

        if (type === "ContainerContainer") {
            for (const e of asMap(get(fields, "containers"))?.entries ?? []) {
                const box = asMap(e.value);
                if (!box) continue;
                const slot = entryOf(box, "ent");
                const items = entryOf(box, "ents");
                if (slot && gone(slot.value)) {
                    if (style().slot) journal.set(slot, "value", scalar("null"));
                    else journal.splice(box, "entries", box.entries.indexOf(slot), 1);
                    touched.push(e, ...(style().slot ? [slot] : []));
                    any = true;
                }
                const seq = asSeq(items?.value);
                const keep = seq?.items.filter((i) => !gone(i.value));
                if (items && seq && keep!.length !== seq.items.length) {
                    // the style is read before this container counts as empty
                    const leave = !keep!.length && !style().list;
                    journal.set(seq, "items", keep!);
                    if (leave) journal.splice(box, "entries", box.entries.indexOf(items), 1);
                    touched.push(e, items);
                    any = true;
                }
            }
            if (any) touched.push(...(entryOf(fields, "containers") ? [entryOf(fields, "containers")!] : []));
        } else if (type === "Joint") {
            const entry = entryOf(fields, "joints");
            const joints = asMap(entry?.value);
            const keep = joints?.entries.filter((e) => !docks.joints.has(e.key.value) && !gone(get(e.value, "bodyA")) && !gone(get(e.value, "bodyB")));
            if (entry && joints && keep!.length !== joints.entries.length) {
                journal.set(joints, "entries", keep!);
                if (!keep!.length) emptied(entry);
                else touched.push(entry);
                any = true;
            }
        } else if (type === "Biome") {
            const entry = entryOf(fields, "entities");
            for (const chunk of asMap(entry?.value)?.entries ?? []) {
                const m = asMap(chunk.value);
                const keep = m?.entries.filter((e) => !removed.has(num(e.key)));
                if (!m || keep!.length === m.entries.length) continue;
                journal.set(m, "entries", keep!);
                touched.push(chunk, entry!);
                any = true;
            }
        }

        if (!any) continue;
        changed = true;
        if (fields.entries.every((e) => e.key.value === "type")) host.dropComponent(id, type);
        else host.touch(id, component, ...touched);
    }
    return changed;
}
