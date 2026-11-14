// Contents presets without DOM: a container's contents saved under a name (per build, like the palette's
// categories) and put into other containers. A preset is a list of prototypes with counts; an item that holds
// things keeps them, by container id, so a toolbox comes with its tools.

export interface PresetItem {
    proto: string;
    count: number;
    /** What the item holds, by container id. */
    contents?: Record<string, PresetItem[]>;
}

export interface ContentsPreset {
    name: string;
    items: PresetItem[];
}

export interface PresetsFile {
    version: 1;
    presets: ContentsPreset[];
}

/** A deleted preset with its position, to bring it back. */
export interface PresetSnapshot {
    index: number;
    preset: ContentsPreset;
}

const MAX_COUNT = 999;
const MAX_DEPTH = 8;

/** Presets of one build, in creation order. */
export class Presets {
    private readonly list: ContentsPreset[] = [];

    get names(): string[] {
        return this.list.map((p) => p.name);
    }

    get all(): readonly ContentsPreset[] {
        return this.list;
    }

    get(name: string): ContentsPreset | null {
        return this.list.find((p) => p.name === name) ?? null;
    }

    /** Why `name` cannot be used for a new preset or as the new name of `except`, or null if it can. */
    nameError(name: string, except?: string): string | null {
        name = name.trim();
        if (!name) return "Enter a name";
        if (name !== except && this.get(name)) return "Name already exists";
        return null;
    }

    /** Adds a preset; false when the name is empty or taken, or there is nothing in it. */
    add(name: string, items: readonly PresetItem[]): boolean {
        name = name.trim();
        if (this.nameError(name) || !items.length) return false;
        this.list.push({ name, items: items.map(cloneItem) });
        return true;
    }

    rename(from: string, to: string): boolean {
        to = to.trim();
        const p = this.get(from);
        if (!p || this.nameError(to, from)) return false;
        p.name = to;
        return true;
    }

    /** Deletes a preset; the snapshot brings it back with `restore`. */
    remove(name: string): PresetSnapshot | null {
        const index = this.list.findIndex((p) => p.name === name);
        if (index === -1) return null;
        const [preset] = this.list.splice(index, 1);
        return { index, preset: preset! };
    }

    /** Puts a deleted preset back where it was; false when its name has been taken since. */
    restore(s: PresetSnapshot): boolean {
        if (this.get(s.preset.name)) return false;
        this.list.splice(Math.min(s.index, this.list.length), 0, s.preset);
        return true;
    }

    toJSON(): string {
        const file: PresetsFile = { version: 1, presets: this.list };
        return JSON.stringify(file);
    }

    static fromJSON(text: string | null | undefined): Presets {
        const out = new Presets();
        const file = text ? parsePresets(text) : null;
        for (const p of file?.presets ?? []) if (!out.get(p.name)) out.list.push(p);
        return out;
    }
}

function cloneItem(i: PresetItem): PresetItem {
    const out: PresetItem = { proto: i.proto, count: i.count };
    if (i.contents) out.contents = Object.fromEntries(Object.entries(i.contents).map(([id, list]) => [id, list.map(cloneItem)]));
    return out;
}

function parseItems(raw: unknown, depth: number): PresetItem[] {
    if (!Array.isArray(raw) || depth > MAX_DEPTH) return [];
    const out: PresetItem[] = [];
    for (const r of raw as unknown[]) {
        if (!r || typeof r !== "object") continue;
        const { proto, count, contents } = r as { proto?: unknown; count?: unknown; contents?: unknown };
        if (typeof proto !== "string" || !proto) continue;
        const n = typeof count === "number" && Number.isFinite(count) ? Math.min(MAX_COUNT, Math.max(1, Math.floor(count))) : 1;
        const item: PresetItem = { proto, count: n };
        if (contents && typeof contents === "object" && !Array.isArray(contents)) {
            const boxes = Object.entries(contents as Record<string, unknown>)
                .map(([id, list]) => [id, parseItems(list, depth + 1)] as const)
                .filter(([, list]) => list.length);
            if (boxes.length) item.contents = Object.fromEntries(boxes);
        }
        out.push(item);
    }
    return out;
}

/** Reads a presets file; null when it is not one. Bad entries are dropped. */
export function parsePresets(text: string): PresetsFile | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const r = raw as { version?: unknown; presets?: unknown };
    if (r.version !== 1 || !Array.isArray(r.presets)) return null;
    const presets: ContentsPreset[] = [];
    for (const p of r.presets as unknown[]) {
        if (!p || typeof p !== "object") continue;
        const { name, items } = p as { name?: unknown; items?: unknown };
        if (typeof name !== "string" || !name.trim()) continue;
        const list = parseItems(items, 0);
        if (list.length) presets.push({ name: name.trim(), items: list });
    }
    return { version: 1, presets };
}

