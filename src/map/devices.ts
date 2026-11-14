// Signal links and device lists as the game saves them.
//
// Signal links live on the source only: `DeviceLinkSource.linkedPorts: { <sink uid>: [pairs] }`, sinks and
// pairs in the order they were linked (a Dictionary of HashSets). A pair is written as
//   - "struct" `- source: Pressed` / `  sink: Toggle` (DeviceLink record; upstream since its introduction),
//   - "tuple"  `- - Pressed` / `  - Toggle` (older upstream, Frontier, Goob),
//   - "legacy" `- Pressed: Toggle` (a one-entry mapping; read by the tuple serializer, never written now).
// Upstream reads each sink's pair list as structs or else as tuples, so one list never mixes structs with
// the others. The sink side (`DeviceLinkSink.invokeCounter`, `LinkedSources`) and `lastSignals` are runtime
// state and are not written; the obsolete `DeviceLinkSink.links` is kept as found.
//
// Device lists: `DeviceList.devices` lists device uids in the order they were added. Devices keep back
// references to the lists they are in: `LinkedDeviceNetwork { deviceLists, configurators }` (upstream; both
// fields always written) or `DeviceNetwork.deviceLists` (Frontier, Goob; older upstream maps still carry it).

import type { Transform } from "./document";
import type { Change, Journal } from "./journal";
import { entryOf, get, map, scalar, seq, toPlain, type YEntry, type YItem, type YMap, type YNode, type YSeq } from "./yaml";
import { clearReferences, dockInfo, emptyStyle, referencedBy, type EmptyStyle } from "./references";
import type { DeviceStorage, PrototypeIndex } from "../pack/format";

/** One signal link: `sourcePort` of entity `source` drives `sinkPort` of entity `sink`. */
export interface SignalLink {
    source: number;
    sink: number;
    sourcePort: string;
    sinkPort: string;
}

export type LinkForm = "struct" | "tuple" | "legacy";

/** What the device rules need of a pack (a `Pack` is one). */
export interface DevicePack {
    prototypes: Pick<PrototypeIndex, "entities" | "migrations" | "ports" | "devices">;
}

export type Check = { ok: true } | { ok: false; reason: string };

/** `DeviceLinkSource.range` and `DeviceList.deviceLimit` when the prototype does not set them. */
export const DEFAULT_LINK_RANGE = 30;
export const DEFAULT_DEVICE_LIMIT = 32;

/** Order of fields the game writes in these components; new fields go in their place. */
const FIELD_ORDER: Record<string, string[]> = {
    DeviceLinkSource: ["range", "linkedPorts", "lastSignals", "ports"],
    DeviceList: ["configurators", "handleIncomingPackets", "isAllowList", "deviceLimit", "devices"],
    DeviceNetwork: ["deviceNetId", "configurators", "deviceLists", "transmitFrequencyId", "address", "transmitFrequency", "receiveFrequency"],
    LinkedDeviceNetwork: ["deviceLists", "configurators"],
};

/** Fields that hold uids of other entities, by component: lists of uids, or a mapping keyed by uid. */
const REFERENCES: Array<{ type: string; field: string; keyed?: true }> = [
    { type: "DeviceLinkSource", field: "linkedPorts", keyed: true },
    { type: "DeviceLinkSink", field: "links" },
    { type: "DeviceList", field: "devices" },
    { type: "DeviceList", field: "configurators" },
    { type: "DeviceNetwork", field: "deviceLists" },
    { type: "DeviceNetwork", field: "configurators" },
    { type: "LinkedDeviceNetwork", field: "deviceLists" },
    { type: "LinkedDeviceNetwork", field: "configurators" },
];

/**
 * Where saved maps have these components among others the entity overrides, when no other entity of the
 * prototype shows it: right after Transform (DeviceList after AccessReader), or last (counts over the corpus:
 * DeviceNetwork follows Transform in 8,818 of 9,025 Frontier entities, LinkedDeviceNetwork is last in 40 of 40,
 * DeviceLinkSource follows DeviceLinkSink in 501 of 541 upstream ones).
 */
const NEAR_HEAD: Record<string, string[]> = { DeviceList: ["AccessReader"], DeviceNetwork: [] };

