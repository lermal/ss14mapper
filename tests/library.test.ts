import { describe, expect, it } from "vitest";
import { formatSize, formatWhen, MapLibrary, mapFileName, memoryBackend, usedBytes, type LibraryBackend } from "../src/ui/library";

/** A library on an in-memory backend with a clock and ids that count up. */
function make(backend: LibraryBackend | null = memoryBackend()) {
    let t = 1000, n = 0, persisted = 0;
    const lib = new MapLibrary(backend, { now: () => t, newId: () => `id${++n}`, persist: () => void persisted++ });
    return { lib, tick: (dt = 1) => (t += dt), persisted: () => persisted };
}

describe("map library", () => {
    it("keeps opened files once per name and text, newest first", async () => {
        const { lib, tick, persisted } = make();
        const a = (await lib.addOpened("box.yml", "upstream", "a: 1\n"))!;
        tick();
        const b = (await lib.addOpened("barnacle.yml", "frontier", "b: 2\n"))!;
        tick();
        // the same file again: the same record, on top, with the build it was opened with
        const again = (await lib.addOpened("box.yml", "goob", "a: 1\n"))!;
        expect(again.id).toBe(a.id);
        expect((await lib.list()).map((e) => [e.name, e.build])).toEqual([["box.yml", "goob"], ["barnacle.yml", "frontier"]]);
        tick();
        // the same name with other text (edited elsewhere): a record of its own, so the browser copy stays
        const changed = (await lib.addOpened("box.yml", "upstream", "a: 2\n"))!;
        expect(changed.id).not.toBe(a.id);
        expect((await lib.list()).map((e) => e.id)).toEqual([changed.id, a.id, b.id]);
        // opening is not saving: persistent storage is asked on the first save only
        expect(persisted()).toBe(0);
        await lib.save({ id: a.id, name: "box.yml", build: "upstream" }, "a: 3\n");
        await lib.create("c.yml", "upstream", "c\n");
        expect(persisted()).toBe(1);
    });

    it("saves, saves as, renames and reopens with the text", async () => {
        const { lib, tick } = make();
        const e = (await lib.addOpened("tug.yml", "upstream", "x\n"))!;
        tick();
        const saved = (await lib.save({ id: e.id, name: e.name, build: "frontier" }, "x\ny ü\n"))!;
        expect(saved).toMatchObject({ id: e.id, build: "frontier", savedAt: 1001, size: 7 });
        const copy = (await lib.create("tug copy.yml", "frontier", "x\ny ü\n"))!;
        expect(copy.id).not.toBe(e.id);
        expect(await lib.update(copy.id, { name: "tug 2.yml" })).toMatchObject({ name: "tug 2.yml", size: 7 });
        tick();
        const r = (await lib.open(e.id))!;
        expect(r).toMatchObject({ name: "tug.yml", text: "x\ny ü\n", openedAt: 1002 });
        expect((await lib.list())[0]!.id).toBe(e.id);
        expect(await lib.open("nope")).toBeNull();
        expect(await lib.update("nope", { name: "z" })).toBeNull();
        expect(usedBytes(await lib.list())).toBe(14);
    });

    it("deletes and restores a record whole", async () => {
        const backend = memoryBackend();
        const { lib } = make(backend);
        const e = (await lib.create("a.yml", "upstream", "text\n"))!;
        const gone = (await lib.remove(e.id))!;
        expect(gone).toMatchObject({ id: e.id, name: "a.yml", text: "text\n" });
        expect(await lib.list()).toEqual([]);
        expect(backend.texts.size).toBe(0);
        expect(await lib.restore(gone)).toBe(true);
        expect((await lib.open(e.id))?.text).toBe("text\n");
    });

    it("answers empty or null when storage fails or is missing", async () => {
        const fail = async () => {
            throw new Error("denied");
        };
        const broken: LibraryBackend = { entries: fail, text: fail, put: fail, remove: fail };
        for (const backend of [broken, null]) {
            const { lib } = make(backend);
            expect(await lib.list()).toEqual([]);
            expect(await lib.addOpened("a.yml", "f", "t")).toBeNull();
            expect(await lib.create("a.yml", "f", "t")).toBeNull();
            expect(await lib.save({ id: "x", name: "a.yml", build: "f" }, "t")).toBeNull();
            expect(await lib.open("x")).toBeNull();
            expect(await lib.remove("x")).toBeNull();
        }
        // a broken record in storage is skipped
        const mem = memoryBackend();
        await mem.put({ id: 5 } as never, "t");
        await mem.put({ id: "ok", name: "b.yml", build: "f", savedAt: 1, openedAt: 1, size: 1 }, "t");
        expect((await make(mem).lib.list()).map((e) => e.id)).toEqual(["ok"]);
    });
});

describe("names and text", () => {
    it("makes file names from what was typed", () => {
        expect(mapFileName("Tug")).toBe("Tug.yml");
        expect(mapFileName("  my  ship.yaml ")).toBe("my ship.yaml");
        expect(mapFileName("a/b:c")).toBe("a b c.yml");
        expect(mapFileName("  ")).toBe("");
    });
    it("says when, in local time", () => {
        const now = new Date(2026, 10, 14, 18, 0).getTime();
        expect(formatWhen(new Date(2026, 10, 14, 14, 2).getTime(), now)).toBe("today, 14:02");
        expect(formatWhen(new Date(2026, 10, 13, 23, 59).getTime(), now)).toBe("yesterday");
        expect(formatWhen(new Date(2026, 10, 12, 9, 0).getTime(), now)).toBe("12 Nov");
        expect(formatWhen(new Date(2025, 0, 3).getTime(), now)).toBe("3 Jan 2025");
    });
    it("says sizes", () => {
        expect(formatSize(820)).toBe("820 B");
        expect(formatSize(14_300)).toBe("14 KB");
        expect(formatSize(1_420_000)).toBe("1.4 MB");
        expect(formatSize(23_600_000)).toBe("24 MB");
    });
});
