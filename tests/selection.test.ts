// Selection tools, group operations and shapes: geometry, the selection model, and the operations on real
// maps (Barnacle with the Frontier pack, Box with the upstream pack), each one undo step, all undone byte for byte.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { latticeCentre, turnPoint, turnTileRotation } from "../src/editor/group";
import { cellKey, cellOf, collectArea, Selection, wandEntities, wandTiles } from "../src/editor/selection";
import { areaContains, insidePolygon, lineCells, shapeCells, type Area } from "../src/editor/shapes";
import { Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const NOW = new Date(2026, 10, 14, 10, 0, 0);

describe("areas", () => {
    it("tests points against rectangles, ellipses and polygons", () => {
        const rect: Area = { kind: "rect", a: [4, 2], b: [0, 0] };
        expect(areaContains(rect, 0, 0)).toBe(true);
        expect(areaContains(rect, 4, 2)).toBe(true);
        expect(areaContains(rect, 4.01, 1)).toBe(false);
        const ellipse: Area = { kind: "ellipse", a: [0, 0], b: [4, 2] };
        expect(areaContains(ellipse, 2, 1)).toBe(true);
        expect(areaContains(ellipse, 0.2, 0.2)).toBe(false); // inside the box, outside the ellipse
        expect(areaContains(ellipse, 3.9, 1)).toBe(true);
        expect(areaContains({ kind: "ellipse", a: [0, 0], b: [0, 2] }, 0, 1)).toBe(false);
        // an L shape
        const l: Array<[number, number]> = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
        expect(insidePolygon(l, 0.5, 2.5)).toBe(true);
        expect(insidePolygon(l, 2, 0.5)).toBe(true);
        expect(insidePolygon(l, 2, 2)).toBe(false);
        expect(areaContains({ kind: "polygon", points: l }, 2, 2)).toBe(false);
    });
});

describe("shapes on tiles", () => {
    const has = (cells: Array<[number, number]>, x: number, y: number) => cells.some(([a, b]) => a === x && b === y);
    const connected4 = (cells: Array<[number, number]>) => {
        const set = new Set(cells.map(([x, y]) => `${x},${y}`));
        const seen = new Set([[...set][0]!]);
        const stack = [...seen];
        while (stack.length) {
            const [x, y] = stack.pop()!.split(",").map(Number) as [number, number];
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const k = `${x + dx!},${y + dy!}`;
                if (set.has(k) && !seen.has(k)) {
                    seen.add(k);
                    stack.push(k);
                }
            }
        }
        return seen.size === set.size;
    };

    it("draws gapless lines", () => {
        expect(lineCells([0, 0], [3, 0])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
        expect(lineCells([0, 0], [-2, -2])).toEqual([[0, 0], [-1, -1], [-2, -2]]);
        const l = lineCells([0, 0], [7, 3]);
        expect(l.length).toBe(8);
        expect(l.at(-1)).toEqual([7, 3]);
        expect(lineCells([2, 2], [2, 2])).toEqual([[2, 2]]);
    });

    it("draws rectangles and ellipses, outlined or filled", () => {
        expect(shapeCells("rect", true, [0, 0], [3, 2]).length).toBe(12);
        const outline = shapeCells("rect", false, [3, 2], [0, 0]);
        expect(outline.length).toBe(10);
        expect(has(outline, 1, 1)).toBe(false);
        const disc = shapeCells("ellipse", true, [0, 0], [8, 8]);
        const ring = shapeCells("ellipse", false, [0, 0], [8, 8]);
        expect(has(disc, 4, 4)).toBe(true);
        expect(has(disc, 0, 0)).toBe(false);
        expect(has(ring, 4, 4)).toBe(false);
        expect(has(ring, 0, 4) && has(ring, 8, 4) && has(ring, 4, 0) && has(ring, 4, 8)).toBe(true);
        expect(ring.every(([x, y]) => has(disc, x, y))).toBe(true);
        // walls along it touch side by side
        expect(connected4(ring)).toBe(true);
        expect(connected4(shapeCells("ellipse", false, [0, 0], [13, 5]))).toBe(true);
        expect(shapeCells("ellipse", false, [0, 0], [0, 0])).toEqual([[0, 0]]);
    });
});

describe("selection model", () => {
    it("packs cells, adds, subtracts and replaces", () => {
        expect(cellOf(cellKey(-5, 7))).toEqual([-5, 7]);
        expect(cellOf(cellKey(32000, -32000))).toEqual([32000, -32000]);
        const a = new Selection();
        a.entities.add(1).add(2);
        a.addTile(10, 0, 0);
        a.addTile(10, 1, 0);
        const b = new Selection();
        b.entities.add(2).add(3);
        b.addTile(10, 1, 0);
        b.addTile(11, 5, 5);
        const sum = a.clone();
        sum.combine(b, "add");
        expect([...sum.entities].sort()).toEqual([1, 2, 3]);
        expect(sum.tileCount).toBe(3);
        expect(a.size).toBe(4);
        const diff = a.clone();
        diff.combine(b, "subtract");
        expect([...diff.entities]).toEqual([1]);
        expect([...diff.tileList()]).toEqual([[10, 0, 0]]);
        diff.combine(b, "replace");
        expect([...diff.entities]).toEqual([2, 3]);
        expect(diff.hasTile(11, 5, 5)).toBe(true);
        diff.deleteTile(11, 5, 5);
        diff.deleteTile(10, 1, 0);
        expect(diff.tiles.size).toBe(0);
        // prune and move
        sum.prune((u) => u !== 2, (g, x) => !(g === 10 && x === 0));
        expect([...sum.entities].sort()).toEqual([1, 3]);
        expect([...sum.tileList()].sort()).toEqual([[10, 1, 0], [11, 5, 5]]);
        sum.mapTiles((g, x, y) => [x + g, y]);
        expect([...sum.tileList()].sort()).toEqual([[10, 11, 0], [11, 16, 5]]);
    });

    it("turns points, tiles and tile rotations", () => {
        expect(turnPoint([3, 1], [1, 1], 1)).toEqual([1, 3]);
        expect(turnPoint([3, 1], [1, 1], -1)).toEqual([1, -1]);
        expect(turnPoint([3, 1], [1, 1], 2)).toEqual([-1, 1]);
        expect(latticeCentre([2.1, 1.9])).toEqual([2, 2]);
        expect(latticeCentre([1.4, 1.6])).toEqual([1.5, 1.5]);
        // both whole or both halves
        const c = latticeCentre([1.5, 2]);
        expect(Number.isInteger(c[0]) === Number.isInteger(c[1])).toBe(true);
        expect([0, 1, 2, 3].map((r) => turnTileRotation(r, 1))).toEqual([1, 2, 3, 0]);
        expect([0, 1, 2, 3].map((r) => turnTileRotation(r, -1))).toEqual([3, 0, 1, 2]);
        expect([4, 5, 6, 7].map((r) => turnTileRotation(r, 1))).toEqual([7, 4, 5, 6]);
    });
});

// ---------------------------------------------------------------------------------------------
// Real maps

const barnacleFile = path.join(corpusRoot(), "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml");
const boxFile = path.join(corpusRoot(), "upstream/Resources/Maps/box.yml");
const frontier = packFor("frontier"), upstream = packFor("upstream");
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const barnacle = read(barnacleFile), box = read(boxFile);

const visibleDefault = (s: { subfloor: boolean; power: number }) => !s.subfloor && s.power !== 2;

function open(text: string, pack: NonNullable<ReturnType<typeof packFor>>) {
    const doc = new MapDocument(text);
    const scene = new Scene(doc, pack);
    const editor = new Editor(doc, scene, pack, { visible: visibleDefault });
    doc.onChange((c) => {
        scene.apply(c);
        editor.validate();
    });
    const grid = doc.listedGrids().find((g) => scene.grids.includes(g))!;
    /** World rectangle over grid tiles [x0, x1) × [y0, y1). */
    const rect = (x0: number, y0: number, x1: number, y1: number): Area => ({ kind: "rect", a: scene.toWorld(grid, x0, y0), b: scene.toWorld(grid, x1, y1) });
    return { doc, scene, editor, grid, rect };
}

/** Grid tile area of the largest grid's tiles: a box of `n` tiles around the middle of its tiles. */
function middle(doc: MapDocument, grid: number, n: number): [number, number, number, number] {
    const tiles = doc.tiles(grid);
    const xs = tiles.map((t) => t.x).sort((a, b) => a - b), ys = tiles.map((t) => t.y).sort((a, b) => a - b);
    const cx = xs[xs.length >> 1]!, cy = ys[ys.length >> 1]!;
    return [cx - (n >> 1), cy - (n >> 1), cx - (n >> 1) + n, cy - (n >> 1) + n];
}

describe.skipIf(!barnacle || !frontier)("selection tools on Barnacle", () => {
    it("selects entities and tiles in an area, by filter and by what is drawn", () => {
        const { doc, scene, editor, grid, rect } = open(barnacle, frontier!);
        const [x0, y0, x1, y1] = middle(doc, grid, 8);
        const area = rect(x0, y0, x1, y1);
        editor.selectArea(area, "all", "replace");
        const sel = editor.selected;
        expect(sel.entities.size).toBeGreaterThan(0);
        expect(sel.tileCount).toBeGreaterThan(0);
        for (const [g, x, y] of sel.tileList()) {
            expect(g).toBe(grid);
            expect(x >= x0 && x < x1 && y >= y0 && y < y1).toBe(true);
            expect(scene.tileAt(g, x, y)).not.toBeNull();
        }
        for (const u of sel.entities) {
            // its point inside (drawn or not: hidden pipes and cables come along)
            const p = scene.placement(u)!;
            const [lx, ly] = p.anchored ? [Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5] : [p.x, p.y];
            expect(lx >= x0 - 1e-6 && lx <= x1 + 1e-6 && ly >= y0 - 1e-6 && ly <= y1 + 1e-6).toBe(true);
        }
        // an area takes what lies under the floor even while the subfloor is hidden, so a moved room keeps its pipes
        const all = collectArea(scene, { visible: () => true }, area, "entities");
        expect(sel.entities.size).toBe(all.entities.size);
        expect([...sel.entities].some((u) => scene.layersOf(u).length && !scene.layersOf(u).some(visibleDefault))).toBe(true);
        expect(collectArea(scene, { visible: visibleDefault }, area, "tiles").entities.size).toBe(0);
        expect(collectArea(scene, { visible: visibleDefault }, area, "entities").tileCount).toBe(0);
        expect(collectArea(scene, { visible: visibleDefault, tilesShown: () => false }, area, "all").tileCount).toBe(0);
    });

    it("moves a whole shuttle with its hidden pipes, cables and undrawn entities", () => {
        const { doc, scene, editor, grid } = open(barnacle, frontier!);
        editor.selectAll("all");
        const placed = doc.uids().filter((u) => u !== grid && doc.transform(u).parent === grid);
        // every entity standing on the grid is selected, under the floor or not drawn at all
        expect(placed.filter((u) => !editor.selected.entities.has(u))).toEqual([]);
        const before = new Map(placed.map((u) => [u, doc.transform(u)]));
        const [ox, oy] = scene.toWorld(grid, 0, 0);
        const [ex, ey] = scene.toWorld(grid, 20, 0);
        expect(editor.nudge(ex - ox, ey - oy)).toBe(true);
        const stayed = placed.filter((u) => doc.transform(u).x === before.get(u)!.x && doc.transform(u).y === before.get(u)!.y);
        expect(stayed.map((u) => doc.proto(u))).toEqual([]);
    });

    it("deletes everything after selecting all on a station with a map entity", () => {
        if (!box || !upstream) return;
        const { doc, scene, editor } = open(box, upstream);
        const before = doc.uids().length;
        editor.selectAll("entities");
        // the map entity holds the grid and so everything: it is never part of a selection
        const mapEntity = doc.uids().find((u) => doc.transform(u).parent === null && !doc.listedGrids().includes(u));
        if (mapEntity !== undefined) expect(editor.selected.entities.has(mapEntity)).toBe(false);
        const removed = editor.deleteSelection();
        expect(removed.length).toBeGreaterThan(before * 0.9);
        expect(scene.entities.size).toBeLessThan(before * 0.1);
        while (doc.undo());
        expect(doc.uids().length).toBe(before);
    }, 120_000);

    it("adds with Shift and subtracts with Alt", () => {
        const { doc, editor, grid, rect } = open(barnacle, frontier!);
        const [x0, y0, x1, y1] = middle(doc, grid, 8);
        editor.selectArea(rect(x0, y0, x0 + 4, y1), "tiles", "replace");
        const left = editor.selected.tileCount;
        editor.selectArea(rect(x0 + 4, y0, x1, y1), "tiles", "add");
        const both = editor.selected.tileCount;
        expect(both).toBeGreaterThan(left);
        editor.selectArea(rect(x0 + 4, y0, x1, y1), "tiles", "subtract");
        expect(editor.selected.tileCount).toBe(left);
        editor.selectArea({ ...(rect(x0, y0, x1, y1) as Extract<Area, { kind: "rect" }>), kind: "ellipse" }, "tiles", "replace");
        expect(editor.selected.tileCount).toBeLessThan(both);
        // a lasso round the same box selects the same tiles as the box
        const r = rect(x0, y0, x1, y1) as Extract<Area, { kind: "rect" }>;
        editor.selectArea({ kind: "polygon", points: [r.a, [r.b[0], r.a[1]], r.b, [r.a[0], r.b[1]]] }, "tiles", "replace");
        expect(editor.selected.tileCount).toBe(both);
    });

    it("selects a connected area of one tile with the wand", () => {
        const { doc, scene, grid } = open(barnacle, frontier!);
        const t = doc.tiles(grid)[0]!;
        const sel = wandTiles(scene, grid, t.x, t.y);
        const name = scene.tileAt(grid, t.x, t.y);
        expect(sel.tileCount).toBeGreaterThan(0);
        for (const [, x, y] of sel.tileList()) {
            expect(scene.tileAt(grid, x, y)).toBe(name);
            // its 4-neighbours of the same tile are in it too
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
                if (scene.tileAt(grid, x + dx, y + dy) === name) expect(sel.hasTile(grid, x + dx, y + dy)).toBe(true);
            }
        }
        expect(wandTiles(scene, grid, 10_000, 10_000).isEmpty).toBe(true);
    });

    it("selects entities of a prototype with the wand: connected, or all of them", () => {
        const { doc, scene } = open(barnacle, frontier!);
        const walls = doc.uids().filter((u) => doc.proto(u) === "WallMining");
        const near = wandEntities(scene, { visible: visibleDefault }, walls[0]!, true);
        const every = wandEntities(scene, { visible: visibleDefault }, walls[0]!, false);
        expect(every.entities.size).toBe(walls.length);
        expect(near.entities.size).toBeGreaterThan(1);
        expect(near.entities.size).toBeLessThanOrEqual(every.entities.size);
        for (const u of near.entities) expect(doc.proto(u)).toBe("WallMining");
    });
});

