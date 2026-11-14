// Decal edits: written where and how the game's map saver writes them (DecalGrid and chunk entities), undone
// byte for byte, and followed by the scene.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatFloat, MapDocument } from "../src/map/document";
import { Scene, type Rect } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
const NOW = new Date(2026, 10, 13, 12, 34, 56);
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const has = (f: string) => fs.existsSync(path.join(root, f));

const FRONTIER = "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml"; // DecalGrid, fields reversed
const GOOB = "goob/Resources/Maps/_DV/shoukou.yml"; // DecalGrid saved by a newer engine
const UPSTREAM_GRID = "upstream/Resources/Maps/Lavaland/shinobi_graveyard.yml"; // DecalGrid
const UPSTREAM_CHUNKS = "upstream/Resources/Maps/Shuttles/cargo_hike.yml"; // chunk entities
const GRID_MAPS = [FRONTIER, GOOB, UPSTREAM_GRID].filter(has);

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

const sameTime = (s: string) => s.replace(/^  time: .*$/m, "  time: -");

/** The grid with the most decals. */
function decalGrid(doc: MapDocument): number {
    return doc.listedGrids().reduce((a, b) => (doc.decals(b).length > doc.decals(a).length ? b : a));
}

/** A decal that is alone in its node (same properties as no other decal of the grid). */
function loneDecal(doc: MapDocument, grid: number) {
    const all = doc.decals(grid);
    const key = (d: (typeof all)[number]) => JSON.stringify([d.proto, d.color, d.angle, d.zIndex, d.cleanable]);
    const counts = new Map<string, number>();
    for (const d of all) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
    const lone = all.find((d) => counts.get(key(d)) === 1);
    if (!lone) throw new Error("no decal alone in its node");
    return lone;
}

describe("decal numbers", () => {
    it("formats positions like .NET (exponents below 1E-04, ties to even)", () => {
        expect(formatFloat(9.2983246e-5)).toBe("9.2983246E-05");
        expect(formatFloat(0.0001)).toBe("0.0001");
        expect(formatFloat(39.9765625)).toBe("39.976562");
        expect(formatFloat(-1.5535983)).toBe("-1.5535983");
    });

    it.skipIf(!GRID_MAPS.length)("reads every decal position of the sample maps back to the same text", () => {
        for (const file of [...GRID_MAPS, UPSTREAM_CHUNKS].filter(has)) {
            const doc = new MapDocument(read(file));
            const text = read(file);
            let n = 0;
            for (const g of doc.listedGrids()) {
                for (const d of doc.decals(g)) {
                    const local = d.id.split(":").at(-1);
                    expect(text).toContain(`            ${local}: ${formatFloat(d.x)},${formatFloat(d.y)}\n`);
                    n++;
                }
            }
            expect(n, file).toBeGreaterThan(0);
        }
    });
});

