import { describe, expect, it } from "vitest";
import type { SettingsDoc, SettingsKind } from "../src/api/client";
import { mergeCategories, mergeKeys, readCategoriesDoc, type Bindings } from "../src/api/settings-merge";
import { SettingsSync, type SyncStorage } from "../src/api/settings-sync";
import { Keymap } from "../src/editor/keymap";
import { Categories, FAVOURITES, type CategoriesFile } from "../src/ui/categories";

const file = (cats: Record<string, string[]>): CategoriesFile => {
    const c = new Categories();
    for (const [name, ids] of Object.entries(cats)) {
        if (name !== FAVOURITES) c.create(name);
        for (const id of ids) c.add(name, { kind: "entity", id });
    }
    return c.toFile();
};
const names = (f: CategoriesFile | undefined) => Object.fromEntries((f?.categories ?? []).map((c) => [c.name, c.entries.map((e) => e.id)]));
const all = () => true;

describe("mergeKeys", () => {
    it("first sync: the server's bindings over the defaults, overrides made here win", () => {
        const server: Bindings = { "tool.brush": ["KeyN"], "tool.erase": ["KeyJ"] };
        const local: Bindings = { "tool.brush": ["KeyT"], "view.grid": [] };
        expect(mergeKeys(server, local, null, all)).toEqual({ "tool.brush": ["KeyT"], "tool.erase": ["KeyJ"], "view.grid": [] });
        expect(mergeKeys(server, {}, null, all)).toEqual(server);
        expect(mergeKeys(null, local, null, all)).toEqual(local);
    });

    it("later syncs: only what changed here since the base wins, resets included", () => {
        const base: Bindings = { "tool.brush": ["KeyN"], "tool.erase": ["KeyJ"] };
        const server: Bindings = { "tool.brush": ["KeyY"], "tool.erase": ["KeyJ"], "view.grid": ["KeyZ"] };
        // erase reset to its default here, brush untouched here
        const local: Bindings = { "tool.brush": ["KeyN"] };
        expect(mergeKeys(server, local, base, all)).toEqual({ "tool.brush": ["KeyY"], "view.grid": ["KeyZ"] });
    });

    it("keeps the server's bindings of actions this version does not know", () => {
        expect(mergeKeys({ "future.action": ["KeyF"] }, {}, null, (id) => id !== "future.action")).toEqual({ "future.action": ["KeyF"] });
        expect(mergeKeys({ "future.action": ["KeyF"] }, {}, { "future.action": ["KeyF"] }, (id) => id !== "future.action")).toEqual({ "future.action": ["KeyF"] });
    });
});

describe("mergeCategories", () => {
    it("first sync: joins by name like an import, entries unioned, new categories appended", () => {
        const server = { frontier: file({ [FAVOURITES]: ["A"], Walls: ["W1", "W2"], Lights: ["L"] }), goob: file({ Doors: ["D"] }) };
        const local = { frontier: file({ [FAVOURITES]: ["B"], Walls: ["W3"], Pipes: ["P"] }) };
        const out = mergeCategories(server, local, null);
        expect(names(out.frontier)).toEqual({ [FAVOURITES]: ["B", "A"], Walls: ["W3", "W1", "W2"], Pipes: ["P"], Lights: ["L"] });
        expect(names(out.goob)).toEqual({ [FAVOURITES]: [], Doors: ["D"] });
    });

    it("takes one side as it is when only that side changed (deletions survive)", () => {
        const base = { frontier: file({ Walls: ["W1"], Old: ["O"] }) };
        const serverOnly = { frontier: file({ Walls: ["W1", "W2"] }) };
        expect(names(mergeCategories(serverOnly, base, base).frontier)).toEqual({ [FAVOURITES]: [], Walls: ["W1", "W2"] });
        const localOnly = { frontier: file({ Walls: ["W1"] }) };
        expect(names(mergeCategories(base, localOnly, base).frontier)).toEqual({ [FAVOURITES]: [], Walls: ["W1"] });
    });

    it("reads documents leniently", () => {
        expect(readCategoriesDoc({ version: 1, forks: { a: { version: 1, categories: [] }, b: { nope: 1 } } })).toEqual({ a: { version: 1, categories: [{ name: FAVOURITES, entries: [] }] } });
        expect(readCategoriesDoc({ version: 2, forks: {} })).toBeNull();
        expect(readCategoriesDoc(null)).toBeNull();
    });
});

