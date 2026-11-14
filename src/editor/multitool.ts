// Multitool: signal links and device lists edited as with the game's multitool and network configurator. The
// mapper holds one entity, then clicks another: a configurator (an entity with a DeviceList) toggles the
// other's membership in its list, anything else opens the linking panel of the two (source ports on the left,
// sink ports on the right). Pure logic over the document; the controller keeps the held entity, the link panel
// shows `linkPanel`, the overlay draws `linkLines`.
import type { Check, DevicePack, SignalLink } from "../map/devices";
import type { MapDocument } from "../map/document";
import type { EntityPrototype } from "../pack/format";

const fail = (reason: string): Check => ({ ok: false, reason });
const exists = (doc: MapDocument, uid: number) => doc.proto(uid) !== undefined;

function protoOf(doc: MapDocument, uid: number, pack: DevicePack): EntityPrototype | undefined {
    let id: string | null = doc.proto(uid) ?? null;
    const { migrations, entities } = pack.prototypes;
    for (let i = 0; i < 16 && id !== null && id in migrations; i++) id = migrations[id] ?? null;
    return id === null ? undefined : entities[id];
}

/** "Air alarm (AirAlarm #12)", or the prototype id when the pack has no name for it. */
export function entityLabel(doc: MapDocument, uid: number, pack: DevicePack): string {
    const id = doc.proto(uid) || "entity";
    const name = protoOf(doc, uid, pack)?.name;
    return name && name !== id ? `${name} (${id} #${uid})` : `${id} #${uid}`;
}

function hasComponent(doc: MapDocument, uid: number, pack: DevicePack, type: string): boolean {
    return !!protoOf(doc, uid, pack)?.components[type] || doc.components(uid).some((c) => c.type === type);
}

/** Whether an entity has a device list of its own (air and fire alarms, ...). */
export function isConfigurator(doc: MapDocument, uid: number, pack: DevicePack): boolean {
    return exists(doc, uid) && hasComponent(doc, uid, pack, "DeviceList");
}

/** Whether an entity is on a device network (so it may join device lists). */
export function onNetwork(doc: MapDocument, uid: number, pack: DevicePack): boolean {
    return exists(doc, uid) && hasComponent(doc, uid, pack, "DeviceNetwork");
}

/** Whether the multitool can pick an entity at all: it has signal ports, a device list, or is on a network. */
export function linkable(doc: MapDocument, uid: number, pack: DevicePack): boolean {
    if (!exists(doc, uid)) return false;
    const p = doc.signalPorts(uid, pack);
    return p.source.length > 0 || p.sink.length > 0 || isConfigurator(doc, uid, pack) || onNetwork(doc, uid, pack);
}

/** Whether an entity can be held as the first end: it has signal ports or a device list. */
export function canHold(doc: MapDocument, uid: number, pack: DevicePack): Check {
    if (!exists(doc, uid)) return fail(`No entity ${uid}`);
    if (!pack.prototypes.ports) return fail("No port data in this build");
    const p = doc.signalPorts(uid, pack);
    if (p.source.length || p.sink.length || isConfigurator(doc, uid, pack)) return { ok: true };
    return fail(`${entityLabel(doc, uid, pack)} has no signal ports and no device list`);
}

/**
 * Which way two entities link: the first is the source when it has source ports and the second sink ports,
 * else the other way round. `reversible` when both ways work. Null when neither does.
 */
export function linkDirection(doc: MapDocument, first: number, second: number, pack: DevicePack): { source: number; sink: number; reversible: boolean } | null {
    const a = doc.signalPorts(first, pack), b = doc.signalPorts(second, pack);
    const forward = a.source.length > 0 && b.sink.length > 0;
    const backward = b.source.length > 0 && a.sink.length > 0;
    if (forward) return { source: first, sink: second, reversible: backward };
    if (backward) return { source: second, sink: first, reversible: false };
    return null;
}

/** What a click on a second entity does while one is held. */
export type SecondClick =
    | { kind: "release" }
    | { kind: "link"; source: number; sink: number; reversible: boolean }
    /** Toggle `device` in the list of `config`: `member` says it is in there now (so the click removes it). */
    | { kind: "list"; config: number; device: number; member: boolean }
    | { kind: "refuse"; reason: string };

/**
 * Decides a click on `uid` while `held` is held. A held configurator toggles devices in its list (devices that
 * cannot join it but can be linked open the linking panel); clicking a configurator while holding another
 * entity links them when they can be linked, else toggles the held one in its list. `preferLink` (Shift)
 * links even where the list would apply.
 */
export function secondClick(doc: MapDocument, held: number, uid: number, pack: DevicePack, preferLink = false): SecondClick {
    if (uid === held) return { kind: "release" };
    if (!exists(doc, held)) return fail2(`No entity ${held}`);
    if (!exists(doc, uid)) return fail2(`No entity ${uid}`);
    const heldConfig = isConfigurator(doc, held, pack);
    const list = heldConfig ? { config: held, device: uid } : isConfigurator(doc, uid, pack) ? { config: uid, device: held } : null;
    const direction = linkDirection(doc, held, uid, pack);
    let listReason: string | null = null;
    if (list && !preferLink && (heldConfig || !direction)) {
        if (doc.deviceList(list.config).includes(list.device)) return { kind: "list", ...list, member: true };
        const check = doc.canAddToDeviceList(list.config, list.device, pack);
        if (check.ok) return { kind: "list", ...list, member: false };
        listReason = check.reason;
    }
    if (direction) return { kind: "link", ...direction };
    if (listReason) return fail2(listReason);
    // no way to link: the document says why (the end without ports, as `canLink` checks it)
    const a = doc.signalPorts(held, pack), b = doc.signalPorts(uid, pack);
    const [source, sink, ports] = a.source.length ? [held, uid, a] : b.source.length ? [uid, held, b] : [held, uid, a];
    const check = doc.canLink(source, sink, ports.source[0] ?? "", doc.signalPorts(sink, pack).sink[0] ?? "", pack);
    return fail2(check.ok ? "These cannot be linked" : check.reason);
}

