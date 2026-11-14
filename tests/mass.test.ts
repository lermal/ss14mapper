import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunkBody, entityMoments, gridBody, gridMass, partitionChunk, POLYGON_RADIUS, result, type MassEntity, type MassResult } from "../src/editor/mass";
import { MassCache, type MassRules } from "../src/editor/mass-cache";
import type { TileSource } from "../src/editor/view-aids";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

/** Chunk-local tiles from rows drawn top (y = 0) to bottom, as the engine's own tests write them. */
const rows = (...lines: string[]) => (x: number, y: number) => lines[y]?.[x] === "#";

describe("chunk partition", () => {
    it("matches the engine's GridChunkPartition", () => {
        // GridChunkPartition_Tests.PartitionChunk_MiscTiles: rows become runs, nothing stacks
        expect(partitionChunk(rows("##..", ".##.", ".###", "##.."), 4)).toEqual([
            [0, 0, 2, 1],
            [1, 1, 3, 2],
            [1, 2, 4, 3],
            [0, 3, 2, 4],
        ]);
        // PartitionChunk_JoinTiles: runs of the same width on adjacent rows join, bounds (1, 0, 3, 3)
        expect(partitionChunk(rows(".##.", ".##.", ".##.", "...."), 4)).toEqual([[1, 0, 3, 3]]);
    });

    it("joins only adjacent rows and keeps gaps apart", () => {
        expect(partitionChunk(rows("#.#.", "#.#.", "....", "#..."), 4)).toEqual([
            [0, 0, 1, 2],
            [2, 0, 3, 2],
            [0, 3, 1, 4],
        ]);
    });
});

describe("grid body (game)", () => {
    it("shrinks each rectangle by the polygon radius and weighs it by density", () => {
        const full = chunkBody(0, 0, () => true, 2, 16);
        expect(full.mass).toBeCloseTo(2 * (16 - 2 * POLYGON_RADIUS) ** 2, 9);
        expect(result(full).centre).toEqual([8, 8]);
        const one = gridBody([[0, 0]], 800);
        expect(one.mass).toBeCloseTo(800 * 0.98 * 0.98, 9);
    });

    it("splits tiles by chunk, negative coordinates included", () => {
        const m = result(gridBody([[-1, -1], [16, 0]], 1));
        expect(m.centre![0]).toBeCloseTo((-0.5 + 16.5) / 2, 9);
        expect(m.centre![1]).toBeCloseTo((-0.5 + 0.5) / 2, 9);
        // two tiles in different chunks are two fixtures; in one row of one chunk they are one
        expect(gridBody([[15, 0], [16, 0]], 1).mass).toBeCloseTo(2 * 0.98 * 0.98, 9);
        expect(gridBody([[14, 0], [15, 0]], 1).mass).toBeCloseTo(1.98 * 0.98, 9);
    });

    it("weighs long rectangles slightly more per tile than lone tiles", () => {
        // a 4-tile row and a lone tile: the row's centre pulls a little harder than by tile count
        const m = result(gridBody([[0, 0], [1, 0], [2, 0], [3, 0], [0, 2]], 1));
        const byTiles = (0.5 + 1.5 + 2.5 + 3.5 + 0.5) / 5;
        expect(m.centre![0]).toBeGreaterThan(byTiles);
        expect(m.centre![0]).toBeCloseTo((3.98 * 0.98 * 2 + 0.9604 * 0.5) / (3.98 * 0.98 + 0.9604), 9);
    });

    it("is empty without tiles", () => {
        expect(gridMass({ tiles: [], tileDensity: 800 })).toEqual({ game: { mass: 0, centre: null }, entities: { mass: 0, centre: null } });
    });
});

describe("mass with entities", () => {
    it("adds entity bodies at their rotated centres to the tile masses", () => {
        const e: MassEntity = { x: 2, y: 0.5, rot: Math.PI / 2, mass: 100, centre: [0, 0.5] };
        // turned a quarter counter-clockwise, the +y offset points to -x
        const m = entityMoments([e]);
        expect(m.mx / m.mass).toBeCloseTo(1.5, 9);
        expect(m.my / m.mass).toBeCloseTo(0.5, 9);
        const both = gridMass({ tiles: [[0, 0, 800], [1, 0, 200]], entities: [e, { x: 9, y: 9, mass: 0 }], tileDensity: 0.5 });
        expect(both.entities.mass).toBe(1100);
        expect(both.entities.centre![0]).toBeCloseTo((800 * 0.5 + 200 * 1.5 + 100 * 1.5) / 1100, 9);
        // the game's own body ignores entities and tile masses
        expect(both.game.mass).toBeCloseTo(0.5 * 1.98 * 0.98, 9);
        expect(both.game.centre).toEqual([1, 0.5]);
    });
});

const pack = packFor("upstream");
const shuttles = path.join(corpusRoot(), "upstream", "Resources", "Maps", "Shuttles");

