// Keeps key bindings and palette categories in the signed-in user's account. On sign-in each kind is pulled,
// merged with this browser's (see settings-merge) and pushed back when that changed it; later edits here are pushed
// a moment after they are made. A push over a stale revision merges with the server's document and tries once more.
// The editor never waits for any of this: settings stay in localStorage as before, and failures only log once.
import { storageKey as categoriesKey } from "../ui/categories";
import type { Api, SettingsKind } from "./client";
import {
    canonical,
    categoriesDoc,
    keysDoc,
    mergeCategories,
    mergeKeys,
    normaliseCategories,
    readCategoriesDoc,
    readKeysDoc,
    type Bindings,
    type ForkCategories,
} from "./settings-merge";

export type SyncStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

/** The key bindings as the sync sees them. */
export interface SyncedKeys {
    /** The action exists in this version of the editor. */
    known(id: string): boolean;
    /** The overrides in effect. */
    get(): Bindings;
    /** Replaces the overrides (stores them and redraws what shows them). */
    set(bindings: Bindings): void;
}

export interface SyncOptions {
    api: Pick<Api, "getSettings" | "putSettings">;
    storage: SyncStorage | null;
    keys: SyncedKeys;
    /** Categories of these builds were replaced in storage by synced ones. */
    categoriesChanged(forks: string[]): void;
    /** Wait after an edit before it is pushed (ms). */
    delay?: number;
    warn?: (message: string) => void;
}

const STATE_KEY = "ss14mapper.sync";
const CATEGORIES_PREFIX = categoriesKey("");
const KINDS: readonly SettingsKind[] = ["keys", "categories"];

type Data = Bindings | ForkCategories;
/** No settings of a kind (both kinds are objects). */
const EMPTY: Data = {};

/** What the server held when this browser last agreed with it, by kind. */
interface Base {
    revision: number;
    data: Data | null;
}

interface State {
    user: number;
    keys?: Base;
    categories?: Base;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

export class SettingsSync {
    private user: number | null = null;
    /** Bumped on every start and stop, so work of an earlier session is dropped. */
    private session = 0;
    private readonly timers = new Map<SettingsKind, ReturnType<typeof setTimeout>>();
    /** Operations of a kind run one after another. */
    private readonly chains = new Map<SettingsKind, Promise<void>>();
    /** Settings are being replaced by synced ones: their change events are not edits. */
    private applying = false;
    private warned = false;
    private readonly delay: number;

    constructor(private readonly o: SyncOptions) {
        this.delay = o.delay ?? 2000;
    }

    /** Starts syncing for a signed-in user: pulls and merges both kinds; resolves when done (never rejects). */
    start(user: number): Promise<void> {
        this.stop();
        this.user = user;
        const session = ++this.session;
        return Promise.all(KINDS.map((k) => this.queue(k, () => this.pull(k, session)))).then(() => undefined);
    }

    /** Signed out: local settings stay as they are and are no longer pushed. */
    stop(): void {
        this.session++;
        this.user = null;
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
    }

    /** Settings of a kind were edited here: pushes them after a short wait. */
    changed(kind: SettingsKind): void {
        if (this.applying || this.user === null) return;
        clearTimeout(this.timers.get(kind));
        this.timers.set(
            kind,
            setTimeout(() => {
                this.timers.delete(kind);
                void this.pushNow(kind);
            }, this.delay),
        );
    }

    /** Pushes waiting edits at once (the page is being hidden). */
    flush(): void {
        for (const [kind, t] of [...this.timers]) {
            clearTimeout(t);
            this.timers.delete(kind);
            void this.pushNow(kind, true);
        }
    }

    /** Pushes this browser's edits of a kind made since the last sync. */
    pushNow(kind: SettingsKind, keepalive = false): Promise<void> {
        const session = this.session;
        return this.queue(kind, async () => {
            const base = this.loadBase(kind);
            // not pulled yet: the pull merges these edits
            if (session !== this.session || !base) return;
            const next = this.merge(kind, base.data, this.readLocal(kind), base.data);
            if (same(next, base.data ?? EMPTY)) return;
            await this.push(kind, base, next, session, keepalive);
        });
    }

    private queue(kind: SettingsKind, op: () => Promise<void>): Promise<void> {
        const run = (this.chains.get(kind) ?? Promise.resolve()).then(op).catch((e: unknown) => this.fail(e));
        this.chains.set(kind, run);
        return run;
    }

    private async pull(kind: SettingsKind, session: number): Promise<void> {
        const doc = await this.o.api.getSettings(kind);
        if (session !== this.session) return;
        const theirs = this.read(kind, doc.data);
        const merged = this.merge(kind, theirs, this.readLocal(kind), this.loadBase(kind)?.data ?? null);
        this.applyLocal(kind, merged);
        if (same(merged, theirs ?? EMPTY)) return this.saveBase(kind, { revision: doc.revision, data: theirs ?? merged });
        await this.push(kind, { revision: doc.revision, data: theirs }, merged, session);
    }

