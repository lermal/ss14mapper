// Records every field assignment made by an edit so it can be undone exactly: undoing restores
// the previous values, including the source text of untouched YAML entries, so a document whose
// edits are all undone is written back byte for byte.

interface Assignment {
    target: Record<string, unknown>;
    key: string;
    had: boolean;
    previous: unknown;
    next: unknown;
    hasNext: boolean;
}

/** What an edit touched, for views that redraw only what changed. */
export interface Change {
    /** Entities added, removed or changed. */
    entities: number[];
    /** Tiles painted, as [grid, x, y]. */
    tiles: Array<[number, number, number]>;
    /** Decals added, removed, moved or changed, as [grid, decal id]. */
    decals: Array<[number, string]>;
}

export interface Edit {
    label: string;
    /** A previous document state that this edit restores exactly. */
    restores?: Edit | null;
    assignments: Assignment[];
    entities: Set<number>;
    tiles: Map<string, [number, number, number]>;
    decals: Map<string, [number, string]>;
}

export class Journal {
    private readonly done: Edit[] = [];
    private readonly undone: Edit[] = [];
    private current: Edit | null = null;
    /** Edit made of several steps (`begin`): each step applies and notifies at once, all undo as one. */
    private open: Edit | null = null;
    /** Last edit when the document was saved (null: as opened). */
    private saved: Edit | null = null;
    private readonly listeners = new Set<(change: Change, label: string) => void>();

    /**
     * `settle` runs after undo, redo and a failed edit with the entities the edit touched, before listeners hear
     * of the change (the owner updates its indexes there).
     */
    constructor(private readonly settle: (entities: Set<number>) => void = () => {}) {}

