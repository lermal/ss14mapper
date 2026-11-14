import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildIndex } from "../src/pack/format";
import { missingIn, pickBuild } from "../src/pack/pick";
import { packFor, packsDir } from "./pack-files";

const idx = (entities: string[], migrations: BuildIndex["migrations"] = {}): BuildIndex => ({ entities, tiles: [], migrations });

describe("missingIn", () => {
    it("counts distinct prototypes a build lacks", () => {
        expect(missingIn(["A", "A", "B", "C"], idx(["A"]))).toBe(2);
    });
    it("follows renames and ignores removed prototypes", () => {
        const index = idx(["New"], { Old: "New", Chain1: "Old", Gone: null });
        expect(missingIn(["Old", "Chain1", "Gone"], index)).toBe(0);
        expect(missingIn(["Old2"], { ...index, migrations: { ...index.migrations, Old2: "Nope" } })).toBe(1);
    });
});

describe("pickBuild", () => {
    const builds: Record<string, BuildIndex> = { a: idx(["X"]), b: idx(["X", "Y"]), c: idx(["X", "Y"]) };
    const tracked = () => {
        const loaded: string[] = [];
        let active = 0;
        let peak = 0;
        const load = async (id: string) => {
            loaded.push(id);
            peak = Math.max(peak, ++active);
            await new Promise((r) => setTimeout(r, 1));
            active--;
            return builds[id]!;
        };
        return { loaded, load, peak: () => peak };
    };

    it("stops at the current build when it misses nothing", async () => {
        const t = tracked();
        expect(await pickBuild(["X"], ["a", "b", "c"], "a", t.load)).toBeNull();
        expect(t.loaded).toEqual(["a"]);
    });
    it("picks the best build, the first one on a tie", async () => {
        expect(await pickBuild(["X", "Y"], ["a", "b", "c"], "a", tracked().load)).toEqual({ id: "b", missing: 0, was: 1 });
    });
    it("keeps the current build when nothing beats it", async () => {
        expect(await pickBuild(["Z"], ["a", "b", "c"], "b", tracked().load)).toBeNull();
    });
    it("limits how many builds load at once", async () => {
        const many = Array.from({ length: 12 }, (_, i) => `b${i}`);
        let active = 0;
        let peak = 0;
        const load = async (id: string) => {
            peak = Math.max(peak, ++active);
            await new Promise((r) => setTimeout(r, 2));
            active--;
            return idx(id === "b7" ? ["X"] : []);
        };
        expect(await pickBuild(["X"], many, "b0", load, 4)).toEqual({ id: "b7", missing: 0, was: 1 });
        expect(peak).toBe(4);
    });
    it("fails when a build cannot be loaded", async () => {
        await expect(pickBuild(["X"], ["a", "b"], "a", (id) => (id === "b" ? Promise.reject(new Error("x")) : Promise.resolve(idx([]))))).rejects.toThrow();
    });
});

describe("pack index file", () => {
    for (const id of ["frontier", "upstream", "goob"]) {
        const pack = packFor(id);
        it.skipIf(!pack?.manifest.files.index)(`${id}: matches the prototypes`, () => {
            const index: BuildIndex = JSON.parse(fs.readFileSync(path.join(packsDir, id, pack!.manifest.files.index!), "utf8"));
            expect(index.entities).toEqual(Object.keys(pack!.prototypes.entities).sort());
            expect(index.tiles).toEqual(Object.keys(pack!.prototypes.tiles).sort());
            expect(index.migrations).toEqual(pack!.prototypes.migrations);
        });
    }
});