    /** Stores `next` over `base`; on a stale revision merges with the server's document and tries once more. */
    private async push(kind: SettingsKind, base: Base, next: Data, session: number, keepalive = false): Promise<void> {
        let r = await this.o.api.putSettings(kind, base.revision, this.doc(kind, next), keepalive);
        if (session !== this.session) return;
        if (!r.ok) {
            const theirs = this.read(kind, r.doc.data);
            next = this.merge(kind, theirs, this.readLocal(kind), base.data);
            this.applyLocal(kind, next);
            if (same(next, theirs ?? EMPTY)) return this.saveBase(kind, { revision: r.doc.revision, data: theirs ?? next });
            r = await this.o.api.putSettings(kind, r.doc.revision, this.doc(kind, next), keepalive);
            if (session !== this.session) return;
            if (!r.ok) throw new Error(`${kind} changed on the server again`);
        }
        this.saveBase(kind, { revision: r.doc.revision, data: this.read(kind, r.doc.data) ?? next });
    }

    private fail(e: unknown): void {
        if (this.warned) return;
        this.warned = true;
        (this.o.warn ?? console.warn)(`Settings sync failed: ${(e as Error)?.message ?? e}`);
    }

    // ---- kinds

    private read(kind: SettingsKind, data: unknown): Data | null {
        return kind === "keys" ? readKeysDoc(data) : readCategoriesDoc(data);
    }

    private doc(kind: SettingsKind, data: Data): unknown {
        return kind === "keys" ? keysDoc(data as Bindings) : categoriesDoc(data as ForkCategories);
    }

    private merge(kind: SettingsKind, server: Data | null, local: Data, base: Data | null): Data {
        if (kind === "keys") return mergeKeys(server as Bindings | null, local as Bindings, base as Bindings | null, (id) => this.o.keys.known(id));
        return mergeCategories(server as ForkCategories | null, local as ForkCategories, base as ForkCategories | null);
    }

    private readLocal(kind: SettingsKind): Data {
        if (kind === "keys") return this.o.keys.get();
        const out: ForkCategories = {};
        const s = this.o.storage;
        if (!s) return out;
        try {
            for (let i = 0; i < s.length; i++) {
                const key = s.key(i);
                if (!key?.startsWith(CATEGORIES_PREFIX)) continue;
                const file = normaliseCategories(JSON.parse(s.getItem(key) ?? "null"));
                if (file) out[key.slice(CATEGORIES_PREFIX.length)] = file;
            }
        } catch {
            // unreadable storage: nothing local
        }
        return out;
    }

    private applyLocal(kind: SettingsKind, data: Data): void {
        this.applying = true;
        try {
            if (kind === "keys") {
                const known = Object.fromEntries(Object.entries(data as Bindings).filter(([id]) => this.o.keys.known(id)));
                if (!same(known, this.o.keys.get())) this.o.keys.set(known);
                return;
            }
            const local = this.readLocal("categories") as ForkCategories;
            const changed: string[] = [];
            for (const [fork, file] of Object.entries(data as ForkCategories)) {
                if (same(file, local[fork])) continue;
                try {
                    // the palette's own format
                    this.o.storage?.setItem(categoriesKey(fork), JSON.stringify(file, null, 2));
                    changed.push(fork);
                } catch {
                    // storage full: the next push still carries the server's categories
                }
            }
            if (changed.length) this.o.categoriesChanged(changed);
        } finally {
            this.applying = false;
        }
    }

    // ---- the base, kept with the settings

    private loadState(): State | null {
        try {
            const v = JSON.parse(this.o.storage?.getItem(STATE_KEY) ?? "null") as State | null;
            return v && typeof v === "object" && typeof v.user === "number" ? v : null;
        } catch {
            return null;
        }
    }

    private loadBase(kind: SettingsKind): Base | null {
        const st = this.loadState();
        if (!st || st.user !== this.user) return null;
        const b = st[kind];
        return b && typeof b.revision === "number" ? { revision: b.revision, data: this.read(kind, this.doc(kind, (b.data ?? {}) as Data)) } : null;
    }

    private saveBase(kind: SettingsKind, base: Base): void {
        if (this.user === null) return;
        const prev = this.loadState();
        const st: State = prev && prev.user === this.user ? prev : { user: this.user };
        st[kind] = base;
        try {
            this.o.storage?.setItem(STATE_KEY, JSON.stringify(st));
        } catch {
            // storage full: the next sign-in merges as a first sync
        }
    }
}