const asMap = (node: YNode | undefined): YMap | undefined => (node?.kind === "map" ? node : undefined);
const asSeq = (node: YNode | undefined): YSeq | undefined => (node?.kind === "seq" ? node : undefined);
const text = (node: YNode | undefined): string | undefined => (node?.kind === "scalar" ? node.value : undefined);
/** An empty flow collection or null, as the game writes empty fields of components it writes in full. */
const isEmptyValue = (node: YNode) => (node.kind === "scalar" ? /^(\[\s*\]|\{\s*\}|~|null)?$/.test(node.value.trim()) : node.kind === "seq" ? !node.items.length : !node.entries.length);

/** A stored pair → its ports and form, or undefined when it is none of the known forms. */
export function readPair(node: YNode): { sourcePort: string; sinkPort: string; form: LinkForm } | undefined {
    if (node.kind === "seq") {
        const [a, b] = node.items.map((i) => text(i.value));
        return node.items.length === 2 && a !== undefined && b !== undefined ? { sourcePort: a, sinkPort: b, form: "tuple" } : undefined;
    }
    if (node.kind !== "map") return undefined;
    const source = text(get(node, "source"));
    const sink = text(get(node, "sink"));
    if (source !== undefined && sink !== undefined && node.entries.length === 2) return { sourcePort: source, sinkPort: sink, form: "struct" };
    const only = node.entries.length === 1 ? node.entries[0]! : undefined;
    const value = only && text(only.value);
    return only && value !== undefined ? { sourcePort: only.key.value, sinkPort: value, form: "legacy" } : undefined;
}

/** A pair as the game writes it in `form` ("legacy" is never written; it becomes a tuple). */
export function pairNode(sourcePort: string, sinkPort: string, form: LinkForm): YNode {
    return form === "struct" ? map([["source", scalar(sourcePort)], ["sink", scalar(sinkPort)]]) : seq([scalar(sourcePort), scalar(sinkPort)]);
}

/** Every pair of a `linkedPorts` mapping, by sink, in file order. */
export function readLinkedPorts(node: YNode | undefined): Array<{ sink: number; pairs: Array<{ sourcePort: string; sinkPort: string; form: LinkForm }> }> {
    return (asMap(node)?.entries ?? []).map((e) => ({
        sink: Number(e.key.value),
        pairs: (asSeq(e.value)?.items ?? []).flatMap((i) => readPair(i.value) ?? []),
    }));
}

/**
 * Pair form to write: a fork that reads only tuples gets tuples; one that writes structs gets the form the map
 * already uses (both load there), structs when the map has no struct or tuple pairs yet.
 */
export function chooseLinkForm(storage: DeviceStorage | undefined, counts: { struct: number; tuple: number }): LinkForm {
    if (storage?.linkFormat === "tuple") return "tuple";
    if (counts.struct === 0 && counts.tuple === 0) return "struct";
    return counts.tuple > counts.struct ? "tuple" : "struct";
}

/**
 * Pairs "link defaults" makes (`DeviceLinkSystem.GetDefaults`): each source port with each of its default sink
 * ports the sink has, in port order. The game links nothing when any source port has no default links.
 */
export function defaultPairs(sourcePorts: string[], sinkPorts: string[], pack: DevicePack): Array<[string, string]> {
    const defs = pack.prototypes.ports?.source ?? {};
    const out: Array<[string, string]> = [];
    for (const port of sourcePorts) {
        const links = defs[port]?.defaultLinks;
        if (!links) return [];
        for (const sink of links) if (sinkPorts.includes(sink)) out.push([port, sink]);
    }
    return out;
}

/** What the device rules need of the document; `MapDocument` provides it. */
export interface DeviceHost {
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
    /** Component types of an entity, in file order. */
    componentTypes(uid: number): string[];
    /** Component types of the other entities of its prototype. */
    siblingTypes(uid: number): string[][];
    /** Inserts a new component at an index of the entity's component list. */
    insertComponent(uid: number, item: YItem, at: number): void;
    dropComponent(uid: number, type: string): boolean;
    onChange(listener: (change: Change) => void): void;
}

