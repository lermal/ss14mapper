// What lies under a point: entities, decals and the tile, topmost first; cycling through them with repeated
// clicks; picking one item. On Barnacle with the Frontier pack.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Selection } from "../src/editor/selection";
import { ClickCycle, describe as info, nextIndex, stackAt, type StackItem } from "../src/editor/stack";
import { Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
const file = path.join(root, "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml");
const barnacle = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const frontier = packFor("frontier");
const NOW = new Date(2026, 10, 14, 10, 0, 0);
const look = (zIndex: number) => ({ proto: "WarnLineN", color: "#FFFF00FF", angle: 0, zIndex, cleanable: false });

describe("cycling state", () => {
    it("repeats only near the last click, until reset", () => {
        const c = new ClickCycle();
        expect(c.repeats(10, 10)).toBe(false);
        c.mark(10, 10);
        expect(c.repeats(12, 11)).toBe(true);
        expect(c.repeats(14, 10)).toBe(false);
        c.reset();
        expect(c.repeats(10, 10)).toBe(false);
    });

    it("steps to the item after the single selected one and wraps", () => {
        const items: StackItem[] = [
            { kind: "entity", uid: 7, proto: "A" },
            { kind: "decal", grid: 1, id: "d1", proto: "D" },
            { kind: "decal", grid: 1, id: "d2", proto: "D" },
        ];
        const sel = new Selection();
        expect(nextIndex(items, sel)).toBe(0);
        sel.addEntity(7);
        expect(nextIndex(items, sel)).toBe(1);
        sel.clear();
        sel.addDecal(1, "d2");
        expect(nextIndex(items, sel)).toBe(0);
        // a bigger selection is not a position in the stack
        sel.addDecal(1, "d1");
        expect(nextIndex(items, sel)).toBe(0);
    });
});

describe.skipIf(!barnacle || !frontier)("the stack on Barnacle", () => {
    const open = () => {
        const doc = new MapDocument(barnacle);
        const scene = new Scene(doc, frontier!);
        doc.onChange((c) => scene.apply(c));
        const shown = { entities: true, decals: true, tiles: true };
        const view = { visible: () => shown.entities, decalsShown: () => shown.decals, tilesShown: () => shown.tiles };
        const editor = new Editor(doc, scene, frontier!, view);
        const grid = scene.grids.find((g) => [...scene.tileCells(g)].length > 50)!;
        const [tx, ty] = [...scene.tileCells(grid)][0]!;
        const at = scene.toWorld(grid, tx + 0.5, ty + 0.5);
        return { doc, scene, editor, view, shown, grid, tx, ty, at };
    };

    it("lists decals topmost first, then the tile", () => {
        const { editor, scene, view, grid, tx, ty, at } = open();
        const before = stackAt(scene, view, ...at, { kinds: ["decal"] }).length;
        const [low, high, mid] = [0, 5, 2].map((z) => editor.placeDecals(look(z), grid, [[tx, ty]])[0]!);
        const items = stackAt(scene, view, ...at);
        const decals = items.filter((i) => i.kind === "decal");
        expect(decals.length).toBe(before + 3);
        const ours = decals.map((d) => (d as { id: string }).id).filter((id) => [low, high, mid].includes(id));
        expect(ours).toEqual([high, mid, low]);
        expect(items.at(-1)).toMatchObject({ kind: "tile", grid, x: tx, y: ty, id: scene.tileAt(grid, tx, ty) });
        // entities come before decals
        const kinds = items.map((i) => i.kind);
        expect(kinds.lastIndexOf("entity")).toBeLessThan(kinds.indexOf("decal"));
    });

    it("limits to the kinds asked for and honours the visibility options", () => {
        const { editor, scene, view, shown, grid, tx, ty, at } = open();
        editor.placeDecals(look(0), grid, [[tx, ty]]);
        expect(stackAt(scene, view, ...at, { kinds: ["tile"] }).map((i) => i.kind)).toEqual(["tile"]);
        expect(stackAt(scene, view, ...at, { kinds: ["decal"] }).every((i) => i.kind === "decal")).toBe(true);
        shown.decals = false;
        expect(stackAt(scene, view, ...at).some((i) => i.kind === "decal")).toBe(false);
        shown.tiles = false;
        expect(stackAt(scene, view, ...at).some((i) => i.kind === "tile")).toBe(false);
        shown.entities = false;
        expect(stackAt(scene, view, ...at)).toEqual([]);
    });

    it("starts with the entity a plain click would pick, and lists every entity once", () => {
        const { editor, scene, view, grid } = open();
        let checked = 0, stacked = 0;
        for (const [x, y] of scene.tileCells(grid)) {
            const at = scene.toWorld(grid, x + 0.5, y + 0.5);
            const ents = stackAt(scene, view, ...at, { kinds: ["entity"] });
            const uids = ents.map((e) => (e as { uid: number }).uid);
            expect(new Set(uids).size).toBe(uids.length);
            expect(uids[0] ?? null).toBe(editor.pickAt(...at, () => true));
            checked++;
            if (uids.length > 1) stacked++;
        }
        expect(checked).toBeGreaterThan(50);
        expect(stacked).toBeGreaterThan(0);
    });

    it("walks a stack with repeated picks and picks items with Shift and Alt", () => {
        const { editor, scene, view, grid, tx, ty, at } = open();
        editor.placeDecals(look(1), grid, [[tx, ty]]);
        editor.placeDecals(look(2), grid, [[tx, ty]]);
        const items = stackAt(scene, view, ...at, { kinds: ["entity", "decal"] });
        expect(items.length).toBeGreaterThanOrEqual(2);
        const seen: StackItem[] = [];
        for (let i = 0; i < items.length + 1; i++) {
            const n = nextIndex(items, editor.selected);
            editor.selectItem(items[n]!, "replace");
            expect(editor.selected.size).toBe(1);
            seen.push(items[n]!);
        }
        expect(seen.slice(0, items.length)).toEqual(items);
        expect(seen.at(-1)).toEqual(items[0]);

        editor.selectItem(items[0]!, "replace");
        editor.selectItem(items[1]!, "add");
        expect(editor.selected.size).toBe(2);
        editor.selectItem(items[0]!, "subtract");
        expect(editor.selected.size).toBe(1);
        const tile = stackAt(scene, view, ...at, { kinds: ["tile"] })[0]!;
        editor.selectItem(tile, "replace");
        expect(editor.selected.hasTile(grid, tx, ty)).toBe(true);
    });

    it("describes items for the menu", () => {
        const { editor, scene, view, grid, tx, ty, at } = open();
        editor.placeDecals(look(0), grid, [[tx, ty]]);
        for (const item of stackAt(scene, view, ...at)) {
            const d = info(item, frontier!);
            expect(d.name).toBeTruthy();
            expect(d.tag).toBe(item.kind);
        }
        const decal = stackAt(scene, view, ...at, { kinds: ["decal"] })[0]!;
        expect(info(decal, frontier!)).toMatchObject({ name: "WarnLineN", tag: "decal" });
        expect(info(decal, frontier!).icon).not.toBeNull();
    });

    it("leaves the document untouched by picking", () => {
        const { doc, editor, scene, view, at } = open();
        const text = doc.serialize(NOW);
        editor.selectItem(stackAt(scene, view, ...at)[0]!, "replace");
        expect(doc.serialize(NOW)).toBe(text);
    });
});
