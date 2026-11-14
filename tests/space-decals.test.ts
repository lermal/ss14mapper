// Decals do not stay on space (DecalSystem.OnTileChanged), decal brush defaults, engine prototypes, and the
// inspector's added component written by its first Apply: each edit one undo step, undone byte for byte.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pasteClip } from "../src/editor/clipboard";
import { cellKey } from "../src/editor/selection";
import { decalsOnCells } from "../src/editor/space-decals";
import { decalBrushDefaults, Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
const read = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "");
const barnacle = read("frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml");
const frontier = packFor("frontier");
const NOW = new Date(2026, 10, 14, 10, 0, 0);
const brush = { proto: "WarnLineN", color: "#FFFF00FF", angle: 0, zIndex: 0, cleanable: false };

describe("which decals go", () => {
    it("takes decals whose corner is in the tile's box, edges included", () => {
        const decals = [
            { id: "inside", x: 2.5, y: 3.25 },
            { id: "corner", x: 2, y: 3 },
            { id: "right edge", x: 3, y: 3.5 },
            { id: "far", x: 5, y: 5 },
            { id: "below", x: 2, y: 2.5 },
        ];
        // tile (2,3) is the box [2,3]×[3,4]
        expect(decalsOnCells(decals, [cellKey(2, 3)]).sort()).toEqual(["corner", "inside", "right edge"]);
        expect(decalsOnCells(decals, [cellKey(1, 2)]).sort()).toEqual(["below", "corner"]);
        expect(decalsOnCells(decals, [])).toEqual([]);
    });
});

describe.skipIf(!barnacle || !frontier)("decals and space on Barnacle", () => {
    const open = () => {
        const doc = new MapDocument(barnacle);
        const scene = new Scene(doc, frontier!);
        doc.onChange((c) => scene.apply(c));
        const editor = new Editor(doc, scene, frontier!, { visible: () => true });
        const grid = scene.grids.find((g) => [...scene.tileCells(g)].length > 50)!;
        // a tile with room on both sides in x
        const [tx, ty] = [...scene.tileCells(grid)].find(([x, y]) => scene.tileAt(grid, x + 1, y) && scene.tileAt(grid, x + 2, y) && scene.tileAt(grid, x + 3, y))!;
        const w = (x: number, y: number) => scene.toWorld(grid, x + 0.5, y + 0.5);
        return { doc, scene, editor, grid, tx, ty, w };
    };

    it("deletes decals with the tile the eraser takes, in the same undo step", () => {
        const { doc, scene, editor, grid, tx, ty, w } = open();
        const ids = editor.placeDecals(brush, grid, [[tx, ty], [tx + 3, ty]]);
        const placed = doc.serialize(NOW);
        expect(ids.length).toBe(2);
        editor.beginStroke("Erase");
        expect(editor.paint("Space", ...w(tx, ty))).toBe(true);
        editor.finish();
        expect(scene.tileAt(grid, tx, ty)).toBeNull();
        expect(doc.decal(grid, ids[0]!)).toBeUndefined();
        expect(doc.decal(grid, ids[1]!)).toBeDefined();
        expect(doc.undo()).toBeTruthy();
        expect(doc.serialize(NOW)).toBe(placed);
    });

    it("deletes them for a shape drawn with space and for deleted selected tiles", () => {
        const { doc, editor, grid, tx, ty, w } = open();
        const [a, b] = editor.placeDecals(brush, grid, [[tx + 1, ty], [tx + 4, ty]]);
        const placed = doc.serialize(NOW);
        // cells tx+1 and tx+2: the decal at tx+1 is in their boxes, the one at tx+4 is not
        expect(editor.drawShape("line", true, { kind: "tile", id: "Space" }, w(tx + 1, ty), w(tx + 2, ty))).toBe(2);
        expect(doc.decal(grid, a!)).toBeUndefined();
        expect(doc.decal(grid, b!)).toBeDefined();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(placed);

        editor.selected.addTile(grid, tx + 1, ty);
        editor.deleteSelection();
        expect(doc.decal(grid, a!)).toBeUndefined();
        expect(doc.decal(grid, b!)).toBeDefined();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(placed);
    });

    it("keeps the selection's own decals when a group moves, deletes others the move uncovers", () => {
        const { doc, editor, grid, tx, ty } = open();
        const [own, edge, far] = editor.placeDecals(brush, grid, [[tx + 1, ty], [tx + 2, ty], [tx + 4, ty]]);
        const placed = doc.serialize(NOW);
        // the tile at tx+1 and its decal move one tile; its old cell becomes space
        editor.selected.addTile(grid, tx + 1, ty);
        editor.selected.addDecal(grid, own!);
        expect(editor.nudge(0, 1)).toBe(true);
        const now = editor.selectedDecals()[0]!;
        expect(now.x !== tx + 1 || now.y !== ty).toBe(true);
        // the decal on the vacated tile's edge goes (Box2.Contains is inclusive), the far one stays
        expect(doc.decal(grid, edge!)).toBeUndefined();
        expect(doc.decal(grid, far!)).toBeDefined();
        expect(doc.undo()).toBeTruthy();
        expect(doc.serialize(NOW)).toBe(placed);
    });

    it("clears decals once a live group drag is dropped, not while it goes back and forth", () => {
        const { doc, editor, grid, tx, ty, w } = open();
        const [own, edge] = editor.placeDecals(brush, grid, [[tx + 1, ty], [tx + 2, ty]]);
        const placed = doc.serialize(NOW);
        editor.selected.addTile(grid, tx + 1, ty);
        editor.selected.addDecal(grid, own!);
        const [x0, y0] = w(tx + 1, ty);
        const [x1, y1] = w(tx + 1, ty + 1);
        expect(editor.beginGroupMove(x0, y0, true)).toBe(true);
        editor.groupDragTo(x1, y1);
        editor.groupDragTo(x0, y0);
        editor.groupDragTo(x1, y1);
        expect(editor.finish()).toBe(true);
        expect(doc.decal(grid, edge!)).toBeUndefined();
        expect(doc.undo()).toBe("Move");
        expect(doc.serialize(NOW)).toBe(placed);
    });

    it("does not paste decals that would land on space", () => {
        const { doc, editor, grid, tx, ty } = open();
        const [mine] = editor.placeDecals(brush, grid, [[tx + 1, ty]]);
        editor.selected.addDecal(grid, mine!);
        const clip = editor.copy()!;
        expect(clip.decals.length).toBe(1);
        const placed = doc.serialize(NOW);
        const target = (x: number, y: number) => ({ grid, anchor: [x, y] as [number, number], turns: 0 });
        const off = pasteClip(doc, clip, target(5000, 5000));
        expect(off.decals).toEqual([]);
        expect(off.onSpace).toBe(1);
        expect(doc.serialize(NOW)).toBe(placed);
        const on = pasteClip(doc, clip, target(tx + 2.5, ty + 0.5));
        expect(on.decals.length).toBe(1);
        expect(on.onSpace).toBe(0);
        doc.undo();
        expect(doc.serialize(NOW)).toBe(placed);
    });
});

