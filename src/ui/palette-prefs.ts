// Palette view preferences without DOM: grid/list per tab and open category folders, kept in localStorage.
import { ENTRY_KINDS, type EntryKind } from "./palette-search";

export type GridPrefs = Record<EntryKind, boolean>;

type Store = Pick<Storage, "getItem" | "setItem">;

const GRID_KEY = "ss14mapper.palette.grid";
const openKey = (fork: string) => `ss14mapper.palette.open.${fork}`;

function safeStorage(): Store | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

/** Grid view per tab (list by default); broken storage or text gives the defaults. */
export function loadGrid(storage: Pick<Storage, "getItem"> | null = safeStorage()): GridPrefs {
    const prefs: GridPrefs = { entity: false, tile: false, decal: false };
    try {
        const v = JSON.parse(storage?.getItem(GRID_KEY) ?? "null") as Record<string, unknown> | null;
        if (v && typeof v === "object") for (const k of ENTRY_KINDS) prefs[k] = v[k] === true;
    } catch {
        /* defaults */
    }
    return prefs;
}

export function saveGrid(prefs: GridPrefs, storage: Pick<Storage, "setItem"> | null = safeStorage()): boolean {
    try {
        if (!storage) return false;
        storage.setItem(GRID_KEY, JSON.stringify(prefs));
        return true;
    } catch {
        return false;
    }
}

/** Names of the category folders left open for a build. */
export function loadOpen(fork: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): Set<string> {
    try {
        const v = JSON.parse(storage?.getItem(openKey(fork)) ?? "null") as unknown;
        return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    } catch {
        return new Set();
    }
}

export function saveOpen(fork: string, open: ReadonlySet<string>, storage: Pick<Storage, "setItem"> | null = safeStorage()): boolean {
    try {
        if (!storage) return false;
        storage.setItem(openKey(fork), JSON.stringify([...open]));
        return true;
    } catch {
        return false;
    }
}
