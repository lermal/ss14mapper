// Editor logic without the DOM: edits of several steps as one undo step, snapping, hit testing and the
// editor operations on a real map (Barnacle with the Frontier pack).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { entityAt, texelAt } from "../src/editor/hit";
import type { KeyStorage } from "../src/editor/keymap";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../src/editor/prefs";
import { quarterTurn, snapsToTile, tileCenter, toPixel } from "../src/editor/snap";
import { decalCorner, Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import { Scene, SpatialIndex, type SpriteLayer } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const file = path.join(corpusRoot(), "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml");
const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const pack = packFor("frontier");
const NOW = new Date(2026, 10, 14, 10, 0, 0);

function layer(fields: Partial<SpriteLayer>): SpriteLayer {
    return {
        x: 0, y: 0, rot: 0, frame: 0, color: null, depth: 0, subfloor: false, kind: "other", uid: 1, order: 0, layer: 0, power: 0, scale: null, ext: 1,
        ...fields,
    };
}

/** Just enough of a scene for hit testing: sprite layers and 32×32 frames (a 64×16 one at index 1). */
function fakeScene(layers: SpriteLayer[]): Scene {
    const sprites = new SpatialIndex<SpriteLayer>();
    for (const l of layers) sprites.add(l);
    return { sprites, frames: [[0, 0, 0, 32, 32], [0, 0, 0, 64, 16]] } as unknown as Scene;
}

describe("snapping", () => {
    it("snaps grid placement modes to tile centres and leaves free ones", () => {
        const proto = (mode?: string) => ({ name: "", components: {}, ...(mode ? { placement: { mode } } : {}) });
        expect(snapsToTile(proto("SnapgridCenter"))).toBe(true);
        expect(snapsToTile(proto("AlignTileAny"))).toBe(true);
        expect(snapsToTile(proto("AlignAtmosPipeLayers"))).toBe(true);
        expect(snapsToTile(proto("PlaceFree"))).toBe(false);
        expect(snapsToTile(proto())).toBe(false);
        expect(snapsToTile(undefined)).toBe(false);
        expect([tileCenter(2.9), tileCenter(-0.1), tileCenter(3)]).toEqual([2.5, -0.5, 3.5]);
        expect(toPixel(1.2345)).toBe(40 / 32);
        expect(quarterTurn(0, -1)).toBe(-Math.PI / 2);
    });

    it("puts decals where the game's decal placer does", () => {
        // with Snap: Round(x - 0.5, away from zero) + 0.5, then the corner half a tile back
        expect([2.3, 2.9, 0.2, -0.3, -1.7].map((v) => decalCorner(v, "tile"))).toEqual([2, 2, 0, -1, -2]);
        // without: centred on the cursor, whole texture pixels
        expect(decalCorner(2.3, "free")).toBe(toPixel(1.8));
        expect([2.3, 2.6, -0.4].map((v) => decalCorner(v, "corner"))).toEqual([1.5, 2.5, -0.5]);
    });
});

describe("edge structures on a tile", () => {
    const goob = packFor("goob");
    const shuttle = path.join(corpusRoot(), "goob/Resources/Maps/_Goobstation/Shuttles/consul.yml");

    it.skipIf(!goob || !fs.existsSync(shuttle)).each(["Railing", "WallDirectional", "WindowDirectional", "WindowReinforcedDirectional"])(
        "places %s on different sides of one tile",
        (proto) => {
            const original = fs.readFileSync(shuttle, "utf8");
            const doc = new MapDocument(original);
            const scene = new Scene(doc, goob!);
            doc.onChange((c) => scene.apply(c));
            const editor = new Editor(doc, scene, goob!, { visible: () => true });
            const grid = scene.grids[0]!;
            const [x, y] = [...scene.tileCells(grid)].find(([x, y]) => scene.anchoredAt(grid, x, y).length === 0)!;
            const at = scene.toWorld(grid, x + 0.5, y + 0.5);

            const first = editor.place(proto, ...at);
            const second = editor.place(proto, ...at, Math.PI / 2);
            expect(first).not.toBeNull();
            expect(second).not.toBeNull();
            expect(editor.place(proto, ...at, -3 * Math.PI / 2)).toBeNull();
            expect(scene.anchoredAt(grid, x, y)).toEqual([first, second]);

            doc.undo();
            expect(scene.anchoredAt(grid, x, y)).toEqual([first]);
            doc.undo();
            expect(doc.serialize(NOW)).toBe(original);
        },
    );
});

describe("hit testing", () => {
    it("finds texture pixels of plain, rotated and scaled layers", () => {
        expect(texelAt(layer({}), 32, 32, 0, 0)).toEqual([16, 16]);
        // world y goes up, texture y goes down
        expect(texelAt(layer({}), 32, 32, -0.49, 0.49)).toEqual([0, 0]);
        expect(texelAt(layer({}), 32, 32, 0.51, 0)).toBeNull();
        // a quarter turn counter-clockwise puts the texture's top-left at the bottom-left
        expect(texelAt(layer({ rot: Math.PI / 2 }), 32, 32, -0.49, -0.49)).toEqual([0, 0]);
        expect(texelAt(layer({ scale: [2, 2] }), 32, 32, 0.9, 0)).toEqual([30, 16]);
        expect(texelAt(layer({ scale: [2, 2] }), 32, 32, 1.1, 0)).toBeNull();
    });

    it("picks the entity drawn on top, among visible layers, where its pixels are", () => {
        const floor = layer({ uid: 1, depth: -11 });
        const wall = layer({ uid: 2, depth: -2 });
        const cable = layer({ uid: 3, depth: -14, subfloor: true });
        const pipe = layer({ uid: 4, depth: 5, frame: 1, ext: 2 });
        const scene = fakeScene([floor, wall, cable, pipe]);
        const all = () => true;
        expect(entityAt(scene, 0, 0, all)).toBe(4);
        // the wide, flat frame is not there 0.4 tiles up
        expect(entityAt(scene, 0, 0.4, all)).toBe(2);
        expect(entityAt(scene, 0, 0, (s) => s.uid !== 4 && s.uid !== 2)).toBe(1);
        expect(entityAt(scene, 0, 0, (s) => !s.subfloor && s.uid !== 4, (frame, tx) => tx < 8)).toBeNull();
        expect(entityAt(scene, 5, 5, all)).toBeNull();
        // same depth: higher y is drawn first, so the lower entity is on top
        const a = layer({ uid: 10, x: 0, y: 0.2 }), b = layer({ uid: 11, x: 0, y: -0.2 });
        expect(entityAt(fakeScene([b, a]), 0, 0, all)).toBe(11);
    });
});

describe("edits of several steps", () => {
    const small = ["meta:", "  format: 7", "tilemap:", "  0: Space", "entities:", "- proto: \"\"", "  entities:", "  - uid: 1", "    components:", "    - type: MapGrid", "      chunks: {}", "- proto: Thing", "  entities:", "  - uid: 2", "    components:", "    - type: Transform", "      pos: 0.5,0.5", "      parent: 1", "..."].join("\n") + "\n";

    it("notifies every step but undoes and redoes them as one edit", () => {
        const doc = new MapDocument(small);
        const changes: number[][] = [];
        doc.onChange((c) => changes.push(c.entities));
        doc.begin("Move");
        doc.moveEntity(2, 1.5, 0.5);
        doc.moveEntity(2, 2.5, 0.5);
        expect(changes).toEqual([[2], [2]]);
        expect(doc.canUndo).toBe(false);
        expect(() => doc.undo()).toThrow();
        expect(doc.commit()).toBe(true);
        expect(doc.canUndo).toBe(true);
        expect(doc.transform(2).x).toBe(2.5);
        doc.undo();
        expect(doc.transform(2).x).toBe(0.5);
        expect(doc.serialize(NOW)).toBe(small);
        doc.redo();
        expect(doc.transform(2).x).toBe(2.5);
        expect(changes.length).toBe(4);
    });

    it("cancels by reverting everything, keeps the redo stack, and makes no undo step of nothing", () => {
        const doc = new MapDocument(small);
        doc.moveEntity(2, 3.5, 0.5);
        doc.undo();
        doc.begin("Place");
        const placed = doc.addEntity("Other", 1, 0.5, 0.5);
        doc.moveEntity(2, 1.5, 1.5);
        const seen: Array<{ entities: number[]; tiles: unknown[] }> = [];
        doc.onChange((c) => seen.push(c));
        doc.cancel();
        expect(seen).toEqual([{ entities: [placed, 2], tiles: [], decals: [] }]);
        expect(doc.proto(placed)).toBeUndefined();
        expect(doc.serialize(NOW)).toBe(small);
        expect(doc.canRedo).toBe(true);
        doc.begin("Move");
        expect(doc.commit()).toBe(false);
        expect(doc.canUndo).toBe(false);
        expect(doc.canRedo).toBe(true);
    });

    it("tracks unsaved edits", () => {
        const doc = new MapDocument(small);
        expect(doc.modified).toBe(false);
        doc.moveEntity(2, 1.5, 0.5);
        expect(doc.modified).toBe(true);
        doc.markSaved();
        expect(doc.modified).toBe(false);
        doc.undo();
        expect(doc.modified).toBe(true);
        doc.redo();
        expect(doc.modified).toBe(false);
        doc.begin("Move");
        doc.moveEntity(2, 4.5, 0.5);
        expect(doc.modified).toBe(true);
        doc.cancel();
        expect(doc.modified).toBe(false);
    });

    it("keeps a stroke going after a failed step", () => {
        const doc = new MapDocument(small);
        doc.begin("Move");
        doc.moveEntity(2, 1.5, 0.5);
        expect(() => doc.moveEntity(99, 0, 0)).toThrow();
        doc.moveEntity(2, 2.5, 0.5);
        doc.commit();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
    });
});

describe.skipIf(!original || !pack)("decals on Barnacle", () => {
    const open = () => {
        const doc = new MapDocument(original);
        const scene = new Scene(doc, pack!);
        doc.onChange((c) => scene.apply(c));
        const editor = new Editor(doc, scene, pack!, { visible: () => true });
        return { doc, scene, editor };
    };
    const brush = { proto: "WarnLineN", color: "#FFFF00FF", angle: 0, zIndex: 0, cleanable: false };

    it("places a line of decals as one undo step, picks one, recolours a selection, undone byte for byte", () => {
        const { doc, scene, editor } = open();
        const grid = scene.grids.find((g) => [...scene.tileCells(g)].length > 50)!;
        const [tx, ty] = [...scene.tileCells(grid)][0]!;
        const w = (x: number, y: number) => scene.toWorld(grid, x, y);
        const line = editor.decalLine(w(tx + 0.5, ty + 0.5), w(tx + 4.5, ty + 0.5), "tile")!;
        expect(line.grid).toBe(grid);
        expect(line.points).toEqual([0, 1, 2, 3, 4].map((i) => [tx + i, ty]));
        // the game takes no decal on space
        expect(editor.placeDecals(brush, grid, [[1000, 1000]])).toEqual([]);
        expect(doc.canUndo).toBe(false);
        const ids = editor.placeDecals(brush, grid, line.points);
        expect(ids.length).toBe(5);
        expect(doc.decal(grid, ids[2]!)).toMatchObject({ ...brush, x: tx + 2, y: ty });
        // the eyedropper reads it back
        expect(editor.pickDecal(...w(tx + 2.5, ty + 0.5))).toMatchObject({ ...brush, grid });
        // a free line puts one per tile of length
        expect(editor.decalLine(w(tx + 0.5, ty + 0.5), w(tx + 3.5, ty + 4.5), "free")!.points.length).toBe(6);
        for (const id of ids) editor.selected.addDecal(grid, id);
        expect(editor.setDecalProps({ color: "#FF0000FF", angle: Math.PI / 2 })).toBe(5);
        expect(editor.selectedDecals().map((d) => [d.color, d.angle])).toEqual(ids.map(() => ["#FF0000FF", Math.PI / 2]));
        expect(editor.selectedDecals().map((d) => d.id)).toEqual(ids);
        // a shape drawn with a decal brush: one per tile
        const n = editor.drawShape("rect", false, { kind: "decal", id: "Bot", props: { ...brush, proto: "Bot" } }, w(tx + 0.5, ty + 2.5), w(tx + 3.5, ty + 4.5));
        expect(n).toBe(10);
        editor.undo();
        expect(editor.undo()).toBe("Change decals");
        expect(editor.selected.decalCount).toBe(5);
        editor.undo();
        expect(doc.serialize()).toBe(original);
    });
});

describe.skipIf(!original || !pack)("editor on Barnacle", () => {
    const open = () => {
        const doc = new MapDocument(original);
        const scene = new Scene(doc, pack!);
        doc.onChange((c) => scene.apply(c));
        const editor = new Editor(doc, scene, pack!, { visible: (s) => !s.subfloor && s.power !== 1 });
        return { doc, scene, editor };
    };
    const find = (doc: MapDocument, proto: string) => doc.uids().find((u) => doc.proto(u) === proto)!;
    const layerOf = (scene: Scene, uid: number) => scene.layersOf(uid).find((l) => !l.subfloor && l.power !== 1)!;

    it("selects what is drawn on top under the cursor", () => {
        const { doc, scene, editor } = open();
        const wall = find(doc, "WallMining");
        const l = layerOf(scene, wall);
        expect(editor.selectAt(l.x, l.y)).toBe(wall);
        // far outside the ship
        expect(editor.selectAt(l.x + 500, l.y)).toBeNull();
    });

    it("drags an anchored entity from tile centre to tile centre as one undo step", () => {
        const { doc, scene, editor } = open();
        const wall = find(doc, "WallMining");
        const from = doc.transform(wall);
        const w = scene.worldTransform(wall)!;
        const grid = from.parent!;
        // grid-local steps, so the test does not depend on the grid's rotation
        const at = (dx: number, dy: number) => scene.toWorld(grid, from.x + dx, from.y + dy);
        editor.beginMove(wall, w.x, w.y);
        editor.dragTo(...at(0.3, 0.2));
        expect(doc.transform(wall)).toEqual(from);
        editor.dragTo(...at(1.3, 0.2));
        editor.dragTo(...at(2.7, -1.4));
        expect(doc.transform(wall)).toMatchObject({ x: Math.floor(from.x + 2.7) + 0.5, y: Math.floor(from.y - 1.4) + 0.5 });
        expect(editor.finish()).toBe(true);
        doc.undo();
        expect(doc.transform(wall)).toEqual(from);
        expect(doc.serialize(NOW)).toBe(original);
    });

    it("drags entities that are not anchored freely, on whole pixels", () => {
        const { doc, scene, editor } = open();
        const free = doc.uids().find((u) => scene.placement(u) && !scene.placement(u)!.anchored && scene.layersOf(u).length && scene.placement(u)!.grid === doc.transform(u).parent)!;
        expect(free).toBeDefined();
        const from = doc.transform(free);
        const w = scene.worldTransform(free)!;
        editor.beginMove(free, w.x, w.y);
        const [tx, ty] = scene.toWorld(from.parent!, from.x + 0.3, from.y - 0.71);
        editor.dragTo(tx, ty);
        editor.finish();
        expect(doc.transform(free).x).toBeCloseTo(from.x + toPixel(0.3), 4);
        expect(doc.transform(free).y).toBeCloseTo(from.y + toPixel(-0.71), 4);
    });

    it("places walls on tile centres of the grid under the cursor and drags lines of them", () => {
        const { doc, scene, editor } = open();
        const wall = find(doc, "WallMining");
        const grid = doc.transform(wall).parent!;
        const before = doc.uids().length;
        // next to the wall, in grid coordinates
        const t = doc.transform(wall);
        const cell = (dx: number) => scene.toWorld(grid, t.x + dx + 0.2, t.y + 0.3);
        editor.beginStroke("Place");
        const placed = editor.place("WallSolid", ...cell(5));
        editor.place("WallSolid", ...cell(5.1)); // same tile: skipped
        editor.place("WallSolid", ...cell(6));
        expect(editor.finish()).toBe(true);
        expect(doc.uids().length).toBe(before + 2);
        // not twice on one tile
        expect(editor.place("WallSolid", ...cell(5))).toBeNull();
        expect(editor.place("WallSolid", ...cell(5), Math.PI / 2)).toBeNull();
        expect(doc.transform(placed!)).toEqual({ x: Math.floor(t.x + 5.2) + 0.5, y: Math.floor(t.y + 0.3) + 0.5, rotation: 0, parent: grid });
        doc.undo();
        expect(doc.uids().length).toBe(before);
        expect(doc.serialize(NOW)).toBe(original);
    });

    it("replaces what shares its placement key, as the game does, in one undo step", () => {
        const { doc, scene, editor } = open();
        const wall = find(doc, "WallMining");
        const grid = doc.transform(wall).parent!;
        const t = doc.transform(wall);
        const on = scene.toWorld(grid, Math.floor(t.x) + 0.5, Math.floor(t.y) + 0.5);
        const key = (id: string) => (editor as unknown as { replacementKey(p: string): string | null }).replacementKey(id);
        // walls and airlocks share a key: an airlock placed on a wall takes its place
        expect(key("WallSolid")).toBe(key("Airlock"));
        expect(key("WallSolid")).not.toBeNull();
        const before = doc.uids().length;
        const door = editor.place("Airlock", ...on);
        expect(door).not.toBeNull();
        expect(doc.proto(wall)).toBeUndefined();
        expect(doc.uids().length).toBe(before);
        doc.undo();
        expect(doc.proto(wall)).toBe("WallMining");
        expect(doc.uids().length).toBe(before);
        expect(doc.serialize(NOW)).toBe(original);
        // something with another key stays
        expect(key("Chair")).not.toBe(key("WallSolid"));
    });

    it("places nothing over space", () => {
        const { doc, scene, editor } = open();
        const grid = doc.listedGrids().find((g) => scene.grids.includes(g))!;
        const before = doc.uids().length;
        // a tile far outside the shuttle
        const away = scene.toWorld(grid, 500.5, 500.5);
        expect(editor.place("WallSolid", ...away)).toBeNull();
        // on a drawn tile, then the same tile erased
        const { x, y } = doc.tiles(grid)[0]!;
        const on = scene.toWorld(grid, x + 0.5, y + 0.5);
        editor.beginStroke("Erase");
        editor.paint("Space", ...on);
        editor.finish();
        expect(editor.place("WallSolid", ...on)).toBeNull();
        expect(doc.uids().length).toBe(before);
    });

    it("paints tiles in one stroke, skips tiles that already have them, and erases", () => {
        const { doc, scene, editor } = open();
        const grid = doc.listedGrids().find((g) => scene.grids.includes(g))!;
        const tiles = doc.tiles(grid);
        const { x, y } = tiles[0]!;
        const name = scene.tileAt(grid, x, y)!;
        const at = (dx: number) => scene.toWorld(grid, x + dx + 0.5, y + 0.5);
        expect(editor.paint(name, ...at(0))).toBe(false);
        editor.beginStroke("Paint");
        expect(editor.paint("FloorSS14MapperTest", ...at(0))).toBe(true);
        expect(editor.paint("FloorSS14MapperTest", ...at(0))).toBe(false);
        editor.paint("FloorSS14MapperTest", ...at(1));
        editor.finish();
        expect(scene.tileAt(grid, x, y)).toBe("FloorSS14MapperTest");
        expect([...doc.tilemap().values()]).toContain("FloorSS14MapperTest");
        editor.beginStroke("Erase");
        expect(editor.paint("Space", ...at(0))).toBe(true);
        editor.finish();
        expect(scene.tileAt(grid, x, y)).toBeNull();
        doc.undo();
        doc.undo();
        expect(scene.tileAt(grid, x, y)).toBe(name);
        expect(doc.serialize(NOW)).toBe(original);
    });

    it("finds the grid under a point, or the nearest one", () => {
        const { doc, scene } = open();
        const grid = doc.listedGrids().find((g) => scene.grids.includes(g))!;
        const { x, y } = doc.tiles(grid)[0]!;
        expect(scene.gridAt(...scene.toWorld(grid, x + 0.5, y + 0.5))).toBe(grid);
        expect(scene.gridAt(...scene.toWorld(grid, x + 300, y))).toBe(grid);
        const [lx, ly] = scene.toLocal(grid, ...scene.toWorld(grid, 3.25, -7.5));
        expect(lx).toBeCloseTo(3.25, 9);
        expect(ly).toBeCloseTo(-7.5, 9);
    });
});

const boxFile = path.join(corpusRoot(), "upstream/Resources/Maps/box.yml");
const upstream = packFor("upstream");

describe.skipIf(!fs.existsSync(boxFile) || !upstream)("editor on Box", () => {
    it("rotates by quarter turns and deletes containers with their contents", () => {
        const text = fs.readFileSync(boxFile, "utf8");
        const doc = new MapDocument(text);
        const scene = new Scene(doc, upstream!);
        doc.onChange((c) => scene.apply(c));
        const editor = new Editor(doc, scene, upstream!, { visible: () => true });
        const grids = new Set(doc.grids());
        const holder = doc.uids().find((u) => !grids.has(u) && doc.descendants(u).length > 1 && scene.layersOf(u).length > 0)!;
        expect(holder).toBeDefined();
        const inside = doc.descendants(holder);
        const l = scene.layersOf(holder)[0]!;
        expect(editor.selectAt(l.x, l.y)).toBe(holder);
        const rot = doc.transform(holder).rotation;
        editor.rotateSelection(-1);
        const turned = doc.transform(holder).rotation;
        expect(Math.cos(turned)).toBeCloseTo(Math.cos(rot - Math.PI / 2), 9);
        expect(Math.sin(turned)).toBeCloseTo(Math.sin(rot - Math.PI / 2), 9);
        const removed = editor.deleteSelection();
        expect(new Set(removed)).toEqual(new Set([holder, ...inside]));
        expect(editor.selection).toBeNull();
        for (const u of removed) expect(scene.layersOf(u)).toEqual([]);
        doc.undo();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(text);
    });
});

describe("tool choices kept across reloads", () => {
    const mem = (): KeyStorage => {
        const data = new Map<string, string>();
        return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
    };
    it("keeps the decal snap and Defaults; anything unreadable gives the defaults", () => {
        const s = mem();
        expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
        savePrefs(s, { decalSnap: "corner", decalAuto: true });
        expect(loadPrefs(s)).toEqual({ decalSnap: "corner", decalAuto: true });
        s.setItem("ss14mapper.editor", JSON.stringify({ decalSnap: "diagonal", decalAuto: "yes" }));
        expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
        s.setItem("ss14mapper.editor", JSON.stringify({ decalSnap: "free" }));
        expect(loadPrefs(s)).toEqual({ ...DEFAULT_PREFS, decalSnap: "free" });
        s.setItem("ss14mapper.editor", "{broken");
        expect(loadPrefs(s)).toEqual(DEFAULT_PREFS);
        const denied: KeyStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
        expect(loadPrefs(denied)).toEqual(DEFAULT_PREFS);
        expect(() => savePrefs(denied, DEFAULT_PREFS)).not.toThrow();
        expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
    });
});