/** Device link and device list edits of a document (run inside its edits). */
export class DeviceEdits {
    /**
     * Uids each entity names in the fields of `REFERENCES` (entities naming none are left out), and the reverse:
     * found once, then kept up to date from the edits.
     */
    private refs: Map<number, number[]> | null = null;
    private readonly referrers = new Map<number, Set<number>>();
    private readonly stale = new Set<number>();
    private mapForms?: { struct: number; tuple: number };
    /**
     * Component types that preceded a component this removed, by "uid type": the game keeps an emptied component
     * on the entity (it is just not saved), so linking again in the same session writes it where it was.
     */
    private readonly dropped = new Map<string, string[]>();
    /**
     * The slot an item was last removed from, by list (`linkedPorts` mapping, pair or uid list): the game's
     * HashSet and Dictionary put the next item added into the freed slot, so removing an item and adding it back
     * leaves the list as it was. Valid while the list is unchanged since (undo gives it another array).
     */
    private readonly freed = new WeakMap<object, { items: unknown[]; at: number }>();

    constructor(private readonly host: DeviceHost) {
        host.onChange((change) => {
            for (const uid of change.entities) this.stale.add(uid);
        });
    }

    // -----------------------------------------------------------------------------------------
    // Reading

    /** Links of a source, in file order. */
    links(uid: number): SignalLink[] {
        if (!this.host.has(uid)) return [];
        const out: SignalLink[] = [];
        for (const { sink, pairs } of readLinkedPorts(get(this.host.component(uid, "DeviceLinkSource")?.value, "linkedPorts"))) {
            for (const p of pairs) out.push({ source: uid, sink, sourcePort: p.sourcePort, sinkPort: p.sinkPort });
        }
        return out;
    }

    /** Links of every source into a sink. */
    linksTo(uid: number): SignalLink[] {
        return [...this.referring(uid)].flatMap((h) => this.links(h).filter((l) => l.sink === uid));
    }

    /** Devices in an entity's device list, in file order. */
    deviceList(uid: number): number[] {
        if (!this.host.has(uid)) return [];
        return uidList(get(this.host.component(uid, "DeviceList")?.value, "devices"));
    }

    /** Entities whose device list has `uid`. */
    deviceListsWith(uid: number): number[] {
        return [...this.referring(uid)].filter((h) => this.deviceList(h).includes(uid));
    }

    /** Signal ports of an entity once it has started: the pack's, and ports the map adds in overrides. */
    signalPorts(uid: number, pack: DevicePack): { source: string[]; sink: string[] } {
        const ports = this.entityProto(uid, pack)?.ports;
        const extra = (type: string) => {
            const list = toPlain(get(this.host.component(uid, type)?.value, "ports") ?? seq([]));
            return Array.isArray(list) ? list.map(String) : [];
        };
        const union = (a: string[] = [], b: string[]) => [...a, ...b.filter((p) => !a.includes(p))];
        return { source: union(ports?.source, extra("DeviceLinkSource")), sink: union(ports?.sink, extra("DeviceLinkSink")) };
    }

    /** Whether `sourcePort` of `source` can be linked to `sinkPort` of `sink`, and why not. */
    canLink(source: number, sink: number, sourcePort: string, sinkPort: string, pack: DevicePack): Check {
        const ends = this.checkEnds(source, sink, pack);
        if (!ends.ok) return ends;
        const defs = pack.prototypes.ports!;
        if (!defs.source[sourcePort]) return fail(`"${sourcePort}" is not a source port of this fork`);
        if (!defs.sink[sinkPort]) return fail(`"${sinkPort}" is not a sink port of this fork`);
        const { source: out } = this.signalPorts(source, pack);
        if (!out.includes(sourcePort)) return fail(`${this.name(source)} has no source port "${sourcePort}"${out.length ? ` (it has ${out.join(", ")})` : ""}`);
        const { sink: input } = this.signalPorts(sink, pack);
        if (!input.includes(sinkPort)) return fail(`${this.name(sink)} has no sink port "${sinkPort}"${input.length ? ` (it has ${input.join(", ")})` : ""}`);
        return { ok: true };
    }

    // -----------------------------------------------------------------------------------------
    // Signal link edits

    /** Links two ports; false when they are linked already. */
    link(source: number, sink: number, sourcePort: string, sinkPort: string, pack: DevicePack): boolean {
        const check = this.canLink(source, sink, sourcePort, sinkPort, pack);
        if (!check.ok) throw new Error(check.reason);
        if (this.links(source).some((l) => l.sink === sink && l.sourcePort === sourcePort && l.sinkPort === sinkPort)) return false;
        this.writePairs(source, sink, [[sourcePort, sinkPort]], false, pack);
        return true;
    }