describe("decal brush defaults", () => {
    it("follows DecalPlacerWindow.SelectDecal with Auto on", () => {
        expect(decalBrushDefaults(undefined, "#FF0000FF")).toEqual({ cleanable: false, color: "#FFFFFFFF", snap: "tile" });
        expect(decalBrushDefaults({ defaultSnap: false }, "#FF0000FF").snap).toBe("free");
        expect(decalBrushDefaults({ defaultCleanable: true, defaultCustomColor: true }, "#FF0000FF")).toEqual({ cleanable: true, color: "#FF0000FF", snap: "tile" });
    });

    for (const fork of ["upstream", "frontier", "goob"]) {
        const pack = packFor(fork);
        it.skipIf(!pack)(`${fork} pack carries the prototype defaults`, () => {
            const decals = Object.values(pack!.prototypes.decals);
            expect(decals.some((d) => d.defaultSnap === false)).toBe(true);
            expect(decals.some((d) => d.defaultCleanable === true)).toBe(true);
            expect(decals.some((d) => d.defaultCustomColor === true)).toBe(true);
            expect(pack!.prototypes.decals["Rock01"]?.defaultSnap).toBe(false);
        });
    }
});

describe.skipIf(!barnacle || !frontier)("engine prototypes", () => {
    it("does not report ChunkEntity as missing", () => {
        const text = read("upstream/Resources/Maps/box.yml");
        const upstream = packFor("upstream");
        if (!text || !upstream) return;
        const scene = new Scene(new MapDocument(text), upstream);
        expect([...scene.missing].filter((m) => m.includes("ChunkEntity"))).toEqual([]);
    });
});

describe.skipIf(!barnacle)("inspector add and apply", () => {
    it("is one undo step: the panel keeps the added component until the first Apply", () => {
        const doc = new MapDocument(barnacle);
        const uid = doc.uids().find((u) => doc.components(u).every((c) => c.type !== "MetaData"))!;
        // adding writes nothing; the first Apply writes the component with its text
        doc.setComponent(uid, "MetaData", "name: Bridge");
        expect(doc.undo()).toBeTruthy();
        expect(doc.serialize(NOW)).toBe(barnacle);
        expect(doc.canUndo).toBe(false);
    });
});