describe.skipIf(!GRID_MAPS.length)("decals in DecalGrid", () => {
    for (const file of GRID_MAPS) {
        it(`${file}: a node made anew is written like the game's`, () => {
            const source = read(file);
            const doc = new MapDocument(source);
            const grid = decalGrid(doc);
            const d = loneDecal(doc, grid);
            doc.deleteDecal(grid, d.id);
            expect(doc.decal(grid, d.id)).toBeUndefined();
            const id = doc.addDecal(grid, d.proto, d.x, d.y, d);
            const ids = doc.decals(grid).map((x) => Number(x.id));
            expect(Number(id)).toBe(Math.max(...ids));
            // the node comes back where it was, with the same fields: only the decal id differs
            const diff = changed(source, doc.serialize(NOW));
            const pos = `${formatFloat(d.x)},${formatFloat(d.y)}`;
            if (id === d.id) expect(diff).toEqual({ removed: [], added: [] });
            else expect(diff).toEqual({ removed: [`            ${d.id}: ${pos}`], added: [`            ${id}: ${pos}`] });
            while (doc.canUndo) doc.undo();
            expect(doc.serialize(NOW)).toBe(source);
        });

        it(`${file}: add, move, recolour and delete, undone byte for byte`, () => {
            const source = read(file);
            const doc = new MapDocument(source);
            const grid = decalGrid(doc);
            const [first] = doc.decals(grid);
            const before = doc.decals(grid).length;

            // to an existing node: one line after its last decal
            const id = doc.addDecal(grid, first!.proto, 1.25, -2.5, first!);
            const added = changed(source, doc.serialize(NOW));
            expect(added.removed).toEqual([]);
            expect(added.added).toEqual([`            ${id}: 1.25,-2.5`]);
            expect(doc.decals(grid).length).toBe(before + 1);

            doc.moveDecal(grid, id, 3, 4.5);
            expect(changed(source, doc.serialize(NOW)).added).toEqual([`            ${id}: 3,4.5`]);
            expect(doc.decal(grid, id)).toMatchObject({ x: 3, y: 4.5, proto: first!.proto });

            doc.setDecalProperties(grid, id, { color: "#123456", angle: Math.PI / 2, zIndex: 2, cleanable: true });
            expect(doc.decal(grid, id)).toMatchObject({ color: "#123456FF", angle: Math.PI / 2, zIndex: 2, cleanable: true });
            const recoloured = changed(source, doc.serialize(NOW)).added.join("\n");
            expect(recoloured).toContain("color: '#123456FF'");
            expect(recoloured).toContain("angle: 1.5707963267948966 rad");
            expect(recoloured).toContain("cleanable: True");
            expect(recoloured).toContain("zIndex: 2");

            // back to the properties it had: the node made for it goes away
            doc.setDecalProperties(grid, id, first!);
            expect(changed(source, doc.serialize(NOW)).added).toEqual([`            ${id}: 3,4.5`]);
            doc.deleteDecal(grid, id);
            expect(sameTime(doc.serialize(NOW))).toBe(sameTime(source));

            const edited = doc.serialize(NOW);
            while (doc.canUndo) doc.undo();
            expect(doc.serialize(NOW)).toBe(source);
            while (doc.canRedo) doc.redo();
            expect(doc.serialize(NOW)).toBe(edited);
        });
    }

    it("writes node fields in the order of the engine that saved the map", () => {
        const cases: Array<[string, string]> = [
            [FRONTIER, "cleanable,zIndex,angle,color,id"],
            [GOOB, "zIndex,id,color,cleanable,angle"],
        ];
        for (const [file, order] of cases.filter(([f]) => has(f))) {
            const source = read(file);
            const doc = new MapDocument(source);
            const grid = decalGrid(doc);
            doc.addDecal(grid, "TestDecal", 0, 0, { color: "#FFFFFF", angle: 1, zIndex: 3, cleanable: true });
            const lines = changed(source, doc.serialize(NOW)).added;
            const keys = lines.filter((l) => /^            [a-zA-Z]+:/.test(l)).map((l) => l.trim().split(":")[0]);
            expect(keys.join(","), file).toBe(order);
        }
    });
});