    /**
     * Links a source to a sink by the default links of its ports, replacing the links between them, as the
     * game's "link defaults" does. Returns the number of links made; 0 leaves existing links alone (the game
     * would remove them) when no default applies, e.g. when a source port has no default links.
     */
    linkDefaults(source: number, sink: number, pack: DevicePack): number {
        const ends = this.checkEnds(source, sink, pack);
        if (!ends.ok) throw new Error(ends.reason);
        const pairs = defaultPairs(this.signalPorts(source, pack).source, this.signalPorts(sink, pack).sink, pack);
        if (!pairs.length) return 0;
        this.writePairs(source, sink, pairs, true, pack);
        return pairs.length;
    }

    /** Removes one link; false when there is no such link. */
    unlink(source: number, sink: number, sourcePort: string, sinkPort: string): boolean {
        return this.removePairs(source, (s) => s === sink, (p) => p?.sourcePort === sourcePort && p.sinkPort === sinkPort) > 0;
    }

    /** Removes every link of a source (to one sink, or to all). Returns the number of links removed. */
    unlinkAll(source: number, sink?: number): number {
        return this.removePairs(source, (s) => sink === undefined || s === sink);
    }

    // -----------------------------------------------------------------------------------------
    // Device list edits

    /** Whether a device can be added to an entity's device list, and why not. */
    canAddToDeviceList(config: number, device: number, pack: DevicePack): Check {
        for (const uid of [config, device]) if (!this.host.has(uid)) return fail(`No entity ${uid}`);
        if (config === device) return fail("A device cannot be in its own device list");
        if (!pack.prototypes.devices) return fail("No device data in this build");
        const configProto = this.entityProto(config, pack);
        if (!configProto?.components.DeviceList && !this.host.component(config, "DeviceList")) return fail(`${this.name(config)} has no device list`);
        const deviceProto = this.entityProto(device, pack);
        const net = (uid: number, proto: typeof deviceProto) => {
            const override = this.host.component(uid, "DeviceNetwork");
            if (!proto?.components.DeviceNetwork && !override) return undefined;
            return { ...(proto?.components.DeviceNetwork ?? {}), ...(override ? (toPlain(override.value) as Record<string, unknown>) : {}) };
        };
        const deviceNet = net(device, deviceProto);
        if (!deviceNet) return fail(`${this.name(device)} is not on a device network`);
        if (deviceNet.savableAddress === false) return fail(`${this.name(device)} cannot be saved to device lists`);
        const configNet = net(config, configProto);
        if (configNet && String(configNet.deviceNetId ?? "") !== String(deviceNet.deviceNetId ?? "")) {
            return fail(`${this.name(device)} is on the ${String(deviceNet.deviceNetId ?? "default")} network, not ${String(configNet.deviceNetId ?? "default")}`);
        }
        const list = this.deviceList(config);
        if (list.includes(device)) return fail(`${this.name(device)} is in the list already`);
        const fields = { ...(configProto?.components.DeviceList ?? {}), ...(toPlain(this.host.component(config, "DeviceList")?.value ?? map([])) as Record<string, unknown>) };
        const limit = Number(fields.deviceLimit ?? DEFAULT_DEVICE_LIMIT);
        if (list.length >= limit) return fail(`The list is full (${limit} devices)`);
        return { ok: true };
    }

    /** Adds a device to an entity's device list (and the back reference the fork writes); false when it is there already. */
    addToDeviceList(config: number, device: number, pack: DevicePack): boolean {
        const check = this.canAddToDeviceList(config, device, pack);
        if (!check.ok) {
            if (this.host.has(config) && this.deviceList(config).includes(device)) return false;
            throw new Error(check.reason);
        }
        this.appendUid(config, "DeviceList", "devices", device);
        if (pack.prototypes.devices!.deviceListBackReference === "LinkedDeviceNetwork") {
            if (!this.host.component(device, "LinkedDeviceNetwork")) {
                const item: YItem = { value: map([["type", scalar("LinkedDeviceNetwork")], ["deviceLists", seq([scalar(String(config))])], ["configurators", seq([])]]) };
                this.addComponent(device, item);
            } else this.appendUid(device, "LinkedDeviceNetwork", "deviceLists", config);
        } else this.appendUid(device, "DeviceNetwork", "deviceLists", config);
        this.held(config, device);
        this.host.journal.note([config, device]);
        return true;
    }

