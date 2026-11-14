// The map library: maps kept in this browser (IndexedDB), so they reopen from the start screen and File > Open
// recent without picking a file. A record holds the map's text with its name, build, size and times; the list
// reads only the small metadata store. Every storage call is guarded: a failure answers null or false and the
// editor goes on (Download still makes a file).

export interface LibraryEntry {
    id: string;
    /** File name, e.g. "barnacle.yml". */
    name: string;
    /** Build (fork id) it was last shown with. */
    build: string;
    /** When its text was last written (ms since the epoch). */
    savedAt: number;
    /** When it was last opened. */
    openedAt: number;
    /** Size of the text in bytes (UTF-8). */
    size: number;
}

export interface LibraryRecord extends LibraryEntry {
    text: string;
}

/** Where records live. Calls may throw; the library catches. */
export interface LibraryBackend {
    entries(): Promise<LibraryEntry[]>;
    text(id: string): Promise<string | undefined>;
    /** Writes the metadata, and the text when given. */
    put(entry: LibraryEntry, text?: string): Promise<void>;
    remove(id: string): Promise<void>;
}

export interface LibraryOptions {
    now?: () => number;
    newId?: () => string;
    /** Asked once, on the first save (the browser's persistent storage). */
    persist?: () => void;
}

const byteSize = (text: string) => new TextEncoder().encode(text).length;

const randomId = () => {
    try {
        return crypto.randomUUID();
    } catch {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
};

const recency = (e: LibraryEntry) => Math.max(e.savedAt, e.openedAt);

export class MapLibrary {
    private readonly now: () => number;
    private readonly newId: () => string;
    private persist: (() => void) | null;

    constructor(private readonly backend: LibraryBackend | null, options: LibraryOptions = {}) {
        this.now = options.now ?? Date.now;
        this.newId = options.newId ?? randomId;
        this.persist = options.persist ?? null;
    }

    /** Whether there is storage at all. */
    get available(): boolean {
        return !!this.backend;
    }

    /** Most recently used first; empty when storage fails. */
    async list(): Promise<LibraryEntry[]> {
        try {
            const all = (await this.backend?.entries()) ?? [];
            return all.filter(validEntry).sort((a, b) => recency(b) - recency(a));
        } catch {
            return [];
        }
    }

    /** A record with its text (marked as opened now), or null. */
    async open(id: string): Promise<LibraryRecord | null> {
        try {
            const entry = (await this.backend?.entries())?.find((e) => e.id === id);
            const text = entry && (await this.backend!.text(id));
            if (!entry || text === undefined) return null;
            const opened = { ...entry, openedAt: this.now() };
            await this.backend!.put(opened);
            return { ...opened, text };
        } catch {
            return null;
        }
    }

    /**
     * Keeps a map file just opened: the record of the same name and text if there is one (marked opened),
     * else a new record. A changed file of the same name becomes a record of its own, so browser edits stay.
     */
    async addOpened(name: string, build: string, text: string): Promise<LibraryEntry | null> {
        try {
            if (!this.backend) return null;
            const size = byteSize(text);
            for (const e of await this.backend.entries()) {
                if (e.name !== name || e.size !== size || (await this.backend.text(e.id)) !== text) continue;
                const opened = { ...e, build, openedAt: this.now() };
                await this.backend.put(opened);
                return opened;
            }
            return await this.write({ id: this.newId(), name, build, savedAt: this.now(), openedAt: this.now(), size }, text, false);
        } catch {
            return null;
        }
    }

    /** A new record (a new map, Save as). */
    async create(name: string, build: string, text: string): Promise<LibraryEntry | null> {
        const t = this.now();
        return this.write({ id: this.newId(), name, build, savedAt: t, openedAt: t, size: byteSize(text) }, text);
    }

    /** Writes a map's text into its record (made again if it went). */
    async save(entry: Pick<LibraryEntry, "id" | "name" | "build">, text: string): Promise<LibraryEntry | null> {
        const t = this.now();
        return this.write({ ...entry, savedAt: t, openedAt: t, size: byteSize(text) }, text);
    }

    /** Changes the name or build of a record without touching its text. */
    async update(id: string, change: Partial<Pick<LibraryEntry, "name" | "build">>): Promise<LibraryEntry | null> {
        try {
            const entry = (await this.backend?.entries())?.find((e) => e.id === id);
            if (!entry) return null;
            const next = { ...entry, ...change };
            await this.backend!.put(next);
            return next;
        } catch {
            return null;
        }
    }

    /** Deletes a record; returns it whole, for undo with `restore`. */
    async remove(id: string): Promise<LibraryRecord | null> {
        try {
            const entry = (await this.backend?.entries())?.find((e) => e.id === id);
            const text = entry && (await this.backend!.text(id));
            await this.backend?.remove(id);
            return entry && text !== undefined ? { ...entry, text } : null;
        } catch {
            return null;
        }
    }

    async restore(record: LibraryRecord): Promise<boolean> {
        const { text, ...entry } = record;
        return !!(await this.write(entry, text));
    }

    /** Writes a record; `saving`: the mapper saved (the first save asks for persistent storage). */
    private async write(entry: LibraryEntry, text: string, saving = true): Promise<LibraryEntry | null> {
        try {
            if (!this.backend) return null;
            if (saving && this.persist) {
                const ask = this.persist;
                this.persist = null;
                try {
                    ask();
                } catch {
                    // not offered: the browser may clear the library under storage pressure
                }
            }
            await this.backend.put(entry, text);
            return entry;
        } catch {
            return null;
        }
    }
}

function validEntry(e: unknown): e is LibraryEntry {
    const o = e as LibraryEntry;
    return !!o && typeof o.id === "string" && typeof o.name === "string" && typeof o.build === "string" && typeof o.savedAt === "number" && typeof o.size === "number" && typeof (o.openedAt ?? 0) === "number";
}

/** Bytes used by the records' texts. */
export const usedBytes = (entries: readonly LibraryEntry[]) => entries.reduce((n, e) => n + e.size, 0);

/** A file name from what was typed: path characters dropped, ".yml" added when it has no YAML extension. */
export function mapFileName(typed: string): string {
    const name = typed.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return "";
    return /\.ya?ml$/i.test(name) ? name : `${name}.yml`;
}

/** A backend in memory (tests; the page uses IndexedDB). */
export function memoryBackend(): LibraryBackend & { texts: Map<string, string> } {
    const meta = new Map<string, LibraryEntry>();
    const texts = new Map<string, string>();
    return {
        texts,
        entries: async () => [...meta.values()].map((e) => ({ ...e })),
        text: async (id) => texts.get(id),
        put: async (entry, text) => {
            meta.set(entry.id, { ...entry });
            if (text !== undefined) texts.set(entry.id, text);
        },
        remove: async (id) => {
            meta.delete(id);
            texts.delete(id);
        },
    };
}

// ---- IndexedDB

const DB = "ss14mapper";
/** Version 1 held File System Access handles of recent files ("recent-handles"); version 2 holds the library. */
const VERSION = 2;
const META = "library";
const TEXTS = "library-texts";

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (db.objectStoreNames.contains("recent-handles")) db.deleteObjectStore("recent-handles");
            if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
            if (!db.objectStoreNames.contains(TEXTS)) db.createObjectStore(TEXTS);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("Close other tabs using the library"));
    });
}