describe("decals on a grid without any", () => {
    const small = [
        "meta:", "  format: 7", "  entityCount: 2", "tilemap:", "  0: Space", "entities:", "- proto: \"\"", "  entities:", "  - uid: 1", "    components:",
        "    - type: MetaData", "    - type: Transform", "    - type: MapGrid", "      chunks: {}", "    - type: Gravity", "    - type: GridAtmosphere",
        "- proto: Thing", "  entities:", "  - uid: 2", "    components:", "    - type: Transform", "      pos: 0.5,0.5", "      parent: 1", "...",
    ].join("\n") + "\n";

    it("gets a DecalGrid after Gravity; ids start at 0", () => {
        const doc = new MapDocument(small);
        expect(doc.decals(1)).toEqual([]);
        const a = doc.addDecal(1, "WarnLine", 1, 2, { color: "#FFFF00" });
        const b = doc.addDecal(1, "Arrows", -0.5, 2);
        expect([a, b]).toEqual(["0", "1"]);
        expect(changed(small, doc.serialize(NOW)).added).toEqual([
            "    - type: DecalGrid",
            "      chunkCollection:",
            "        version: 2",
            "        nodes:",
            "        - node:",
            "            id: Arrows",
            "          decals:",
            "            1: -0.5,2",
            "        - node:",
            "            color: '#FFFF00FF'",
            "            id: WarnLine",
            "          decals:",
            "            0: 1,2",
        ]);
        // deleting every decal leaves an empty collection, as the game saves it
        doc.deleteDecal(1, a);
        doc.deleteDecal(1, b);
        expect(changed(small, doc.serialize(NOW)).added).toEqual(["    - type: DecalGrid", "      chunkCollection:", "        version: 2", "        nodes: []"]);
        // a loaded empty collection continues at 1 (NextDecalId after reading)
        const reopened = new MapDocument(doc.serialize(NOW));
        expect(reopened.addDecal(1, "Arrows", 0, 0)).toBe("1");
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
    });

    it("fills an empty collection and empties it again byte for byte", () => {
        const empty = small.replace("    - type: Gravity\n", "    - type: Gravity\n    - type: DecalGrid\n      chunkCollection:\n        version: 2\n        nodes: []\n");
        const doc = new MapDocument(empty);
        const id = doc.addDecal(1, "Arrows", 0, 0);
        expect(id).toBe("1");
        expect(doc.serialize(NOW)).toContain("        nodes:\n        - node:\n            id: Arrows\n          decals:\n            1: 0,0\n");
        doc.deleteDecal(1, id);
        expect(sameTime(doc.serialize(NOW))).toBe(sameTime(empty));
        doc.undo();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(empty);
    });

    it("paints the first tile of a grid with chunks: {}", () => {
        const doc = new MapDocument(small);
        doc.setTile(1, 0, 0, "Plating");
        expect(doc.tile(1, 0, 0).id).toBe(1);
        expect(doc.tiles(1)).toHaveLength(1);
        const out = doc.serialize(NOW);
        expect(out).toContain("    - type: MapGrid\n      chunks:\n        0,0:\n          ind: 0,0\n          tiles: ");
        expect(out).toContain("tilemap:\n  0: Space\n  1: Plating\n");
        doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
    });

    it("rejects what the game cannot store", () => {
        const doc = new MapDocument(small);
        expect(() => doc.addDecal(2, "Arrows", 0, 0)).toThrow(/not a grid/);
        expect(() => doc.addDecal(1, "Arrows", 0, 0, { color: "yellow" })).toThrow(/colour/);
        expect(() => doc.addDecal(1, "Arrows", 0, 0, { zIndex: 0.5 })).toThrow(/z index/);
        expect(() => doc.moveDecal(1, "7", 0, 0)).toThrow(/No decal/);
        expect(doc.serialize(NOW)).toBe(small);
        expect(doc.canUndo).toBe(false);
    });
});

