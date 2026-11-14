// Merging synced settings without DOM or network: the server's document, this browser's settings and the
// document both last agreed on (the base; null before the first sync of this user here). What changed only on
// one side is taken from it; key bindings changed on both sides keep this browser's; categories of a build changed
// on both sides are joined the way an import joins them (by name, entries unioned).
import { Categories, parseCategories, type CategoriesFile } from "../ui/categories";

/** Overrides of key bindings by action id (an action without one uses its defaults). */
export type Bindings = Record<string, string[]>;
/** Categories files by build id. */
export type ForkCategories = Record<string, CategoriesFile>;

export interface KeysDoc {
    version: 1;
    bindings: Bindings;
}

export interface CategoriesDoc {
    version: 1;
    forks: ForkCategories;
}

/** JSON with object keys sorted, for comparing documents. */
export function canonical(v: unknown): string {
    return JSON.stringify(v, (_k, x: unknown) =>
        x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x,
    );
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** The bindings of a stored keys document; null when it is not one. */
export function readKeysDoc(data: unknown): Bindings | null {
    if (!data || typeof data !== "object") return null;
    const d = data as { version?: unknown; bindings?: unknown };
    if (d.version !== 1 || !d.bindings || typeof d.bindings !== "object" || Array.isArray(d.bindings)) return null;
    const out: Bindings = {};
    for (const [id, list] of Object.entries(d.bindings as Record<string, unknown>)) {
        if (Array.isArray(list)) out[id] = list.filter((b): b is string => typeof b === "string");
    }
    return out;
}

/** A categories file in the form the palette writes it (favourites first, invalid parts dropped). */
export function normaliseCategories(file: unknown): CategoriesFile | null {
    const parsed = parseCategories(JSON.stringify(file ?? null));
    return parsed ? Categories.fromJSON(JSON.stringify(parsed)).toFile() : null;
}

/** The categories of a stored categories document by build; null when it is not one. */
export function readCategoriesDoc(data: unknown): ForkCategories | null {
    if (!data || typeof data !== "object") return null;
    const d = data as { version?: unknown; forks?: unknown };
    if (d.version !== 1 || !d.forks || typeof d.forks !== "object" || Array.isArray(d.forks)) return null;
    const out: ForkCategories = {};
    for (const [fork, file] of Object.entries(d.forks as Record<string, unknown>)) {
        const f = normaliseCategories(file);
        if (f) out[fork] = f;
    }
    return out;
}

export const keysDoc = (bindings: Bindings): KeysDoc => ({ version: 1, bindings });
export const categoriesDoc = (forks: ForkCategories): CategoriesDoc => ({ version: 1, forks });

/**
 * Key bindings after a sync. An action changed here since the base keeps this browser's binding (on the first sync
 * every override made here counts as changed); the others take the server's. Actions this version does not know
 * are never changed here, so the server's bindings of newer actions are kept.
 */
export function mergeKeys(server: Bindings | null, local: Bindings, base: Bindings | null, known: (id: string) => boolean): Bindings {
    const out: Bindings = {};
    const ids = new Set([...Object.keys(server ?? {}), ...Object.keys(local), ...Object.keys(base ?? {})]);
    for (const id of [...ids].sort()) {
        const here = known(id) && (base ? !same(local[id], base[id]) : local[id] !== undefined);
        const v = here ? local[id] : server?.[id];
        if (v !== undefined) out[id] = [...v];
    }
    return out;
}

/** Joins two categories files the way an import does: `b`'s categories into `a`'s, by name. */
export function unionCategories(a: CategoriesFile, b: CategoriesFile): CategoriesFile {
    const c = Categories.fromJSON(JSON.stringify(a));
    c.merge(b);
    return c.toFile();
}

/** Categories after a sync, build by build. */
export function mergeCategories(server: ForkCategories | null, local: ForkCategories, base: ForkCategories | null): ForkCategories {
    const out: ForkCategories = {};
    const forks = new Set([...Object.keys(server ?? {}), ...Object.keys(local)]);
    for (const fork of [...forks].sort()) {
        const s = server?.[fork], l = local[fork], b = base?.[fork];
        let v: CategoriesFile | undefined;
        if (!l) v = s;
        else if (!s) v = l;
        else {
            const changedHere = !base || !same(l, b);
            const changedThere = !base || !same(s, b);
            if (!changedHere) v = s;
            else if (!changedThere) v = l;
            else v = unionCategories(l, s);
        }
        if (v) out[fork] = v;
    }
    return out;
}
