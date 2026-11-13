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

export interface Edit {
    label: string;
    assignments: Assignment[];
}

export class Journal {
    private readonly done: Edit[] = [];
    private readonly undone: Edit[] = [];
    private current: Edit | null = null;

    /** Runs `fn` as one undoable edit. */
    edit<T>(label: string, fn: () => T): T {
        if (this.current) return fn();
        this.current = { label, assignments: [] };
        try {
            const result = fn();
            if (this.current.assignments.length) {
                this.done.push(this.current);
                this.undone.length = 0;
            }
            return result;
        } catch (e) {
            const failed = this.current;
            this.current = null;
            revert(failed);
            throw e;
        } finally {
            this.current = null;
        }
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

    get canUndo(): boolean {
        return this.done.length > 0;
    }

    get canRedo(): boolean {
        return this.undone.length > 0;
    }

    get isDirty(): boolean {
        return this.done.length > 0;
    }

    undo(): string | null {
        const e = this.done.pop();
        if (!e) return null;
        revert(e);
        this.undone.push(e);
        return e.label;
    }

    redo(): string | null {
        const e = this.undone.pop();
        if (!e) return null;
        for (const a of e.assignments) {
            if (a.hasNext) a.target[a.key] = a.next;
            else delete a.target[a.key];
        }
        this.done.push(e);
        return e.label;
    }
}

function revert(e: Edit): void {
    for (let i = e.assignments.length - 1; i >= 0; i--) {
        const a = e.assignments[i]!;
        if (a.had) a.target[a.key] = a.previous;
        else delete a.target[a.key];
    }
}