describe.skipIf(!has(UPSTREAM_CHUNKS))("decals on chunk entities", () => {
    it("reads chunk-local ids", () => {
        const doc = new MapDocument(read(UPSTREAM_CHUNKS));
        const decals = doc.decals(2);
        expect(decals.length).toBeGreaterThan(10);
        expect(decals.find((d) => d.id === "-1,0:15")).toMatchObject({ proto: "Arrows", x: -2, y: 1, angle: Math.PI / 2, color: "#FFFFFFFF" });
        for (const d of decals) {
            const [cx, cy] = d.id.split(":")[0]!.split(",").map(Number);
            expect([Math.floor(d.x / 16), Math.floor(d.y / 16)]).toEqual([cx, cy]);
        }
    });

    it("adds to a chunk after its highest id and keeps maxDecalId", () => {
        const source = read(UPSTREAM_CHUNKS);
        const doc = new MapDocument(source);
        const id = doc.addDecal(2, "Arrows", -3, 2, { color: "#FFFFFFFF", angle: Math.PI / 2 });
        expect(id).toBe("-1,0:16");
        const out = doc.serialize(NOW);
        expect(out).toContain("      maxDecalId: 16\n");
        expect(out).toContain("          decals:\n            15: -2,1\n            16: -3,2\n");
        expect(out.split("\n").length).toBe(source.split("\n").length + 1);
        // deleting keeps maxDecalId, as the game does
        doc.deleteDecal(2, id);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: ["      maxDecalId: 15"], added: ["      maxDecalId: 16"] });
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(source);
    });

    it("makes a chunk entity for a new chunk and removes it with its last decal", () => {
        const source = read(UPSTREAM_CHUNKS);
        const doc = new MapDocument(source);
        const count = doc.uids().length;
        const entityCount = Number(/entityCount: (\d+)/.exec(source)![1]);
        const id = doc.addDecal(2, "WarnLine", 40.5, -20, { color: "#FFFF00FF" });
        expect(id).toBe("2,-2:0");
        const uid = Math.max(...doc.uids());
        expect(doc.uids().length).toBe(count + 1);
        expect(doc.proto(uid)).toBe("ChunkEntity");
        const out = doc.serialize(NOW);
        expect(out).toContain(`  entityCount: ${entityCount + 1}\n`);
        expect(out).toContain(`- 130\n- ${uid}\ntilemap:`);
        expect(out).toContain(`      - 130\n      - ${uid}\n    - type: OccluderTree`);
        expect(out).toContain(
            [
                `  - uid: ${uid}`, "    components:", "    - type: ChunkEntity", "      root: 2", "      chunk: 2,-2", "    - type: DecalChunk", "      decals:",
                "        version: 1", "        nodes:", "        - node:", "            id: WarnLine", "            color: '#FFFF00FF'", "          decals:",
                "            0: 40.5,-20",
            ].join("\n") + "\n",
        );
        // moving it to another chunk takes the next id there; its old chunk entity goes away
        const moved = doc.moveDecal(2, id, -2, 1);
        expect(moved).toBe("-1,0:16");
        expect(doc.proto(uid)).toBeUndefined();
        doc.deleteDecal(2, moved);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: ["      maxDecalId: 15"], added: ["      maxDecalId: 16"] });
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(source);
        while (doc.canRedo) doc.redo();
        expect(doc.proto(uid)).toBeUndefined();
        doc.undo();
        doc.undo();
        expect(doc.proto(uid)).toBe("ChunkEntity");
    });

    it("keeps the id when moving within a chunk and moves between nodes on property changes", () => {
        const source = read(UPSTREAM_CHUNKS);
        const doc = new MapDocument(source);
        doc.moveDecal(2, "-1,0:15", -3.25, 1.5);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: ["            15: -2,1"], added: ["            15: -3.25,1.5"] });
        doc.setDecalProperties(2, "-1,0:15", { proto: "DirtHeavy", angle: 0, cleanable: true });
        expect(doc.serialize(NOW)).toContain("            id: DirtHeavy\n            color: '#FFFFFFFF'\n            cleanable: True\n          decals:\n            1: -2,1\n            2: -2,1\n            3: -2,1\n");
        expect(doc.decal(2, "-1,0:15")).toMatchObject({ proto: "DirtHeavy", cleanable: true, angle: 0 });
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(source);
    });
});

// ---------------------------------------------------------------------------------------------
// Scene

interface Drawn {
    key: string;
    x: number;
    y: number;
    ext: number;
}

function decalSnapshot(scene: Scene): Map<string, Drawn> {
    const out = new Map<string, Drawn>();
    for (const d of scene.decals) {
        let k = `decal ${d.grid}/${d.id} ${d.x},${d.y} r${d.rot} ${scene.frames[d.frame]!.join(":")} ${d.color} z${d.z} s${d.seq}`;
        for (let n = 1; out.has(k); n++) k = `${k}#${n}`;
        out.set(k, { key: k, x: d.x, y: d.y, ext: d.ext });
    }
    return out;
}

