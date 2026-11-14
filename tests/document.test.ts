import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAngle, formatFloat, formatSaveTime, MapDocument } from "../src/map/document";
import { decodeChunk, encodeChunk } from "../src/map/tiles";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";

const root: string = corpusRoot();
const SAMPLES = [
    "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml", // format 7 shuttle
    "frontier/Resources/Maps/_NF/Shuttles/placebo.yml", // format 6 shuttle
    "upstream/Resources/Maps/Shuttles/emergency.yml",
    "goob/Resources/Maps/_Goobstation/chloris.yml", // large station
].filter((f) => fs.existsSync(path.join(root, f)));

const NOW = new Date(2026, 10, 13, 12, 34, 56);

/** Lines that differ between two files, ignoring meta.time; common start and end are skipped. */
function changed(before: string, after: string): { removed: string[]; added: string[] } {
    const strip = (s: string) => s.split("\n").filter((l) => !/^  time: /.test(l));
    const a = strip(before);
    const b = strip(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

function firstWith(doc: MapDocument, test: (uid: number) => boolean): number {
    const uid = doc.uids().find(test);
    if (uid === undefined) throw new Error("no matching entity");
    return uid;
}

/** The grid with the most entities on it. */
function gridOf(doc: MapDocument): number {
    const grids = doc.grids();
    if (!grids.length) throw new Error("no grid");
    const count = (g: number) => doc.uids().filter((u) => doc.transform(u).parent === g).length;
    return grids.reduce((best, g) => (count(g) > count(best) ? g : best));
}

describe("number formatting", () => {
    it("writes floats and angles like .NET", () => {
        expect(formatFloat(-4.5)).toBe("-4.5");
        expect(formatFloat(0.78109145)).toBe("0.78109145");
        expect(formatFloat(0)).toBe("0");
        expect(formatAngle(Math.PI / 2)).toBe("1.5707963267948966 rad");
        expect(formatAngle(Math.PI)).toBe("3.141592653589793 rad");
        expect(formatSaveTime(NOW)).toBe("11/13/2026 12:34:56");
    });

    it("re-encodes tile chunks to the same text", () => {
        const b64 = "WgAAAAADWgAAAAACegAAAAAA";
        expect(encodeChunk(decodeChunk(b64, 6), 6)).toBe(b64);
    });
});

describe.skipIf(SAMPLES.length === 0).each(SAMPLES)("edits of %s", (file) => {
    const original = fs.readFileSync(path.join(root, file), "utf8");
    const open = () => new MapDocument(original);

    it("saves an unedited map unchanged, even after undoing edits", () => {
        const doc = open();
        expect(doc.serialize(NOW)).toBe(original);
        const grid = gridOf(doc);
        const some = firstWith(doc, (u) => doc.transform(u).parent === grid);
        doc.moveEntity(some, 1.5, 2.5);
        doc.rotateEntity(some, Math.PI / 2);
        const placed = doc.addEntity("WallSolid", grid, 0.5, 0.5);
        doc.deleteEntity(placed);
        doc.setTile(grid, 0, 0, "FloorSteel");
        while (doc.undo());
        expect(doc.serialize(NOW)).toBe(original);
    });

    it("changes only the position line when an entity moves", () => {
        const doc = open();
        const grid = gridOf(doc);
        const uid = firstWith(doc, (u) => doc.transform(u).parent === grid);
        const before = doc.transform(uid);
        doc.moveEntity(uid, before.x + 1, before.y);
        const out = doc.serialize(NOW);
        const diff = changed(original, out);
        expect(diff.removed).toEqual([expect.stringMatching(/^ +pos: /)]);
        expect(diff.added).toEqual([expect.stringMatching(new RegExp(`^ +pos: ${formatFloat(before.x + 1).replace(".", "\\.")},`))]);
        expect(new MapDocument(out).transform(uid).x).toBeCloseTo(before.x + 1, 5);
        if (/^  time: /m.test(original)) expect(out).toContain("  time: 11/13/2026 12:34:56");
    });

    it("writes and removes rotation", () => {
        const doc = open();
        const grid = gridOf(doc);
        const uid = firstWith(doc, (u) => doc.transform(u).parent === grid && doc.transform(u).rotation === 0);
        doc.rotateEntity(uid, Math.PI / 2);
        const diff = changed(original, doc.serialize(NOW));
        expect(diff.removed).toEqual([]);
        expect(diff.added).toEqual([expect.stringMatching(/^ +rot: 1\.5707963267948966 rad$/)]);
        doc.rotateEntity(uid, 0);
        expect(doc.serialize(NOW).split("\n").filter((l) => !l.startsWith("  time:"))).toEqual(
            original.split("\n").filter((l) => !l.startsWith("  time:")),
        );
    });

    it("places entities into existing and new prototype groups", () => {
        const doc = open();
        const grid = gridOf(doc);
        const known = doc.proto(firstWith(doc, (u) => doc.proto(u) !== "" && doc.transform(u).parent === grid))!;
        const a = doc.addEntity(known, grid, 2.5, 3.5);
        const b = doc.addEntity("SS14MapperTestProto", grid, -1.5, 0.5, Math.PI);
        const out = doc.serialize(NOW);
        const reread = new MapDocument(out);
        expect(reread.proto(a)).toBe(known);
        expect(reread.proto(b)).toBe("SS14MapperTestProto");
        expect(reread.transform(b)).toEqual({ x: -1.5, y: 0.5, rotation: Math.PI, parent: grid });
        expect(new MapDocument(out).serialize(NOW)).toBe(out);
        // in the Transform field order of the map's engine: newer ones write the parent first
        const parentFirst = /- type: Transform\n {6}parent: /.test(original) && !/- type: Transform\n( {6}rot: .*\n)? {6}pos: .*\n {6}parent: /.test(original);
        const fields = parentFirst
            ? [`      parent: ${grid}`, "      rot: 3.141592653589793 rad", "      pos: -1.5,0.5"]
            : ["      rot: 3.141592653589793 rad", "      pos: -1.5,0.5", `      parent: ${grid}`];
        expect(out).toContain(["- proto: SS14MapperTestProto", "  entities:", `  - uid: ${b}`, "    components:", "    - type: Transform", ...fields].join("\n"));
        const count = /^  entityCount: (\d+)$/m.exec(original);
        if (count) expect(out).toContain(`  entityCount: ${Number(count[1]) + 2}`);
    });

    it("deletes an entity with everything inside it", () => {
        const doc = open();
        const grid = gridOf(doc);
        const holder = doc.uids().find((u) => u !== grid && doc.proto(u) !== "" && doc.descendants(u).length > 0);
        if (holder === undefined) return;
        const inside = doc.descendants(holder);
        const removed = doc.deleteEntity(holder);
        expect(removed.sort()).toEqual([holder, ...inside].sort());
        const reread = new MapDocument(doc.serialize(NOW));
        for (const id of removed) expect(reread.proto(id)).toBeUndefined();
        expect(reread.uids().length).toBe(doc.uids().length);
    });

    it("paints tiles in place and adds new tile names to the tilemap", () => {
        const doc = open();
        const grid = gridOf(doc);
        doc.setTile(grid, 0, 0, "Plating");
        doc.setTile(grid, 1, 0, "SS14MapperTestFloor");
        const out = doc.serialize(NOW);
        const reread = new MapDocument(out);
        const names = reread.tilemap();
        expect(names.get(reread.tile(grid, 0, 0).id)).toBe("Plating");
        expect(names.get(reread.tile(grid, 1, 0).id)).toBe("SS14MapperTestFloor");
        const diff = changed(original, out);
        expect(diff.added.filter((l) => /^ +tiles: /.test(l) || /: SS14MapperTestFloor$/.test(l) || /: Plating$/.test(l)).length).toBeGreaterThan(0);
    });

    it("redoes undone edits", () => {
        const doc = open();
        const grid = gridOf(doc);
        doc.addEntity("WallSolid", grid, 0.5, 0.5);
        const edited = doc.serialize(NOW);
        doc.undo();
        expect(doc.serialize(NOW)).toBe(original);
        doc.redo();
        expect(doc.serialize(NOW)).toBe(edited);
    });
});
