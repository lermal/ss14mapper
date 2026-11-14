import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { decalEntries, decalIconFrame, entityEntries, entityIconFrame, entryIconFrame, search, tileEntries, tileIconFrame } from "../src/ui/palette-search";
import { packFor } from "./pack-files";

const upstream = packFor("upstream");
const frontier = packFor("frontier");
const goob = packFor("goob");

describe.skipIf(!upstream)("palette (upstream)", () => {
    const pack = upstream!;
    const entities = entityEntries(pack);

    it("excludes hidden prototypes", () => {
        const hidden = Object.entries(pack.prototypes.entities).filter(([, p]) => p.hidden);
        expect(hidden.length).toBeGreaterThan(0);
        const ids = new Set(entities.map((e) => e.id));
        for (const [id] of hidden) expect(ids.has(id)).toBe(false);
        expect(entities.length).toBe(Object.keys(pack.prototypes.entities).length - hidden.length);
    });

    it("ranks WallSolid first for 'wall solid'", () => {
        expect(search(entities, "wall solid")[0]!.id).toBe("WallSolid");
    });

    it("ranks an exact id first, case-insensitively", () => {
        for (const id of ["Crowbar", "APCBasic", "airlock"]) {
            const hit = entities.find((e) => e.lid === id.toLowerCase());
            if (hit) expect(search(entities, id)[0]!.id).toBe(hit.id);
        }
        expect(search(entities, "crowbar")[0]!.id).toBe("Crowbar");
    });

    it("requires all words and lists everything for an empty query", () => {
        expect(search(entities, "").length).toBe(entities.length);
        expect(search(entities, "zzzqqq nothing")).toEqual([]);
        const c = new Intl.Collator("en", { sensitivity: "base", numeric: true });
        for (let i = 1; i < entities.length; i++) expect(c.compare(entities[i - 1]!.name, entities[i]!.name)).toBeLessThanOrEqual(0);
    });

    it("lists tiles without Space but with Plating", () => {
        const tiles = tileEntries(pack);
        const ids = tiles.map((t) => t.id);
        expect(ids).toContain("Plating");
        expect(ids).not.toContain("Space");
        for (const [id, t] of Object.entries(pack.prototypes.tiles)) {
            if (t.sprite && id !== "Space") expect(tileIconFrame(pack, id), id).not.toBeNull();
        }
    });

    it("lists decals of the decal placer with their sprites, searchable", () => {
        const decals = decalEntries(pack);
        const hidden = Object.entries(pack.prototypes.decals).filter(([, d]) => d.hidden);
        expect(hidden.length).toBeGreaterThan(0);
        const ids = new Set(decals.map((d) => d.id));
        for (const [id] of hidden) expect(ids.has(id)).toBe(false);
        expect(ids.has("WarnLineN")).toBe(true);
        expect(decals.every((d) => d.kind === "decal")).toBe(true);
        const missing = decals.filter((d) => !decalIconFrame(pack, d.id));
        expect(missing.map((d) => d.id)).toEqual([]);
        expect(entryIconFrame(pack, "decal", "WarnLineN")).toEqual(decalIconFrame(pack, "WarnLineN"));
        expect(search(decals, "warnline n")[0]!.id).toBe("WarnLineN");
    });

    it("resolves icons for most visible entities", () => {
        const ok = entities.filter((e) => entityIconFrame(pack, e.id)).length;
        const share = ok / entities.length;
        fs.writeSync(2, `upstream icon coverage: ${ok}/${entities.length} = ${(share * 100).toFixed(1)}%\n`);
        expect(share).toBeGreaterThan(0.9);
    });
});

describe.skipIf(!frontier)("palette (frontier)", () => {
    it("resolves icons for most visible entities", () => {
        const es = entityEntries(frontier!);
        const ok = es.filter((e) => entityIconFrame(frontier!, e.id)).length;
        fs.writeSync(2, `frontier icon coverage: ${ok}/${es.length} = ${((ok / es.length) * 100).toFixed(1)}%\n`);
        expect(ok / es.length).toBeGreaterThan(0.9);
    });
});

describe.skipIf(!goob)("palette (goob)", () => {
    it("searches the full list in under 20 ms", () => {
        const es = entityEntries(goob!);
        search(es, "warm up");
        for (const q of ["wall solid", "a", "crowbar", "xyzzy"]) {
            const t = performance.now();
            search(es, q);
            const ms = performance.now() - t;
            fs.writeSync(2, `goob search "${q}" over ${es.length}: ${ms.toFixed(2)} ms\n`);
            expect(ms).toBeLessThan(20);
        }
    });
});