const SCENE_MAPS = ([["frontier", FRONTIER], ["upstream", UPSTREAM_CHUNKS]] as Array<[string, string]>).filter(([fork, f]) => has(f) && packFor(fork));

describe.skipIf(!SCENE_MAPS.length)("scenes follow decal edits", () => {
    for (const [fork, file] of SCENE_MAPS) {
        it(file, () => {
            const pack = packFor(fork)!;
            const doc = new MapDocument(read(file));
            const scene = new Scene(doc, pack);
            let rects: Rect[] | null = [];
            doc.onChange((change) => {
                const r = scene.apply(change);
                rects = rects === null || r === null ? null : [...rects, ...r];
            });
            const grid = decalGrid(doc);
            const decals = doc.decals(grid);
            const drawable = decals.find((d) => pack.prototypes.decals[d.proto]?.sprite)!;
            expect(drawable).toBeDefined();
            expect(scene.decals.size).toBeGreaterThan(0);

            let before = decalSnapshot(scene);
            const check = (what: string, op: () => unknown, changes = true) => {
                rects = [];
                op();
                expect(rects, `${what}: redrew everything`).not.toBeNull();
                const after = decalSnapshot(scene);
                const fresh = decalSnapshot(new Scene(doc, pack));
                expect([...after.keys()].sort(), `${what}: differs from a scene built anew`).toEqual([...fresh.keys()].sort());
                const diff = [...before.values()].filter((d) => !after.has(d.key)).concat([...after.values()].filter((d) => !before.has(d.key)));
                if (changes) expect(diff.length, `${what}: nothing changed`).toBeGreaterThan(0);
                const outside = diff.filter((d) => !rects!.some(([x0, y0, x1, y1]) => d.x + d.ext >= x0 && d.x - d.ext <= x1 && d.y + d.ext >= y0 && d.y - d.ext <= y1));
                expect(outside.map((d) => d.key), `${what}: changed outside the redrawn areas`).toEqual([]);
                before = after;
            };

            let id = "";
            check("add", () => (id = doc.addDecal(grid, drawable.proto, drawable.x + 1, drawable.y, drawable)));
            check("move", () => (id = doc.moveDecal(grid, id, drawable.x + 20, drawable.y - 20)));
            check("recolour", () => doc.setDecalProperties(grid, id, { color: "#FF0000", zIndex: 1 }));
            check("rotate", () => doc.setDecalProperties(grid, id, { angle: drawable.angle + 1 }));
            check("delete", () => doc.deleteDecal(grid, id));
            check("delete an existing one", () => doc.deleteDecal(grid, drawable.id));
            check("undo", () => doc.undo());
            check("undo again", () => doc.undo());
            check("redo", () => doc.redo());
            // back where the redo left it: the decals are as they were before the edits
            check("undo everything", () => {
                while (doc.canUndo) doc.undo();
            }, false);
            expect(doc.serialize()).toBe(read(file));
        });
    }
});

