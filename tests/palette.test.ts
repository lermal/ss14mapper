import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { PackManifest } from "../src/pack/format";
import { Pack } from "../src/pack/loader";
import { decalEntries, decalIconFrame, entityEntries, entityIconFrame, entryIconFrame, search, tileEntries, tileIconFrame } from "../src/ui/palette-search";
import { packFor } from "./pack-files";

const upstream = packFor("upstream");
const frontier = packFor("frontier");
const goob = packFor("goob");

describe("palette translations", () => {
    const makePack = (files: PackManifest["files"], read: (file: string) => Promise<unknown>) => Pack.fromData({
        format: 1,
        fork: { id: "test", repo: "", branch: "", commit: "", engineCommit: null },
        builtAt: "",
        files,
        stats: { entities: 3, placeable: 3, tiles: 0, decals: 0, rsi: 0, frames: 0, pages: 0 },
    }, {
        entities: {
            WallSolid: { name: "solid wall", suffix: "Station", components: {} },
            AirAlarm: { name: "air alarm", components: {} },
            Prop: { name: "office desk", components: {} },
        },
        tiles: {}, decals: {}, stacks: {}, colors: {}, migrations: {}, tileAliases: {},
    }, { pages: [], textures: {}, rsi: {} }, read);

    it("matches a regional translation and falls back separately for name, suffix and description", async () => {
        const reads: string[] = [];
        const files = { prototypes: "", textures: "", paletteLocales: { en: "en.json", "ru-RU": "ru.json", "fr-FR": "fr.json" } };
        const pack = makePack(files, async (file) => {
            reads.push(file);
            if (file === "en.json") return { WallSolid: { description: "Keeps air inside." }, AirAlarm: { description: "An alarm." } };
            if (file === "ru.json") return { WallSolid: { name: "прочная стена" }, AirAlarm: { description: "Следит за воздухом." } };
            throw new Error("Missing file");
        });
        const rows = entityEntries(pack, await pack.paletteText("ru"), "ru");
        expect(search(rows, "прочная стена")[0]).toMatchObject({ id: "WallSolid", name: "прочная стена", suffix: "Station", description: "Keeps air inside." });
        expect(search(rows, "solid wall")[0]?.id).toBe("WallSolid");
        expect(search(rows, "AIRALARM")[0]).toMatchObject({ name: "air alarm", description: "Следит за воздухом." });
        expect(search(rows, "office desk")[0]).toMatchObject({ name: "office desk" });
        expect(reads).toEqual(["en.json", "ru.json"]);
        await expect(pack.paletteText("fr")).resolves.toEqual(await pack.paletteText("en"));
        expect(reads).toEqual(["en.json", "ru.json", "fr.json"]);
    });

    it("uses English descriptions from packs built before palette locale files were added", async () => {
        const pack = makePack({ prototypes: "", textures: "", prototypeData: "full.json" }, async () => ({
            entities: { WallSolid: { components: {}, description: "Keeps air inside." } },
        }));
        expect(entityEntries(pack, await pack.paletteText("ru"))).toContainEqual(expect.objectContaining({
            id: "WallSolid", name: "solid wall", description: "Keeps air inside.",
        }));
    });
});

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