    /**
     * Removes a device from an entity's device list and the device's back reference to it in the component the
     * fork uses (upstream maps keep old `DeviceNetwork.deviceLists` the game no longer reads; they are left as
     * they are). False when it was not in the list.
     */
    removeFromDeviceList(config: number, device: number, pack: DevicePack): boolean {
        if (!this.deviceList(config).includes(device)) return false;
        this.removeUids(config, "DeviceList", "devices", new Set([device]));
        const back = pack.prototypes.devices?.deviceListBackReference;
        if (this.host.has(device)) {
            if (back !== "DeviceNetwork") this.removeUids(device, "LinkedDeviceNetwork", "deviceLists", new Set([config]));
            if (back !== "LinkedDeviceNetwork") this.removeUids(device, "DeviceNetwork", "deviceLists", new Set([config]));
        }
        this.host.journal.note([config, device]);
        return true;
    }

    /**
     * Before entities are deleted (they are still in the document): removes links to them, device list entries,
     * back references, container contents and the other uid fields of `references.ts` naming them from the
     * entities left, so no saved uid points at nothing (or at an entity that gets the uid later).
     */
    forget(removed: ReadonlySet<number>): void {
        const holders = new Set<number>();
        for (const r of removed) for (const h of this.referring(r)) holders.add(h);
        const docks = dockInfo(this.host, removed);
        for (const g of docks.grids) holders.add(g);
        let style: EmptyStyle | undefined;
        const emptyStyleOnce = () => (style ??= emptyStyle(this.host, this.host.uids().filter((u) => !removed.has(u))));
        for (const uid of holders) {
            if (removed.has(uid) || !this.host.has(uid)) continue;
            let changed = clearReferences(this.host, uid, removed, docks, emptyStyleOnce);
            for (const ref of REFERENCES) {
                if (ref.keyed) {
                    const before = asMap(get(this.host.component(uid, ref.type)?.value, ref.field))?.entries.length ?? 0;
                    this.removePairs(uid, (sink) => removed.has(sink), undefined, false);
                    changed ||= (asMap(get(this.host.component(uid, ref.type)?.value, ref.field))?.entries.length ?? 0) !== before;
                } else changed = this.removeUids(uid, ref.type, ref.field, removed) || changed;
            }
            if (changed) this.host.journal.note([uid]);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Internals

    /** Entities naming `uid` in a field of `REFERENCES`. */
    private referring(uid: number): ReadonlySet<number> {
        this.index();
        return this.referrers.get(uid) ?? new Set();
    }

    /** Entities naming any uid in a field of `REFERENCES`. */
    private holders(): Iterable<number> {
        return this.index().keys();
    }

    private index(): Map<number, number[]> {
        if (!this.refs) {
            this.refs = new Map();
            this.stale.clear();
            for (const uid of this.host.uids()) this.reindex(uid);
        }
        for (const uid of this.stale) this.reindex(uid);
        this.stale.clear();
        return this.refs;
    }

    private reindex(uid: number): void {
        const refs = this.refs!;
        for (const t of refs.get(uid) ?? []) this.referrers.get(t)?.delete(uid);
        refs.delete(uid);
        if (!this.host.has(uid)) return;
        const named = new Set<number>();
        for (const ref of REFERENCES) {
            const node = get(this.host.component(uid, ref.type)?.value, ref.field);
            if (!node) continue;
            const ids = ref.keyed ? (asMap(node)?.entries ?? []).map((e) => Number(e.key.value)) : uidList(node);
            for (const id of ids) if (Number.isFinite(id)) named.add(id);
        }
        for (const id of referencedBy(this.host.components(uid))) named.add(id);
        if (!named.size) return;
        refs.set(uid, [...named]);
        for (const t of named) {
            let set = this.referrers.get(t);
            if (!set) this.referrers.set(t, (set = new Set()));
            set.add(uid);
        }
    }

    /** Entities whose references changed here (seen before the change is reported). */
    private held(...uids: number[]): void {
        for (const uid of uids) this.stale.add(uid);
    }

    private name(uid: number): string {
        return `${this.host.proto(uid) || "entity"} #${uid}`;
    }

    private entityProto(uid: number, pack: DevicePack) {
        let id: string | null = this.host.proto(uid) ?? null;
        const { migrations, entities } = pack.prototypes;
        for (let i = 0; i < 16 && id !== null && id in migrations; i++) id = migrations[id] ?? null;
        return id === null ? undefined : entities[id];
    }

    private checkEnds(source: number, sink: number, pack: DevicePack): Check {
        for (const uid of [source, sink]) if (!this.host.has(uid)) return fail(`No entity ${uid}`);
        if (!pack.prototypes.ports) return fail("No port data in this build");
        if (!this.signalPorts(source, pack).source.length) return fail(`${this.name(source)} has no source ports`);
        if (!this.signalPorts(sink, pack).sink.length) return fail(`${this.name(sink)} has no sink ports`);
        const range = this.linkRange(source, pack);
        const a = this.worldPosition(source), b = this.worldPosition(sink);
        if (a.root !== b.root) return fail(`${this.name(sink)} is on another map`);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        // MapCoordinates.InRange
        if (!(d * d < range * range)) return fail(`${this.name(sink)} is out of range (${d.toFixed(1)} m, at most ${range} m)`);
        return { ok: true };
    }

    private linkRange(uid: number, pack: DevicePack): number {
        const override = Number(text(get(this.host.component(uid, "DeviceLinkSource")?.value, "range")));
        if (Number.isFinite(override)) return override;
        const proto = Number(this.entityProto(uid, pack)?.components.DeviceLinkSource?.range);
        return Number.isFinite(proto) ? proto : DEFAULT_LINK_RANGE;
    }

    /** Position in the coordinates of the entity's map (the root of its transform tree). */
    private worldPosition(uid: number): { x: number; y: number; root: number } {
        const chain: Transform[] = [];
        let id = uid;
        for (let i = 0; i < 64; i++) {
            const t = this.host.transform(id);
            if (t.parent === null || !this.host.has(t.parent)) break;
            chain.push(t);
            id = t.parent;
        }
        let x = 0, y = 0, rot = 0;
        for (let i = chain.length - 1; i >= 0; i--) {
            const t = chain[i]!;
            const c = Math.cos(rot), s = Math.sin(rot);
            [x, y] = [x + c * t.x - s * t.y, y + s * t.x + c * t.y];
            rot += t.rotation;
        }
        return { x, y, root: id };
    }

    private linkForm(pack: DevicePack): LinkForm {
        if (!this.mapForms) {
            const counts = { struct: 0, tuple: 0 };
            for (const uid of this.holders()) {
                for (const { pairs } of readLinkedPorts(get(this.host.component(uid, "DeviceLinkSource")?.value, "linkedPorts"))) {
                    for (const p of pairs) if (p.form !== "legacy") counts[p.form]++;
                }
            }
            this.mapForms = counts;
        }
        return chooseLinkForm(pack.prototypes.devices, this.mapForms);
    }

    /**
     * Adds pairs to the links of a source to a sink (after its existing ones, or instead of them with `replace`).
     * A source with pairs of another form is rewritten whole in the chosen form, so no list mixes forms.
     */
    private writePairs(source: number, sink: number, pairs: Array<[string, string]>, replace: boolean, pack: DevicePack): void {
        const { host } = this;
        const form = this.linkForm(pack);
        let component = host.component(source, "DeviceLinkSource");
        if (!component) {
            this.addComponent(source, { value: map([["type", scalar("DeviceLinkSource")], ["linkedPorts", map([])]]) });
            component = host.component(source, "DeviceLinkSource")!;
        }
        const fields = asMap(component.value)!;
        let entry = entryOf(fields, "linkedPorts");
        if (!entry) entry = this.insertField(fields, "DeviceLinkSource", "linkedPorts", map([]));
        let linked = this.ensure(entry, "map") as YMap;
        if (linked.entries.some((e) => (asSeq(e.value)?.items ?? []).some((i) => !readPair(i.value)))) throw new Error(`${this.name(source)} has links in an unknown format`);
        if (readLinkedPorts(linked).some((s) => s.pairs.some((p) => p.form !== form))) {
            const old = linked;
            linked = map(readLinkedPorts(old).map((s) => [String(s.sink), seq(s.pairs.map((p) => pairNode(p.sourcePort, p.sinkPort, form)))]));
            host.journal.set(entry, "value", linked);
            const hole = this.freed.get(old);
            if (hole?.items === old.entries) this.freed.set(linked, { items: linked.entries, at: hole.at });
        }
        let sinkEntry = linked.entries.find((e) => Number(e.key.value) === sink);
        if (!sinkEntry) {
            sinkEntry = { key: scalar(String(sink)), value: seq([]) };
            this.add(linked, "entries", sinkEntry);
        }
        const list = this.ensure(sinkEntry, "seq") as YSeq;
        const items = pairs.map(([a, b]) => ({ value: pairNode(a, b, form) }));
        if (replace) {
            const same = list.items.length === items.length && list.items.every((i, n) => {
                const p = readPair(i.value);
                return p?.form === form && p.sourcePort === pairs[n]![0] && p.sinkPort === pairs[n]![1];
            });
            if (same) return;
            host.journal.splice(list, "items", 0, list.items.length, ...items);
        } else for (const item of items) this.add(list, "items", item);
        host.touch(source, sinkEntry, entry, component);
        this.held(source);
        host.journal.note([source, sink]);
    }

    /** Removes the pairs of a source to the sinks `sinkMatch` accepts (those `pairMatch` accepts, or all); returns how many. */
    private removePairs(source: number, sinkMatch: (sink: number) => boolean, pairMatch?: (pair: ReturnType<typeof readPair>) => boolean, note = true): number {
        const { host } = this;
        if (!host.has(source)) return 0;
        const component = host.component(source, "DeviceLinkSource");
        const entry = component && entryOf(asMap(component.value)!, "linkedPorts");
        const linked = asMap(entry?.value);
        if (!component || !entry || !linked) return 0;
        let removed = 0;
        const sinks: number[] = [];
        const entries: YEntry[] = [];
        for (const sinkEntry of linked.entries) {
            const sink = Number(sinkEntry.key.value);
            const items = asSeq(sinkEntry.value)?.items ?? [];
            const keep = !sinkMatch(sink) ? items : pairMatch ? items.filter((i) => !pairMatch(readPair(i.value))) : [];
            if (keep.length === items.length && (keep.length || !sinkMatch(sink) || pairMatch)) {
                entries.push(sinkEntry);
                continue;
            }
            removed += items.length - keep.length;
            sinks.push(sink);
            if (keep.length) {
                this.keep(asSeq(sinkEntry.value)!, "items", keep);
                host.touch(source, sinkEntry);
                entries.push(sinkEntry);
            }
        }
        if (!sinks.length) return 0;
        if (entries.length !== linked.entries.length) this.keep(linked, "entries", entries);
        host.touch(source, entry, component);
        if (!entries.length) this.dropField(source, "DeviceLinkSource", entry);
        if (note) host.journal.note([source, ...sinks]);
        return removed;
    }

    /** Appends a uid to a uid list field of a component (made when missing). */
    private appendUid(uid: number, type: string, field: string, value: number): void {
        const { host } = this;
        let component = host.component(uid, type);
        if (!component) {
            this.addComponent(uid, { value: map([["type", scalar(type)], [field, seq([scalar(String(value))])]]) });
            return;
        }
        const fields = asMap(component.value)!;
        const entry = entryOf(fields, field) ?? this.insertField(fields, type, field, seq([]));
        const list = this.ensure(entry, "seq") as YSeq;
        if (uidList(list).includes(value)) return;
        this.add(list, "items", { value: scalar(String(value)) });
        host.touch(uid, entry, component);
    }

    /** Removes uids from a uid list field of a component; an emptied field (and component) goes. */
    private removeUids(uid: number, type: string, field: string, values: ReadonlySet<number>): boolean {
        const { host } = this;
        const component = host.component(uid, type);
        const entry = component && entryOf(asMap(component.value)!, field);
        const list = asSeq(entry?.value);
        if (!component || !entry || !list) return false;
        const keep = list.items.filter((i) => !values.has(Number(text(i.value))));
        if (keep.length === list.items.length) return false;
        this.keep(list, "items", keep);
        host.touch(uid, entry, component);
        if (!keep.length) this.dropField(uid, type, entry);
        return true;
    }

    /**
     * Handles a field left empty: a component left without other fields (for LinkedDeviceNetwork, with empty ones
     * only) is removed; in a component the game wrote in full (it has other empty fields) the field stays as
     * `[]`/`{}`; otherwise the field is left out, as the game omits fields equal to the prototype's.
     */
    private dropField(uid: number, type: string, entry: YEntry): void {
        const { host } = this;
        const component = host.component(uid, type)!;
        const fields = asMap(component.value)!;
        const others = fields.entries.filter((e) => e !== entry && e.key.value !== "type");
        if (type === "LinkedDeviceNetwork" ? others.every((e) => isEmptyValue(e.value)) : !others.length) {
            const types = host.componentTypes(uid);
            this.dropped.set(`${uid} ${type}`, types.slice(0, types.indexOf(type)));
            host.dropComponent(uid, type);
        }
        else if (!others.some((e) => isEmptyValue(e.value))) {
            host.journal.splice(fields, "entries", fields.entries.indexOf(entry), 1);
            host.touch(uid, component);
        }
    }

    /**
     * Adds a component where the game would have written it: where it was if this removed it, else after the
     * components that precede it on most entities of the prototype that have it (`NEAR_HEAD` decides the rest).
     */
    private addComponent(uid: number, item: YItem): void {
        const type = text(get(item.value, "type"))!;
        const types = this.host.componentTypes(uid);
        const first = types[0] === "MetaData" ? 1 : 0;
        const head = first + (types[first] === "Transform" ? 1 : 0);
        let at = head;
        const was = this.dropped.get(`${uid} ${type}`);
        if (was) {
            types.forEach((t, i) => {
                if (was.includes(t)) at = Math.max(at, i + 1);
            });
        } else {
            const siblings = this.host.siblingTypes(uid).filter((s) => s.includes(type));
            const near = NEAR_HEAD[type];
            for (let i = head; i < types.length; i++) {
                const t = types[i]!;
                let before = 0, after = 0;
                for (const s of siblings) {
                    const k = s.indexOf(t);
                    if (k !== -1) k < s.indexOf(type) ? before++ : after++;
                }
                if (before !== after ? before > after : near ? near.includes(t) : true) at = i + 1;
            }
        }
        this.host.insertComponent(uid, item, at);
    }

    /** Keeps only `keep` of a list (in order), remembering the slot of the last item removed. */
    private keep<K extends "items" | "entries">(owner: YSeq | YMap, key: K, keep: unknown[]): void {
        const before = (owner as unknown as Record<string, unknown[]>)[key]!;
        let at = -1;
        let kept = 0;
        for (const item of before) {
            if (kept < keep.length && keep[kept] === item) kept++;
            else at = kept;
        }
        this.host.journal.set(owner as unknown as Record<string, unknown[]>, key, keep);
        if (at !== -1) this.freed.set(owner, { items: keep, at });
    }

    /** Adds an item to a list: into the slot freed last when the list has not changed since, else at the end. */
    private add(owner: YSeq | YMap, key: "items" | "entries", item: unknown): void {
        const list = (owner as unknown as Record<string, unknown[]>)[key]!;
        const hole = this.freed.get(owner);
        const at = hole && hole.items === list ? hole.at : list.length;
        this.freed.delete(owner);
        this.host.journal.splice(owner, key, at, 0, item);
    }

    /** Adds a field to a component in the game's field order. */
    private insertField(fields: YMap, type: string, key: string, value: YNode): YEntry {
        const order = FIELD_ORDER[type] ?? [];
        const rank = order.indexOf(key);
        const keys = fields.entries.map((e) => e.key.value);
        let at = keys.findIndex((k) => order.includes(k) && order.indexOf(k) > rank);
        if (at === -1) at = keys.length;
        const entry: YEntry = { key: scalar(key), value };
        this.host.journal.splice(fields, "entries", at, 0, entry);
        return entry;
    }

    /** The mapping or sequence of an entry, replacing an empty flow value or null with an empty one. */
    private ensure(entry: YEntry, kind: "map" | "seq"): YMap | YSeq {
        if (entry.value.kind === kind) return entry.value;
        if (entry.value.kind !== "scalar" || !isEmptyValue(entry.value)) throw new Error(`"${entry.key.value}" is not a ${kind === "map" ? "mapping" : "sequence"}`);
        const node = kind === "map" ? map([]) : seq([]);
        this.host.journal.set(entry, "value", node);
        return node;
    }
}

function fail(reason: string): Check {
    return { ok: false, reason };
}

function uidList(node: YNode | undefined): number[] {
    return (asSeq(node)?.items ?? []).map((i) => Number(text(i.value))).filter((n) => Number.isFinite(n));
}