describe("decals added in a batch", () => {
    const BOX = "upstream/Resources/Maps/box.yml"; // chunk entities, a station
    const files = [...GRID_MAPS, UPSTREAM_CHUNKS, BOX].filter(has);

    /** Decals in old and new nodes, in old and new chunks, some sharing positions. */
    function batch(doc: MapDocument, grid: number) {
        const old = doc.decals(grid);
        const a = old[0], b = old.at(-1);
        const list: Array<{ proto: string; x: number; y: number; props?: Record<string, unknown> }> = [];
        for (let i = 0; i < 40; i++) {
            const like = i % 3 === 0 ? a : i % 3 === 1 ? b : undefined;
            const x = (like?.x ?? 0) + (i % 7) * 5.5 - 12, y = (like?.y ?? 0) + Math.floor(i / 7) * 9 - 20;
            if (like) list.push({ proto: like.proto, x, y, props: { color: like.color, angle: like.angle, zIndex: like.zIndex, cleanable: like.cleanable } });
            else list.push({ proto: i % 2 ? "WarnLineN" : "Arrows", x, y, props: { color: i % 4 ? "#FFFF00FF" : null, angle: i % 5 ? 0 : Math.PI / 2 } });
        }
        return list;
    }

    for (const file of files) {
        it(`${file}: same file and ids as one by one, undone byte for byte`, () => {
            const source = read(file);
            const one = new MapDocument(source), many = new MapDocument(source);
            const grid = decalGrid(one);
            const list = batch(one, grid);
            const ids1 = one.batch("Place", () => list.map((d) => one.addDecal(grid, d.proto, d.x, d.y, d.props)));
            const ids2 = many.addDecals(grid, list);
            expect(ids2).toEqual(ids1);
            expect(many.serialize(NOW)).toBe(one.serialize(NOW));
            expect(many.decals(grid).length).toBe(new MapDocument(source).decals(grid).length + list.length);
            // the next one gets the same id either way
            expect(many.addDecal(grid, "Arrows", 3, 3)).toBe(one.addDecal(grid, "Arrows", 3, 3));
            many.undo();
            many.undo();
            expect(many.serialize()).toBe(source);
        });
    }

    it.skipIf(!has(UPSTREAM_GRID))("starts a new DecalGrid at 0 and makes nodes in the game's order", () => {
        const doc = new MapDocument(read(UPSTREAM_GRID));
        const seq = new MapDocument(read(UPSTREAM_GRID));
        const grid = doc.listedGrids().find((g) => !doc.decals(g).length);
        if (grid === undefined) return;
        const list = ["WarnLineS", "Arrows", "WarnLineN", "Arrows", "Bot"].map((proto, i) => ({ proto, x: i, y: 0 }));
        expect(doc.addDecals(grid, list)).toEqual(["0", "1", "2", "3", "4"]);
        seq.batch("Place", () => list.map((d) => seq.addDecal(grid, d.proto, d.x, d.y)));
        expect(doc.serialize(NOW)).toBe(seq.serialize(NOW));
        expect(doc.addDecals(grid, [])).toEqual([]);
    });
});

// A node without `id` is a decal with an empty prototype (`Decal.Id` defaults to "" and is not written)
const BLANK = "goob/Resources/Maps/.bagel.yml";
describe.skipIf(!has(BLANK))("decals without a prototype", () => {
    it("reads them, edits them and writes their nodes without an id", () => {
        const source = read(BLANK);
        const doc = new MapDocument(source);
        const grid = decalGrid(doc);
        const blank = doc.decals(grid).filter((d) => d.proto === "");
        expect(blank.length).toBeGreaterThan(0);
        const first = blank[0]!;
        const moved = doc.moveDecal(grid, first.id, first.x + 0.25, first.y);
        doc.setDecalProperties(grid, moved, { color: "#FF0000FF" });
        const back = doc.decals(grid).find((d) => d.id === moved)!;
        expect(back.proto).toBe("");
        expect(back.color).toBe("#FF0000FF");
        expect(changed(source, doc.serialize(NOW)).added.some((l) => /^\s+id: ('')?$/.test(l))).toBe(false);
        // a blank decal cannot be given a prototype it never had removed again, and new ones need one
        expect(() => doc.addDecal(grid, "", 0, 0)).toThrow(/needs a prototype/);
        doc.setDecalProperties(grid, moved, { proto: "Arrows" });
        expect(() => doc.setDecalProperties(grid, moved, { proto: "" })).toThrow(/needs a prototype/);
        while (doc.canUndo) doc.undo();
        expect(sameTime(doc.serialize(NOW))).toBe(sameTime(source));
    });
});