    /** Calls `listener` after every committed edit, undo and redo. Returns a function that unsubscribes. */
    subscribe(listener: (change: Change, label: string) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Records what the current edit touches. */
    note(entities: Iterable<number>, tiles: Iterable<[number, number, number]> = [], decals: Iterable<[number, string]> = []): void {
        if (!this.current) throw new Error("Document changes must happen inside an edit");
        for (const uid of entities) this.current.entities.add(uid);
        for (const t of tiles) this.current.tiles.set(t.join(","), t);
        for (const d of decals) this.current.decals.set(d.join("|"), d);
    }

    private emit(e: Edit): void {
        const change: Change = { entities: [...e.entities], tiles: [...e.tiles.values()], decals: [...e.decals.values()] };
        for (const l of this.listeners) l(change, e.label);
    }

    private push(e: Edit): void {
        this.done.push(e);
        this.undone.length = 0;
    }

    /** Runs `fn` as one undoable edit (a step of the open edit after `begin`). */
    edit<T>(label: string, fn: () => T): T {
        if (this.current) return fn();
        const edit = newEdit(label);
        this.current = edit;
        let result: T;
        try {
            result = fn();
        } catch (e) {
            this.current = null;
            revert(edit);
            this.settle(edit.entities);
            throw e;
        } finally {
            this.current = null;
        }
        if (!edit.assignments.length) return result;
        if (this.open) {
            this.open.assignments.push(...edit.assignments);
            for (const uid of edit.entities) this.open.entities.add(uid);
            for (const [k, t] of edit.tiles) this.open.tiles.set(k, t);
            for (const [k, d] of edit.decals) this.open.decals.set(k, d);
        } else this.push(edit);
        this.emit(edit);
        return result;
    }

    /**
     * Opens an edit made of several steps (a drag, a brush stroke): edits until `commit` apply and notify
     * listeners one by one, but are undone and redone as one edit.
     */
    begin(label: string): void {
        if (this.open || this.current) throw new Error("An edit is already open");
        this.open = newEdit(label);
    }

    get isOpen(): boolean {
        return this.open !== null;
    }

    /** Closes the edit opened by `begin`; returns whether it changed anything (and became an undo step). */
    commit(): boolean {
        const e = this.open;
        this.open = null;
        if (!e?.assignments.length) return false;
        this.push(e);
        return true;
    }

    /** Closes the edit opened by `begin` and reverts everything it did. */
    cancel(): void {
        const e = this.open;
        this.open = null;
        if (!e?.assignments.length) return;
        revert(e);
        this.settle(e.entities);
        this.emit(e);
    }

    set<T extends object, K extends keyof T & string>(target: T, key: K, value: T[K] | undefined): void {
        if (!this.current) throw new Error("Document changes must happen inside an edit");
        const t = target as Record<string, unknown>;
        const had = Object.prototype.hasOwnProperty.call(t, key);
        this.current.assignments.push({ target: t, key, had, previous: t[key], next: value, hasNext: value !== undefined });
        if (value === undefined) delete t[key];
        else t[key] = value;
    }

    /** Replaces an array's contents (recorded as a new array, so the old one stays intact). */
    splice<T>(target: object, key: string, start: number, deleteCount: number, ...items: T[]): void {
        const list = (target as Record<string, T[]>)[key]!;
        const copy = list.slice();
        copy.splice(start, deleteCount, ...items);
        this.set(target as Record<string, unknown>, key, copy);
    }

    /** The edit `undo` would revert, as a handle that stays the same through undo and redo (views key data by it). */
    get lastDone(): object | null {
        return this.done.at(-1) ?? null;
    }

    /** The edit `redo` would apply again (same handle as `lastDone` gave). */
    get nextRedo(): object | null {
        return this.undone.at(-1) ?? null;
    }

    get canUndo(): boolean {
        return this.done.length > 0;
    }

    get canRedo(): boolean {
        return this.undone.length > 0;
    }

    private get state(): Edit | null {
        const top = this.done.at(-1);
        return top?.restores === undefined ? top ?? null : top.restores;
    }

    /** Whether the document differs from the opened one by any edit (undone edits do not count). */
    get isDirty(): boolean {
        return this.state !== null || !!this.open?.assignments.length;
    }

    /** Remembers the current state as saved. */
    markSaved(): void {
        this.saved = this.state;
    }

    /** Whether there are edits since the document was saved (or opened). */
    get isModified(): boolean {
        return this.state !== this.saved || !!this.open?.assignments.length;
    }

    /** Applies the last edit in reverse as a new undo step, restoring the original YAML nodes. */
    reverseLast(): boolean {
        const last = this.done.at(-1);
        if (!last || this.open || this.current) return false;
        const previous = this.done.at(-2);
        const edit: Edit = {
            ...last,
            restores: previous?.restores === undefined ? previous ?? null : previous.restores,
            assignments: last.assignments.slice().reverse().map((a) => ({
                target: a.target,
                key: a.key,
                had: a.hasNext,
                previous: a.next,
                hasNext: a.had,
                next: a.previous,
            })),
        };
        revert(last);
        this.push(edit);
        this.settle(edit.entities);
        this.emit(edit);
        return true;
    }

    undo(): string | null {
        if (this.open) throw new Error("Commit or cancel the open edit first");
        const e = this.done.pop();
        if (!e) return null;
        revert(e);
        this.undone.push(e);
        this.settle(e.entities);
        this.emit(e);
        return e.label;
    }

    redo(): string | null {
        if (this.open) throw new Error("Commit or cancel the open edit first");
        const e = this.undone.pop();
        if (!e) return null;
        for (const a of e.assignments) {
            if (a.hasNext) a.target[a.key] = a.next;
            else delete a.target[a.key];
        }
        this.done.push(e);
        this.settle(e.entities);
        this.emit(e);
        return e.label;
    }
}

function newEdit(label: string): Edit {
    return { label, assignments: [], entities: new Set(), tiles: new Map(), decals: new Map() };
}

function revert(e: Edit): void {
    for (let i = e.assignments.length - 1; i >= 0; i--) {
        const a = e.assignments[i]!;
        if (a.had) a.target[a.key] = a.previous;
        else delete a.target[a.key];
    }
}