/** How many entities a preset makes, nested ones included. */
export function countItems(items: readonly PresetItem[]): number {
    let n = 0;
    for (const i of items) n += i.count * (1 + Object.values(i.contents ?? {}).reduce((s, list) => s + countItems(list), 0));
    return n;
}

/** "3 Crowbar, Toolbox" for a list. */
export function describeItems(items: readonly PresetItem[], name: (proto: string) => string = (p) => p): string {
    return items.map((i) => (i.count > 1 ? `${i.count} ${name(i.proto)}` : name(i.proto))).join(", ");
}

// ---------------------------------------------------------------------------------------------
// From contents and back

/** What reading contents needs of a map. */
export interface ContentsReader {
    proto(uid: number): string | undefined;
    /** Containers the mapper fills, with what they hold. */
    containers(uid: number): ReadonlyArray<{ id: string; contents: readonly number[] }>;
}

const signature = (i: PresetItem): string => JSON.stringify([i.proto, i.contents ?? null]);

/** Preset items of a list of entities: identical ones (same prototype and contents) counted together, in order. */
export function presetItems(reader: ContentsReader, uids: readonly number[], depth = 0): PresetItem[] {
    const out: PresetItem[] = [];
    const bySig = new Map<string, PresetItem>();
    for (const uid of uids) {
        const proto = reader.proto(uid);
        if (!proto) continue;
        const item: PresetItem = { proto, count: 1 };
        if (depth < MAX_DEPTH) {
            const boxes = reader
                .containers(uid)
                .map((c) => [c.id, presetItems(reader, c.contents, depth + 1)] as const)
                .filter(([, list]) => list.length);
            if (boxes.length) item.contents = Object.fromEntries(boxes);
        }
        const sig = signature(item);
        const same = bySig.get(sig);
        if (same) same.count++;
        else {
            bySig.set(sig, item);
            out.push(item);
        }
    }
    return out;
}

/** What applying a preset needs of a map: the checks and the insert. */
export interface PresetTarget {
    /** Why a new entity of `proto` cannot go into the container now, or null. */
    refusal(owner: number, containerId: string, proto: string): string | null;
    /** Makes it inside; returns its uid. */
    insert(owner: number, containerId: string, proto: string): number;
}

export interface ApplyResult {
    added: number;
    skipped: number;
    /** Reasons of the skipped ones, each once, in order. */
    reasons: string[];
}

/** Puts a preset's items into a container; what is refused is skipped with what it would hold. */
export function applyPreset(target: PresetTarget, owner: number, containerId: string, items: readonly PresetItem[]): ApplyResult {
    const result: ApplyResult = { added: 0, skipped: 0, reasons: [] };
    const skip = (n: number, reason: string) => {
        result.skipped += n;
        if (!result.reasons.includes(reason)) result.reasons.push(reason);
    };
    const run = (o: number, id: string, list: readonly PresetItem[]) => {
        for (const item of list) {
            const nested = Object.values(item.contents ?? {}).reduce((s, l) => s + countItems(l), 0);
            for (let k = 0; k < item.count; k++) {
                const reason = target.refusal(o, id, item.proto);
                let uid: number | null = null;
                if (reason === null) {
                    try {
                        uid = target.insert(o, id, item.proto);
                    } catch (e) {
                        skip(1 + nested, e instanceof Error ? e.message : String(e));
                        continue;
                    }
                } else {
                    skip(1 + nested, reason);
                    continue;
                }
                result.added++;
                for (const [cid, sub] of Object.entries(item.contents ?? {})) run(uid, cid, sub);
            }
        }
    };
    run(owner, containerId, items);
    return result;
}

// ---------------------------------------------------------------------------------------------
// Storage

/** Storage key of a build's presets. */
export const presetsKey = (fork: string) => `ss14mapper.presets.${fork}`;

/** Loads a build's presets; storage failures give none. */
export function loadPresets(fork: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): Presets {
    try {
        return Presets.fromJSON(storage?.getItem(presetsKey(fork)));
    } catch {
        return new Presets();
    }
}

/** Saves a build's presets; false if storage is unavailable or full. */
export function savePresets(fork: string, p: Presets, storage: Pick<Storage, "setItem"> | null = safeStorage()): boolean {
    try {
        if (!storage) return false;
        storage.setItem(presetsKey(fork), p.toJSON());
        return true;
    } catch {
        return false;
    }
}

function safeStorage(): Storage | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}