// ---- the sync over a fake server and storage

class MemStorage implements SyncStorage {
    readonly data = new Map<string, string>();
    get length() {
        return this.data.size;
    }
    key(i: number) {
        return [...this.data.keys()][i] ?? null;
    }
    getItem(k: string) {
        return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string) {
        this.data.set(k, v);
    }
    removeItem(k: string) {
        this.data.delete(k);
    }
    clear() {
        this.data.clear();
    }
}

class FakeServer {
    docs: Record<SettingsKind, SettingsDoc> = { keys: { revision: 0, data: null }, categories: { revision: 0, data: null } };
    puts: Array<{ kind: SettingsKind; revision: number; data: unknown }> = [];
    /** Runs before a PUT is answered (another browser writing first). */
    beforePut: ((kind: SettingsKind) => void) | null = null;

    async getSettings(kind: SettingsKind) {
        return structuredClone(this.docs[kind]);
    }

    async putSettings(kind: SettingsKind, revision: number, data: unknown) {
        this.puts.push({ kind, revision, data });
        this.beforePut?.(kind);
        const cur = this.docs[kind];
        if (revision !== cur.revision) return { ok: false as const, doc: structuredClone(cur) };
        this.docs[kind] = { revision: cur.revision + 1, data: structuredClone(data) };
        return { ok: true as const, doc: structuredClone(this.docs[kind]) };
    }
}

function browser(server: FakeServer) {
    const storage = new MemStorage();
    const keymap = new Keymap(undefined, storage);
    const reloaded: string[][] = [];
    const warnings: string[] = [];
    const sync = new SettingsSync({
        api: server,
        storage,
        keys: { known: (id) => !!keymap.action(id), get: () => keymap.overridesById(), set: (b) => keymap.replaceOverrides(b) },
        categoriesChanged: (forks) => reloaded.push(forks),
        delay: 1,
        warn: (m) => warnings.push(m),
    });
    keymap.onChange(() => sync.changed("keys"));
    return { storage, keymap, sync, reloaded, warnings };
}

const categoriesIn = (storage: MemStorage, fork: string) => names(Categories.fromJSON(storage.getItem(`ss14mapper.categories.${fork}`)).toFile());