const fail2 = (reason: string): SecondClick => ({ kind: "refuse", reason });

/** Adds a device to a list or takes it out. Returns what was done, or why it was refused. */
export function toggleDevice(doc: MapDocument, config: number, device: number, pack: DevicePack): { done: "added" | "removed" } | { reason: string } {
    if (doc.deviceList(config).includes(device)) {
        doc.removeFromDeviceList(config, device, pack);
        return { done: "removed" };
    }
    const check = doc.canAddToDeviceList(config, device, pack);
    if (!check.ok) return { reason: check.reason };
    doc.addToDeviceList(config, device, pack);
    return { done: "added" };
}

// ---------------------------------------------------------------------------------------------
// The linking panel

export interface PortRow {
    id: string;
    /** Localised name from the port prototype (the id when the pack has none). */
    name: string;
    description?: string;
}

export interface LinkPanelModel {
    source: number;
    sink: number;
    sourcePorts: PortRow[];
    sinkPorts: PortRow[];
    /** Links between the two, in file order. */
    links: Array<{ sourcePort: string; sinkPort: string }>;
    /** Why nothing can be linked, when every pair is refused for the same reason (out of range, ...). */
    blocked: string | null;
    /** Whether the sink has source ports and the source sink ports, so the direction can be swapped. */
    reversible: boolean;
}

export function linkPanel(doc: MapDocument, source: number, sink: number, pack: DevicePack): LinkPanelModel {
    const defs = pack.prototypes.ports ?? { source: {}, sink: {} };
    const row = (kind: "source" | "sink") => (id: string): PortRow => {
        const d = defs[kind][id];
        return { id, name: d?.name || id, ...(d?.description ? { description: d.description } : {}) };
    };
    const a = doc.signalPorts(source, pack), b = doc.signalPorts(sink, pack);
    const links = doc.links(source).filter((l) => l.sink === sink).map(({ sourcePort, sinkPort }) => ({ sourcePort, sinkPort }));
    const reasons = new Set<string>();
    let any = false;
    for (const sp of a.source) {
        for (const kp of b.sink) {
            const c = doc.canLink(source, sink, sp, kp, pack);
            if (c.ok) any = true;
            else reasons.add(c.reason);
        }
    }
    const blocked = !any && reasons.size === 1 ? [...reasons][0]! : !any && !a.source.length ? `${entityLabel(doc, source, pack)} has no source ports` : !any && !b.sink.length ? `${entityLabel(doc, sink, pack)} has no sink ports` : null;
    return {
        source,
        sink,
        sourcePorts: a.source.map(row("source")),
        sinkPorts: b.sink.map(row("sink")),
        links,
        blocked,
        reversible: b.source.length > 0 && a.sink.length > 0,
    };
}

/** Clicking a source port, then a sink port: links them, or unlinks them when they are linked. */
export function togglePair(doc: MapDocument, source: number, sink: number, sourcePort: string, sinkPort: string, pack: DevicePack): { done: "linked" | "unlinked" } | { reason: string } {
    if (doc.links(source).some((l) => l.sink === sink && l.sourcePort === sourcePort && l.sinkPort === sinkPort)) {
        doc.unlink(source, sink, sourcePort, sinkPort);
        return { done: "unlinked" };
    }
    const check = doc.canLink(source, sink, sourcePort, sinkPort, pack);
    if (!check.ok) return { reason: check.reason };
    doc.link(source, sink, sourcePort, sinkPort, pack);
    return { done: "linked" };
}

// ---------------------------------------------------------------------------------------------
// Links of one entity (overlay lines, inspector)

export interface Relations {
    /** Links from this entity's source ports. */
    outgoing: SignalLink[];
    /** Links into this entity's sink ports. */
    incoming: SignalLink[];
    /** Devices in this entity's device list. */
    devices: number[];
    /** Entities whose device list has this entity. */
    lists: number[];
}

export function relations(doc: MapDocument, uid: number): Relations {
    if (!exists(doc, uid)) return { outgoing: [], incoming: [], devices: [], lists: [] };
    return { outgoing: doc.links(uid), incoming: doc.linksTo(uid), devices: doc.deviceList(uid), lists: doc.deviceListsWith(uid) };
}

/** A line of the overlay: from a source to a sink (with the port pairs), or from a configurator to a device. */
export interface LinkLine {
    kind: "signal" | "device";
    from: number;
    to: number;
    /** "Pressed → Toggle" pairs of a signal line. */
    pairs: Array<[string, string]>;
}

/** Lines to draw for an entity: one per pair of entities linked, and one per device list membership. */
export function linkLines(r: Relations, uid: number): LinkLine[] {
    const out: LinkLine[] = [];
    const signal = new Map<string, LinkLine>();
    for (const l of [...r.outgoing, ...r.incoming]) {
        const key = `${l.source}>${l.sink}`;
        let line = signal.get(key);
        if (!line) {
            signal.set(key, (line = { kind: "signal", from: l.source, to: l.sink, pairs: [] }));
            out.push(line);
        }
        line.pairs.push([l.sourcePort, l.sinkPort]);
    }
    for (const d of r.devices) out.push({ kind: "device", from: uid, to: d, pairs: [] });
    for (const c of r.lists) out.push({ kind: "device", from: c, to: uid, pairs: [] });
    return out;
}