describe.skipIf(!pack || !fs.existsSync(shuttles))("upstream shuttles", () => {
    it("have a body mass close to their tile count and a centre close to the tile centre", () => {
        const density = pack!.prototypes.tileDensity!;
        expect(density).toBe(800);
        const files = fs.readdirSync(shuttles).filter((f) => f.endsWith(".yml")).sort().slice(0, 12);
        let grids = 0;
        for (const f of files) {
            const scene = new Scene(new MapDocument(fs.readFileSync(path.join(shuttles, f), "utf8")), pack!);
            for (const g of scene.grids) {
                const tiles: Array<[number, number, number]> = [];
                for (const [x, y] of scene.tileCells(g)) tiles.push([x, y, pack!.tile(scene.tileAt(g, x, y)!)?.mass ?? 800]);
                if (!tiles.length) continue;
                const entities: MassEntity[] = [];
                for (const [uid, [proto]] of scene.entities) {
                    const p = scene.placement(uid);
                    const def = pack!.prototypes.entities[proto];
                    if (p?.grid === g && def?.mass) entities.push({ x: p.x, y: p.y, rot: p.rot, mass: def.mass, centre: def.massCentre });
                }
                const m = gridMass({ tiles, entities, tileDensity: density });
                const n = tiles.length;
                expect(m.game.mass).toBeGreaterThanOrEqual(n * density * 0.98 * 0.98 - 1e-6);
                expect(m.game.mass).toBeLessThanOrEqual(n * density);
                const sx = tiles.reduce((s, t) => s + t[0] + 0.5, 0) / n, sy = tiles.reduce((s, t) => s + t[1] + 0.5, 0) / n;
                expect(Math.hypot(m.game.centre![0] - sx, m.game.centre![1] - sy)).toBeLessThan(0.25);
                expect(entities.length).toBeGreaterThan(0);
                expect(m.entities.mass).toBeGreaterThan(tiles.reduce((s, t) => s + t[2], 0));
                grids++;
            }
        }
        expect(grids).toBeGreaterThan(5);
    }, 120_000);
});

describe("mass cache", () => {
    /** Tiles and bodies a test can edit. */
    function world() {
        const tiles = new Map<number, Map<string, string>>([[1, new Map()], [2, new Map()]]);
        const bodies = new Map<number, MassEntity & { grid: number }>();
        const src: TileSource = {
            get grids() { return [...tiles.keys()]; },
            *tileCells(g) { for (const k of tiles.get(g)?.keys() ?? []) yield k.split(",").map(Number) as [number, number]; },
            tileAt: (g, x, y) => tiles.get(g)?.get(`${x},${y}`) ?? null,
        };
        const masses: Record<string, number> = { Plating: 800, Lattice: 100 };
        const rules: MassRules = { tileDensity: 0.5, tileMass: (n) => masses[n] ?? 800, entityUids: () => bodies.keys(), body: (uid) => bodies.get(uid) ?? null };
        const fresh = (g: number) => {
            const list = [...tiles.get(g)!].map(([k, n]): [number, number, number] => [...(k.split(",").map(Number) as [number, number]), masses[n] ?? 800]);
            return gridMass({ tiles: list, entities: [...bodies.values()].filter((b) => b.grid === g), tileDensity: 0.5 });
        };
        return { tiles, bodies, cache: new MassCache(src, rules), fresh };
    }
    const close = (a: MassResult | null, b: MassResult) => {
        expect(a!.mass).toBeCloseTo(b.mass, 6);
        if (!b.centre) return expect(a!.centre).toBeNull();
        expect(a!.centre![0]).toBeCloseTo(b.centre[0], 9);
        expect(a!.centre![1]).toBeCloseTo(b.centre[1], 9);
    };

    it("follows tile and entity edits in both modes as a fresh computation", () => {
        const w = world();
        for (let x = -20; x < 20; x++) for (let y = -3; y < 3; y++) w.tiles.get(1)!.set(`${x},${y}`, (x + y) % 5 ? "Plating" : "Lattice");
        w.tiles.get(2)!.set("0,0", "Plating");
        w.bodies.set(10, { grid: 1, x: 3.5, y: 0.5, mass: 500, centre: [0, 0.25], rot: 1 });
        w.bodies.set(11, { grid: 2, x: 0.5, y: 0.5, mass: 40 });
        for (const g of [1, 2]) {
            close(w.cache.mass(g, "game"), w.fresh(g).game);
            close(w.cache.mass(g, "entities"), w.fresh(g).entities);
        }
        let seed = 7;
        const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
        for (let step = 0; step < 200; step++) {
            const edits: Array<[number, number, number]> = [];
            for (let i = 0; i < 1 + rnd(4); i++) {
                const x = rnd(60) - 30, y = rnd(20) - 10;
                const kind = rnd(3);
                if (kind === 0) w.tiles.get(1)!.delete(`${x},${y}`);
                else w.tiles.get(1)!.set(`${x},${y}`, kind === 1 ? "Plating" : "Lattice");
                edits.push([1, x, y]);
            }
            const moved: number[] = [];
            if (step % 3 === 0) {
                const uid = 20 + rnd(10);
                if (rnd(4) === 0) w.bodies.delete(uid);
                else w.bodies.set(uid, { grid: 1 + rnd(2), x: rnd(40) - 20, y: rnd(6) - 3, mass: rnd(300) });
                moved.push(uid);
            }
            w.cache.update(edits, moved);
            if (step % 20 === 0) for (const g of [1, 2]) close(w.cache.mass(g, "game"), w.fresh(g).game);
        }
        for (const g of [1, 2]) {
            close(w.cache.mass(g, "game"), w.fresh(g).game);
            close(w.cache.mass(g, "entities"), w.fresh(g).entities);
        }
        expect(w.cache.mass(9, "game")).toBeNull();
    });

    it("is empty again when everything is taken away", () => {
        const w = world();
        w.tiles.get(1)!.set("0,0", "Plating");
        w.bodies.set(1, { grid: 1, x: 0.3, y: 0.1, mass: 77.7 });
        expect(w.cache.centre(1, "entities")).not.toBeNull();
        expect(w.cache.centre(1, "game")).toEqual([0.5, 0.5]);
        w.tiles.get(1)!.delete("0,0");
        w.bodies.delete(1);
        w.cache.update([[1, 0, 0]], [1]);
        expect(w.cache.mass(1, "game")).toEqual({ mass: 0, centre: null });
        expect(w.cache.mass(1, "entities")).toEqual({ mass: 0, centre: null });
    });
});