describe("SettingsSync", () => {
    it("first sign-in merges both ways and pushes the result", async () => {
        const server = new FakeServer();
        server.docs.keys = { revision: 3, data: { version: 1, bindings: { "tool.erase": ["KeyJ"], "tool.brush": ["KeyN"] } } };
        server.docs.categories = { revision: 1, data: { version: 1, forks: { frontier: file({ Walls: ["W1"] }) } } };
        const b = browser(server);
        b.keymap.set("tool.brush", ["KeyT"]);
        b.storage.setItem("ss14mapper.categories.frontier", JSON.stringify(file({ Pipes: ["P"] })));
        await b.sync.start(7);
        expect(b.keymap.bindings("tool.brush")).toEqual(["KeyT"]);
        expect(b.keymap.bindings("tool.erase")).toEqual(["KeyJ"]);
        expect(categoriesIn(b.storage, "frontier")).toEqual({ [FAVOURITES]: [], Pipes: ["P"], Walls: ["W1"] });
        expect(b.reloaded).toEqual([["frontier"]]);
        expect(server.docs.keys).toEqual({ revision: 4, data: { version: 1, bindings: { "tool.brush": ["KeyT"], "tool.erase": ["KeyJ"] } } });
        expect(server.docs.categories.revision).toBe(2);
        expect(b.warnings).toEqual([]);
    });

    it("does not push when nothing changed", async () => {
        const server = new FakeServer();
        server.docs.keys = { revision: 2, data: { version: 1, bindings: { "tool.brush": ["KeyN"] } } };
        const b = browser(server);
        await b.sync.start(1);
        expect(b.keymap.bindings("tool.brush")).toEqual(["KeyN"]);
        expect(server.puts).toEqual([]);
    });

    it("pushes later edits after the delay, with the revision it last saw", async () => {
        const server = new FakeServer();
        const b = browser(server);
        await b.sync.start(1);
        b.keymap.set("view.grid", ["KeyZ"]);
        await new Promise((r) => setTimeout(r, 10));
        await b.sync.pushNow("keys");
        expect(server.docs.keys).toEqual({ revision: 1, data: { version: 1, bindings: { "view.grid": ["KeyZ"] } } });
        b.keymap.reset("view.grid");
        await b.sync.pushNow("keys");
        expect(server.docs.keys).toEqual({ revision: 2, data: { version: 1, bindings: {} } });
    });

    it("on 409 merges with the server's document and retries once", async () => {
        const server = new FakeServer();
        const b = browser(server);
        await b.sync.start(1);
        // another browser stores a binding first
        server.beforePut = (kind) => {
            server.beforePut = null;
            const cur = server.docs[kind];
            server.docs[kind] = { revision: cur.revision + 1, data: { version: 1, bindings: { "tool.erase": ["KeyJ"] } } };
        };
        b.keymap.set("tool.brush", ["KeyT"]);
        await b.sync.pushNow("keys");
        expect(server.puts.map((p) => p.revision)).toEqual([0, 1]);
        expect(server.docs.keys).toEqual({ revision: 2, data: { version: 1, bindings: { "tool.brush": ["KeyT"], "tool.erase": ["KeyJ"] } } });
        // the other browser's binding arrived here too
        expect(b.keymap.bindings("tool.erase")).toEqual(["KeyJ"]);
        expect(b.warnings).toEqual([]);
    });

    it("stops after the second conflict with one warning", async () => {
        const server = new FakeServer();
        const b = browser(server);
        await b.sync.start(1);
        server.beforePut = (kind) => {
            const cur = server.docs[kind];
            server.docs[kind] = { revision: cur.revision + 1, data: { version: 1, bindings: { "tool.erase": [`Key${"ABC"[cur.revision]}`] } } };
        };
        b.keymap.set("tool.brush", ["KeyT"]);
        await b.sync.pushNow("keys");
        b.keymap.set("tool.brush", ["KeyY"]);
        await b.sync.pushNow("keys");
        expect(server.puts).toHaveLength(4);
        expect(b.warnings).toHaveLength(1);
    });

    it("syncs between two browsers of one user", async () => {
        const server = new FakeServer();
        const one = browser(server);
        const two = browser(server);
        await one.sync.start(5);
        one.keymap.set("tool.brush", ["KeyT"]);
        one.storage.setItem("ss14mapper.categories.goob", JSON.stringify(file({ Doors: ["D"] })));
        await one.sync.pushNow("keys");
        await one.sync.pushNow("categories");
        await two.sync.start(5);
        expect(two.keymap.bindings("tool.brush")).toEqual(["KeyT"]);
        expect(categoriesIn(two.storage, "goob")).toEqual({ [FAVOURITES]: [], Doors: ["D"] });
        // a category deleted in the second browser stays deleted in the first after its next sign-in
        two.storage.setItem("ss14mapper.categories.goob", JSON.stringify(file({})));
        await two.sync.pushNow("categories");
        await one.sync.start(5);
        expect(categoriesIn(one.storage, "goob")).toEqual({ [FAVOURITES]: [] });
    });

    it("does nothing after sign-out", async () => {
        const server = new FakeServer();
        const b = browser(server);
        await b.sync.start(1);
        b.sync.stop();
        b.keymap.set("tool.brush", ["KeyT"]);
        await new Promise((r) => setTimeout(r, 10));
        expect(server.puts).toEqual([]);
    });

    it("never rejects when the server is down", async () => {
        const b = browser(new FakeServer());
        const down = { getSettings: () => Promise.reject(new Error("offline")), putSettings: () => Promise.reject(new Error("offline")) };
        const sync = new SettingsSync({ api: down, storage: b.storage, keys: { known: all, get: () => ({}), set: () => {} }, categoriesChanged: () => {}, warn: (m) => b.warnings.push(m) });
        await expect(sync.start(1)).resolves.toBeUndefined();
        expect(b.warnings).toEqual(["Settings sync failed: offline"]);
    });
});
