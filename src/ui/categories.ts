// Personal palette categories without DOM: model, validation, import merge, (de)serialisation.
import { ENTRY_KINDS, type EntryKind } from "./palette-search";

/** Reserved name of the built-in favourites category in the stored format. */
export const FAVOURITES = "__favourites__";

export interface CategoryEntry {
    kind: EntryKind;
    id: string;
}

export interface Category {
    name: string;
    entries: CategoryEntry[];
}

export interface CategoriesFile {
    version: 1;
    categories: Category[];
}

/** A deleted category with its position, to bring it back (undo of a delete). */
export interface CategorySnapshot {
    index: number;
    category: Category;
}

const same = (a: CategoryEntry, b: CategoryEntry) => a.kind === b.kind && a.id === b.id;

/** Categories of one build; favourites always exist and come first. */
export class Categories {
    private readonly list: Category[] = [{ name: FAVOURITES, entries: [] }];

    /** Personal categories (without favourites) in creation order. */
    get names(): string[] {
        return this.list.slice(1).map((c) => c.name);
    }

    /** Entries of a category (favourites by `FAVOURITES`), or null if there is none. */
    entries(name: string): readonly CategoryEntry[] | null {
        return this.find(name)?.entries ?? null;
    }

    has(name: string, entry: CategoryEntry): boolean {
        return this.find(name)?.entries.some((e) => same(e, entry)) ?? false;
    }

    /** Names of the categories (favourites included) that hold the entry. */
    containing(entry: CategoryEntry): string[] {
        return this.list.filter((c) => c.entries.some((e) => same(e, entry))).map((c) => c.name);
    }

    /** Why `name` cannot be used for a new category or as the new name of `except`, or null if it can. */
    nameError(name: string, except?: string): string | null {
        name = name.trim();
        if (!name) return "Enter a name";
        if (name === FAVOURITES || name.toLowerCase() === "favorites" || name.toLowerCase() === "favourites") return "Name is reserved";
        if (name !== except && this.find(name)) return "Name already exists";
        return null;
    }

    /** Creates an empty category; false if the name is empty, reserved or taken. */
    create(name: string): boolean {
        name = name.trim();
        if (!name || name === FAVOURITES || this.find(name)) return false;
        this.list.push({ name, entries: [] });
        return true;
    }

    /** Renames a personal category; false if it is missing, or the new name is empty, reserved or taken. */
    rename(from: string, to: string): boolean {
        to = to.trim();
        const c = from === FAVOURITES ? undefined : this.find(from);
        if (!c || !to || to === FAVOURITES) return false;
        if (to === from) return true;
        if (this.find(to)) return false;
        c.name = to;
        return true;
    }

    /** Deletes a personal category; favourites cannot be deleted. */
    delete(name: string): boolean {
        const i = name === FAVOURITES ? -1 : this.list.findIndex((c) => c.name === name);
        if (i < 0) return false;
        this.list.splice(i, 1);
        return true;
    }

    /** A copy of a personal category and its position, or null. */
    snapshot(name: string): CategorySnapshot | null {
        const index = name === FAVOURITES ? -1 : this.list.findIndex((c) => c.name === name);
        const c = this.list[index];
        return c ? { index, category: { name: c.name, entries: c.entries.map((e) => ({ ...e })) } } : null;
    }

    /** Puts a deleted category back at its position; false if the name is taken meanwhile. */
    restore(snap: CategorySnapshot): boolean {
        if (this.find(snap.category.name) || snap.category.name === FAVOURITES) return false;
        this.list.splice(Math.max(1, Math.min(snap.index, this.list.length)), 0, { name: snap.category.name, entries: snap.category.entries.map((e) => ({ ...e })) });
        return true;
    }

    /** Adds an entry; false if the category is missing or already holds it. */
    add(name: string, entry: CategoryEntry): boolean {
        const c = this.find(name);
        if (!c || c.entries.some((e) => same(e, entry))) return false;
        c.entries.push({ kind: entry.kind, id: entry.id });
        return true;
    }

    remove(name: string, entry: CategoryEntry): boolean {
        const c = this.find(name);
        const i = c ? c.entries.findIndex((e) => same(e, entry)) : -1;
        if (!c || i < 0) return false;
        c.entries.splice(i, 1);
        return true;
    }

    /** Adds or removes from favourites; returns whether it is a favourite now. */
    toggleFavourite(entry: CategoryEntry): boolean {
        if (this.remove(FAVOURITES, entry)) return false;
        this.add(FAVOURITES, entry);
        return true;
    }

    /** Merges an imported file: categories by name (entries are unioned), new ones are appended. */
    merge(file: CategoriesFile): void {
        for (const src of file.categories) {
            if (src.name !== FAVOURITES) this.create(src.name);
            for (const e of src.entries) this.add(src.name.trim() || src.name, e);
        }
    }

    toFile(): CategoriesFile {
        return { version: 1, categories: this.list.map((c) => ({ name: c.name, entries: c.entries.map((e) => ({ ...e })) })) };
    }

    toJSON(): string {
        return JSON.stringify(this.toFile(), null, 2);
    }

    /** Builds from stored text; invalid input gives an empty set. */
    static fromJSON(text: string | null | undefined): Categories {
        const c = new Categories();
        const file = text ? parseCategories(text) : null;
        if (file) c.merge(file);
        return c;
    }

    private find(name: string): Category | undefined {
        return this.list.find((c) => c.name === name);
    }
}

/** Validates the shape of a categories file; unknown fields are ignored, bad categories/entries are dropped. Null if not a v1 file. */
export function parseCategories(text: string): CategoriesFile | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const r = raw as { version?: unknown; categories?: unknown };
    if (r.version !== 1 || !Array.isArray(r.categories)) return null;
    const categories: Category[] = [];
    for (const c of r.categories as unknown[]) {
        if (!c || typeof c !== "object") continue;
        const { name, entries } = c as { name?: unknown; entries?: unknown };
        if (typeof name !== "string" || !name.trim() || !Array.isArray(entries)) continue;
        const out: CategoryEntry[] = [];
        for (const e of entries as unknown[]) {
            if (!e || typeof e !== "object") continue;
            const { kind, id } = e as { kind?: unknown; id?: unknown };
            if (ENTRY_KINDS.includes(kind as EntryKind) && typeof id === "string" && id) out.push({ kind: kind as EntryKind, id });
        }
        categories.push({ name: name === FAVOURITES ? name : name.trim(), entries: out });
    }
    return { version: 1, categories };
}

/** Storage key of a build's categories. */
export const storageKey = (fork: string) => `ss14mapper.categories.${fork}`;

/** Loads a build's categories; storage failures give an empty set. */
export function loadCategories(fork: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): Categories {
    try {
        return Categories.fromJSON(storage?.getItem(storageKey(fork)));
    } catch {
        return new Categories();
    }
}

/** Saves a build's categories; false if storage is unavailable or full. */
export function saveCategories(fork: string, c: Categories, storage: Pick<Storage, "setItem"> | null = safeStorage()): boolean {
    try {
        if (!storage) return false;
        storage.setItem(storageKey(fork), c.toJSON());
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