/** The browser's IndexedDB as a backend, or null where there is none. */
export function indexedDbBackend(): LibraryBackend | null {
    if (typeof indexedDB === "undefined") return null;
    let db: Promise<IDBDatabase> | null = null;
    const connect = () => {
        db ??= openDb().then((d) => {
            // another tab upgrading closes this connection; the next call opens a new one
            d.onversionchange = () => {
                d.close();
                db = null;
            };
            return d;
        });
        db.catch(() => (db = null));
        return db;
    };
    const run = async <T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> => {
        const d = await connect();
        return new Promise((resolve, reject) => {
            const t = d.transaction(stores, mode);
            const req = body(t);
            t.oncomplete = () => resolve(req ? req.result : undefined);
            t.onerror = t.onabort = () => reject(t.error ?? new Error("Storage error"));
        });
    };
    return {
        entries: async () => (await run<LibraryEntry[]>([META], "readonly", (t) => t.objectStore(META).getAll())) ?? [],
        text: (id) => run<string | undefined>([TEXTS], "readonly", (t) => t.objectStore(TEXTS).get(id) as IDBRequest<string | undefined>),
        put: async (entry, text) => {
            await run(text === undefined ? [META] : [META, TEXTS], "readwrite", (t) => {
                t.objectStore(META).put(entry);
                if (text !== undefined) t.objectStore(TEXTS).put(text, entry.id);
            });
        },
        remove: async (id) => {
            await run([META, TEXTS], "readwrite", (t) => {
                t.objectStore(META).delete(id);
                t.objectStore(TEXTS).delete(id);
            });
        },
    };
}

// ---- text for people

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today, 14:02", "yesterday", "12 Nov" or "12 Nov 2025" (local time). */
export function formatWhen(time: number, now = Date.now()): string {
    const d = new Date(time), n = new Date(now);
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(n) - day(d)) / 86_400_000);
    if (days === 0) return `today, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (days === 1) return "yesterday";
    return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
}

/** "820 B", "14 KB", "1.4 MB". */
export function formatSize(bytes: number): string {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
    const mb = bytes / 1_000_000;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