describe.skipIf(!box || !upstream)("group operations on Box", () => {
    /** A room-sized selection of everything in the middle of the station. */
    const room = () => {
        const o = open(box, upstream!);
        const [x0, y0, x1, y1] = middle(o.doc, o.grid, 10);
        o.editor.selectArea(o.rect(x0, y0, x1, y1), "all", "replace");
        return o;
    };
    const snapshot = (doc: MapDocument, scene: Scene, sel: Selection, grid: number) => ({
        entities: [...sel.entities].map((u) => [u, doc.transform(u)] as const),
        tiles: [...sel.tileList()].map(([g, x, y]) => [x, y, doc.tile(g, x, y)] as const),
        grid,
        scene,
    });

    it("drags the selection by whole tiles as one undo step, live or dropped", () => {
        for (const live of [true, false]) {
            const { doc, scene, editor, grid } = room();
            const sel = editor.selected;
            expect(sel.entities.size).toBeGreaterThan(5);
            expect(sel.tileCount).toBeGreaterThan(20);
            const before = snapshot(doc, scene, sel, grid);
            const start = scene.toWorld(grid, 0.3, 0.3);
            const to = (dx: number, dy: number) => scene.toWorld(grid, 0.3 + dx, 0.3 + dy);
            expect(editor.beginGroupMove(...start, live)).toBe(true);
            expect(editor.groupMove!.live).toBe(live);
            editor.groupDragTo(...to(0.2, 0.1)); // less than half a tile: nothing
            expect(editor.groupMove!.delta).toEqual([0, 0]);
            editor.groupDragTo(...to(5.4, -2.2));
            editor.groupDragTo(...to(30, 30));
            editor.groupDragTo(...to(3.4, 2.4));
            expect(editor.finish()).toBe(true);
            // moved by (3, 2) tiles, anchored ones on tile centres, children with their parents
            for (const [u, t] of before.entities) {
                const now = doc.transform(u);
                if (now.parent !== grid || t.parent !== grid) continue;
                expect(now.x).toBeCloseTo(t.x + 3, 5);
                expect(now.y).toBeCloseTo(t.y + 2, 5);
                expect(now.parent).toBe(t.parent);
            }
            for (const [x, y, t] of before.tiles) {
                const moved = doc.tile(grid, x + 3, y + 2);
                expect([moved.id, moved.variant, moved.rotationMirroring]).toEqual([t.id, t.variant, t.rotationMirroring]);
            }
            // the selection followed its tiles
            expect(sel.tileCount).toBe(before.tiles.length);
            for (const [x, y] of before.tiles) expect(sel.hasTile(grid, x + 3, y + 2)).toBe(true);
            expect(doc.canUndo).toBe(true);
            doc.undo();
            expect(doc.canUndo).toBe(false);
            expect(doc.serialize(NOW)).toBe(box);
        }
    });

    it("moves decals and free entities as the decal snap says: whole tiles, onto corners, or by pixels", () => {
        for (const snap of ["tile", "corner", "free"] as const) {
            for (const withEntity of [false, true]) {
                const { doc, scene, editor, grid } = open(box, upstream!);
                editor.moveSnap = snap;
                const [x0, y0] = middle(doc, grid, 4);
                const decals = upstream!.prototypes.decals;
                const proto = "WarnLineN" in decals ? "WarnLineN" : Object.keys(decals)[0]!;
                // on the tile lattice, as the brush puts them with Tile snap
                const ids = editor.placeDecals({ proto, color: "#FFFFFFFF", angle: 0, zIndex: 0, cleanable: false }, grid, [[x0, y0], [x0 + 1, y0]]);
                expect(ids.length).toBe(2);
                const placed = doc.serialize(NOW);
                editor.selected.clear();
                for (const id of ids) editor.selected.addDecal(grid, id);
                const free = [...scene.entities.keys()].find((u) => {
                    const p = scene.placement(u);
                    return p && !p.anchored && p.grid === grid && doc.transform(u).parent === grid;
                });
                expect(free).toBeDefined();
                const from = doc.transform(free!);
                if (withEntity) editor.selected.addEntity(free!);
                const start = scene.toWorld(grid, x0 + 0.3, y0 + 0.3);
                expect(editor.beginGroupMove(...start, true)).toBe(true);
                editor.groupDragTo(...scene.toWorld(grid, x0 + 0.3 + 3.4, y0 + 0.3 + 2.4));
                expect(editor.finish()).toBe(true);
                const now = editor.selectedDecals();
                expect(now.length).toBe(2);
                // the cursor went (3.4, 2.4) tiles: Tile keeps the decals on whole tiles, Corner puts them on the
                // corner lattice, Off follows the cursor to the pixel; free entities go by whole tiles unless Off
                const [dx, dy] = snap === "tile" ? [3, 2] : snap === "corner" ? [3.5, 2.5] : [109 / 32, 77 / 32];
                expect(now.map((d) => [d.x, d.y]).sort((a, b) => a[0]! - b[0]!)).toEqual([[x0 + dx, y0 + dy], [x0 + 1 + dx, y0 + dy]]);
                if (withEntity) {
                    const [ex, ey] = snap === "free" ? [109 / 32, 77 / 32] : [3, 2];
                    const t = doc.transform(free!);
                    expect(t.x).toBeCloseTo(from.x + ex, 5);
                    expect(t.y).toBeCloseTo(from.y + ey, 5);
                }
                // nudges: a tile, or a texture pixel with the snap Off (nothing here keeps to tiles)
                expect(editor.nudge(1, 0)).toBe(true);
                const step = snap === "free" ? 1 / 32 : 1;
                expect(editor.selectedDecals().map((d) => d.x).sort((a, b) => a - b)[0]).toBeCloseTo(x0 + dx + step, 6);
                doc.undo();
                doc.undo();
                expect(doc.serialize(NOW)).toBe(placed);
            }
        }
    });

    it("keeps tiles and anchored entities on whole tiles with the snap Off; decals there follow the pixels", () => {
        const { doc, scene, editor, grid, rect } = room();
        editor.moveSnap = "free";
        const [x0, y0] = middle(doc, grid, 10);
        const ids = editor.placeDecals({ proto: "WarnLineN" in upstream!.prototypes.decals ? "WarnLineN" : Object.keys(upstream!.prototypes.decals)[0]!, color: "#FFFFFFFF", angle: 0, zIndex: 0, cleanable: false }, grid, [[x0 + 2, y0 + 2]]);
        editor.selectArea(rect(x0, y0, x0 + 10, y0 + 10), "all", "replace");
        const tiles = [...editor.selected.tileList()].map(([, x, y]) => [x, y, doc.tile(grid, x, y)] as const);
        expect(tiles.length).toBeGreaterThan(20);
        expect(editor.selected.hasDecal(grid, ids[0]!)).toBe(true);
        const start = scene.toWorld(grid, x0 + 0.3, y0 + 0.3);
        expect(editor.beginGroupMove(...start, true)).toBe(true);
        editor.groupDragTo(...scene.toWorld(grid, x0 + 0.3 + 3.4, y0 + 0.3 + 2.4));
        expect(editor.finish()).toBe(true);
        for (const [x, y, t] of tiles) expect(doc.tile(grid, x + 3, y + 2).id).toBe(t.id);
        const d = editor.selectedDecals().find((x) => Math.abs(x.x - (x0 + 2 + 109 / 32)) < 1e-6);
        expect(d).toBeDefined();
    });

    it("writes the same file for a live drag that wandered as for a straight move, and nothing for a drag back", () => {
        const a = room(), b = room();
        const start = a.scene.toWorld(a.grid, 0.5, 0.5);
        a.editor.beginGroupMove(...start, true);
        for (const [dx, dy] of [[4, 0], [8, 3], [-6, -6], [1, 1]] as const) a.editor.groupDragTo(...a.scene.toWorld(a.grid, 0.5 + dx, 0.5 + dy));
        a.editor.finish();
        b.editor.nudge(...(b.scene.toWorld(b.grid, 1, 0).map((v, i) => v - b.scene.toWorld(b.grid, 0, 0)[i]!) as [number, number]));
        b.editor.nudge(...(b.scene.toWorld(b.grid, 0, 1).map((v, i) => v - b.scene.toWorld(b.grid, 0, 0)[i]!) as [number, number]));
        // two nudges are two undo steps; the drag is one
        expect(a.doc.serialize(NOW)).toBe(b.doc.serialize(NOW));
        b.doc.undo();
        b.doc.undo();
        expect(b.doc.serialize(NOW)).toBe(box);

        const c = room();
        c.editor.beginGroupMove(...start, true);
        c.editor.groupDragTo(...c.scene.toWorld(c.grid, 3.5, 0.5));
        c.editor.groupDragTo(...c.scene.toWorld(c.grid, 0.6, 0.4));
        expect(c.editor.finish()).toBe(false);
        expect(c.doc.canUndo).toBe(false);
        expect(c.doc.serialize(NOW)).toBe(box);
    });

    it("turns the selection around its centre; four turns bring it back", () => {
        const { doc, scene, editor, grid } = room();
        const sel = editor.selected;
        const before = snapshot(doc, scene, sel, grid);
        const cells = new Set([...sel.tileList()].map(([, x, y]) => `${x},${y}`));
        expect(editor.rotateSelection(1)).toBe(true);
        // tiles land on tiles: as many as before, all with tiles
        expect(sel.tileCount).toBe(before.tiles.length);
        for (const [g, x, y] of sel.tileList()) expect(scene.tileAt(g, x, y)).not.toBeNull();
        // anchored entities stay on tile centres
        for (const [u] of before.entities) {
            const p = scene.placement(u);
            if (p?.anchored && doc.transform(u).parent === grid) {
                expect(Math.abs(doc.transform(u).x % 1)).toBeCloseTo(0.5, 5);
                expect(Math.abs(doc.transform(u).y % 1)).toBeCloseTo(0.5, 5);
            }
        }
        editor.rotateSelection(1);
        editor.rotateSelection(1);
        editor.rotateSelection(1);
        expect(new Set([...sel.tileList()].map(([, x, y]) => `${x},${y}`))).toEqual(cells);
        for (const [u, t] of before.entities) {
            const now = doc.transform(u);
            expect(now.x).toBeCloseTo(t.x, 5);
            expect(now.y).toBeCloseTo(t.y, 5);
            expect(Math.cos(now.rotation)).toBeCloseTo(Math.cos(t.rotation), 9);
            expect(Math.sin(now.rotation)).toBeCloseTo(Math.sin(t.rotation), 9);
        }
        // each turn is one undo step
        for (let i = 0; i < 4; i++) doc.undo();
        expect(doc.canUndo).toBe(false);
        expect(doc.serialize(NOW)).toBe(box);
    });

    it("deletes entities with their contents and clears the tiles as one undo step", () => {
        const { doc, scene, editor } = room();
        const sel = editor.selected;
        const uids = [...sel.entities];
        const tiles = [...sel.tileList()];
        const inside = uids.flatMap((u) => doc.descendants(u));
        const removed = editor.deleteSelection();
        expect(new Set(removed)).toEqual(new Set([...uids, ...inside]));
        for (const u of removed) expect(doc.proto(u)).toBeUndefined();
        for (const [g, x, y] of tiles) expect(scene.tileAt(g, x, y)).toBeNull();
        expect(sel.isEmpty).toBe(true);
        doc.undo();
        expect(doc.canUndo).toBe(false);
        expect(doc.serialize(NOW)).toBe(box);
    });

    it("nudges a tile per press, one undo step each", () => {
        const { doc, scene, editor, grid } = room();
        const before = snapshot(doc, scene, editor.selected, grid);
        const up = scene.toWorld(grid, 0, 1), o = scene.toWorld(grid, 0, 0);
        editor.nudge(up[0] - o[0], up[1] - o[1]);
        editor.nudge(up[0] - o[0], up[1] - o[1]);
        const [u, t] = before.entities.find(([, t]) => t.parent === grid)!;
        expect(doc.transform(u).y).toBeCloseTo(t.y + 2, 5);
        doc.undo();
        expect(doc.transform(u).y).toBeCloseTo(t.y + 1, 5);
        doc.undo();
        expect(doc.serialize(NOW)).toBe(box);
    });

    it("draws an outlined rectangle of walls once per tile, and floor rectangles, each one undo step", () => {
        const { doc, scene, editor, grid } = open(box, upstream!);
        // in open space next to the station
        const xs = doc.tiles(grid).map((t) => t.x);
        const x0 = Math.max(...xs) + 5, y0 = 0;
        const at = (x: number, y: number) => scene.toWorld(grid, x + 0.5, y + 0.5);
        // walls go on tiles only: floor first
        expect(editor.drawShape("rect", true, { kind: "tile", id: "FloorSteel" }, at(x0, y0), at(x0 + 5, y0 + 3))).toBe(24);
        expect(editor.drawShape("rect", false, { kind: "entity", id: "WallSolid" }, at(x0 - 9, y0), at(x0 - 6, y0 + 3))).toBe(0);
        const before = doc.uids().length;
        expect(editor.drawShape("rect", false, { kind: "entity", id: "WallSolid" }, at(x0, y0), at(x0 + 5, y0 + 3))).toBe(16);
        expect(doc.uids().length).toBe(before + 16);
        for (let x = x0; x <= x0 + 5; x++) expect(scene.anchoredAt(grid, x, y0).some((u) => doc.proto(u) === "WallSolid")).toBe(true);
        expect(scene.anchoredAt(grid, x0 + 1, y0 + 1)).toEqual([]);
        // again over it: only the new tiles
        expect(editor.drawShape("rect", true, { kind: "entity", id: "WallSolid" }, at(x0, y0), at(x0 + 5, y0 + 3))).toBe(8);
        expect(editor.drawShape("ellipse", true, { kind: "tile", id: "FloorSteel" }, at(x0, y0 + 10), at(x0 + 6, y0 + 16))).toBeGreaterThan(20);
        expect(editor.drawShape("line", false, { kind: "tile", id: "FloorSteel" }, at(x0, y0 + 20), at(x0 + 9, y0 + 24))).toBe(10);
        doc.undo();
        doc.undo();
        doc.undo();
        expect(doc.uids().length).toBe(before + 16);
        doc.undo();
        doc.undo();
        expect(doc.canUndo).toBe(false);
        expect(doc.serialize(NOW)).toBe(box);
    });
});
