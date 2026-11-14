import { describe, expect, it, vi } from "vitest";
import { handleStorageEvent, watchOtherTabs } from "../src/editor/cross-tab";
import { Keymap, type KeyStorage } from "../src/editor/keymap";

const mem = (init: Record<string, string> = {}): KeyStorage & { data: Map<string, string>; writes: number } => {
    const data = new Map(Object.entries(init));
    return {
        data,
        writes: 0,
        getItem: (k) => data.get(k) ?? null,
        setItem(k, v) {
            this.writes++;
            data.set(k, v);
        },
        removeItem(k) {
            this.writes++;
            data.delete(k);
        },
    };
};

function target() {
    return { keysChanged: vi.fn(), categoriesChanged: vi.fn() };
}

describe("handleStorageEvent", () => {
    const area = {};
    it("routes the keymap key and per-build categories keys", () => {
        const t = target();
        handleStorageEvent({ key: "ss14mapper.keys", storageArea: area }, area, t);
        handleStorageEvent({ key: "ss14mapper.categories.fork-a", storageArea: area }, area, t);
        expect(t.keysChanged).toHaveBeenCalledTimes(1);
        expect(t.categoriesChanged).toHaveBeenCalledWith(["fork-a"]);
    });

    it("ignores other keys and other storage areas", () => {
        const t = target();
        handleStorageEvent({ key: "ss14mapper.sync", storageArea: area }, area, t);
        handleStorageEvent({ key: "ss14mapper.palette.grid", storageArea: area }, area, t);
        handleStorageEvent({ key: "ss14mapper.keys", storageArea: {} }, area, t);
        expect(t.keysChanged).not.toHaveBeenCalled();
        expect(t.categoriesChanged).not.toHaveBeenCalled();
    });

    it("a cleared storage reloads keys", () => {
        const t = target();
        handleStorageEvent({ key: null, storageArea: area }, area, t);
        expect(t.keysChanged).toHaveBeenCalledTimes(1);
    });

    it("watchOtherTabs listens until stopped", () => {
        const listeners = new Set<(e: Event) => void>();
        const win = {
            addEventListener: (_: string, f: (e: Event) => void) => void listeners.add(f),
            removeEventListener: (_: string, f: (e: Event) => void) => void listeners.delete(f),
        };
        const t = target();
        const stop = watchOtherTabs(t, win as never, null);
        for (const f of listeners) f({ key: "ss14mapper.keys" } as unknown as Event);
        expect(t.keysChanged).toHaveBeenCalledTimes(1);
        stop();
        expect(listeners.size).toBe(0);
    });
});

describe("Keymap.reload", () => {
    it("takes the overrides another tab stored, tells listeners and does not write", () => {
        const store = mem();
        const km = new Keymap(undefined, store);
        const id = km.actions[0]!.id;
        const fired = vi.fn();
        km.onChange(fired);
        store.data.set("ss14mapper.keys", JSON.stringify({ [id]: ["KeyZ"] }));
        km.reload();
        expect(km.bindings(id)).toEqual(["KeyZ"]);
        expect(fired).toHaveBeenCalledTimes(1);
        expect(store.writes).toBe(0);
        store.data.delete("ss14mapper.keys");
        km.reload();
        expect(km.isDefault(id)).toBe(true);
    });
});
