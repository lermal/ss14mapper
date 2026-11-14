// Clipboard, decals in the selection, batched tile writes and the selection kept with undo and redo: on real
// maps, each edit one undo step, all undone byte for byte.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clipCounts, clipText, pasteClip, readClip, remapReferences, type Clip } from "../src/editor/clipboard";
import { collectArea, wandDecals } from "../src/editor/selection";
import type { Area } from "../src/editor/shapes";
import { Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const NOW = new Date(2026, 10, 14, 10, 0, 0);
const root: string = corpusRoot();
const read = (f: string) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : "");
const box = read("upstream/Resources/Maps/box.yml");
const barnacle = read("frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml");
const cargoHike = read("upstream/Resources/Maps/Shuttles/cargo_hike.yml"); // decals on chunk entities
const upstream = packFor("upstream"), frontier = packFor("frontier");
const visible = (s: { subfloor: boolean; power: number }) => !s.subfloor && s.power !== 2;

function open(text: string, pack: NonNullable<ReturnType<typeof packFor>>) {
    const doc = new MapDocument(text);
    const scene = new Scene(doc, pack);
    const editor = new Editor(doc, scene, pack, { visible });
    doc.onChange((c) => {
        scene.apply(c);
        editor.validate();
    });
    const grid = doc.listedGrids().reduce((a, b) => (doc.tiles(b).length > doc.tiles(a).length ? b : a));
    const rect = (x0: number, y0: number, x1: number, y1: number): Area => ({ kind: "rect", a: scene.toWorld(grid, x0, y0), b: scene.toWorld(grid, x1, y1) });
    return { doc, scene, editor, grid, rect };
}

describe("references in component text", () => {
    it("renames copied uids, drops the others, leaves other numbers alone", () => {
        const ids = new Map([[10, 110], [11, 111]]);
        const containers = ["containers:", "  storage: !type:Container", "    ents:", "    - 10", "    - 99", "    - 11", "    showEnts: False", "  slot: !type:ContainerSlot", "    ent: 98"].join("\n");
        const r = remapReferences(containers, ids);
        expect(r.dropped).toBe(2);
        expect(r.text).toBe(["containers:", "  storage: !type:Container", "    ents:", "    - 110", "    - 111", "    showEnts: False", "  slot: !type:ContainerSlot", "    ent: null"].join("\n"));
        const links = ["linkedPorts:", "  10:", "  - source: Pressed", "    sink: Toggle", "  50:", "  - source: Pressed", "    sink: Open"].join("\n");
        expect(remapReferences(links, ids)).toEqual({ text: ["linkedPorts:", "  110:", "  - source: Pressed", "    sink: Toggle"].join("\n"), dropped: 1 });
        expect(remapReferences("devices:\n- 11\n- 77", ids)).toEqual({ text: "devices:\n- 111", dropped: 1 });
        // numbers that are not entity fields stay, and untouched text is returned as it was
        const plain = "startingCharge: 10\nmaxCharge: 11";
        expect(remapReferences(plain, ids)).toEqual({ text: plain, dropped: 0 });
        expect(remapReferences("", ids)).toEqual({ text: "", dropped: 0 });
    });

    it("reads back only its own format", () => {
        expect(readClip("{}")).toBeNull();
        expect(readClip("not json")).toBeNull();
        const clip: Clip = { format: "ss14mapper.clipboard", version: 1, lattice: null, entities: [], tiles: [], decals: [] };
        expect(readClip(clipText(clip))).toEqual(clip);
        expect(readClip(clipText({ ...clip, version: 2 } as unknown as Clip))).toBeNull();
    });
});

describe.skipIf(!box || !upstream)("copy and paste on Box", () => {
    /** A signal button with the door it is linked to, and a locker with things inside. */
    const find = (doc: MapDocument, grid: number) => {
        const near = (a: number, b: number) => {
            const p = doc.transform(a), q = doc.transform(b);
            return p.parent === grid && q.parent === grid && Math.abs(p.x - q.x) <= 6 && Math.abs(p.y - q.y) <= 6;
        };
        let button = 0, door = 0;
        for (const u of doc.uids()) {
            if (doc.proto(u) !== "SignalButton") continue;
            const ports = doc.components(u).find((c) => c.type === "DeviceLinkSource")?.data.linkedPorts as Record<string, unknown> | undefined;
            const target = Number(Object.keys(ports ?? {})[0]);
            if (target && doc.proto(target) && near(u, target)) [button, door] = [u, target];
            if (button) break;
        }
        const holder = doc.uids().find((u) => doc.transform(u).parent === grid && doc.descendants(u).length >= 2 && doc.components(u).some((c) => c.type === "ContainerContainer"))!;
        return { button, door, holder };
    };
    const around = (doc: MapDocument, uids: number[]): [number, number, number, number] => {
        const xs = uids.map((u) => doc.transform(u).x), ys = uids.map((u) => doc.transform(u).y);
        return [Math.floor(Math.min(...xs)) - 1, Math.floor(Math.min(...ys)) - 1, Math.floor(Math.max(...xs)) + 2, Math.floor(Math.max(...ys)) + 2];
    };

    it("pastes a room twice with new uids, contents and links inside it, each paste one undo step", () => {
        const { doc, scene, editor, grid, rect } = open(box, upstream!);
        const { button, door, holder } = find(doc, grid);
        expect(button && door && holder).toBeTruthy();
        editor.selectArea(rect(...around(doc, [button, door])), "all", "replace");
        editor.selectArea(rect(...around(doc, [holder])), "all", "add");
        expect(editor.selected.entities.has(button) && editor.selected.entities.has(door) && editor.selected.entities.has(holder)).toBe(true);
        const clip = readClip(clipText(editor.copy()!))!;
        const counts = clipCounts(clip);
        expect(counts.entities).toBeGreaterThan(editor.selected.entities.size); // contents came along
        expect(counts.tiles).toBeGreaterThan(0);
        // decals pasted into new chunks get chunk entities (Box keeps decals on them)
        const things = () => doc.uids().filter((u) => doc.proto(u) !== "ChunkEntity");
        const before = things().length;

        // into empty space next to the station
        const xs = doc.tiles(grid).map((t) => t.x);
        const at = scene.toWorld(grid, Math.max(...xs) + 30.3, 0.4);
        const first = editor.paste(clip, ...at, 0)!;
        expect(first.missing).toEqual([]);
        expect(things().length).toBe(before + counts.entities);
        expect(Math.min(...first.entities)).toBeGreaterThan(Math.max(...things().filter((u) => !first.entities.includes(u))));
        // the selection is what was pasted
        expect(new Set(editor.selected.entities)).toEqual(new Set(first.roots));
        expect(editor.selected.tileCount).toBe(counts.tiles);

        // the copies point at each other
        const newOf = (old: number) => first.entities[[...flat(clip)].indexOf(old)]!;
        const newButton = newOf(button), newDoor = newOf(door), newHolder = newOf(holder);
        expect(doc.proto(newButton)).toBe("SignalButton");
        const ports = doc.components(newButton).find((c) => c.type === "DeviceLinkSource")!.data.linkedPorts as Record<string, unknown>;
        expect(Object.keys(ports)).toContain(String(newDoor));
        const inside = doc.descendants(newHolder);
        expect(inside.length).toBe(doc.descendants(holder).length);
        for (const u of inside) expect(first.entities).toContain(u);
        const ents = JSON.stringify(doc.components(newHolder).find((c) => c.type === "ContainerContainer")!.data);
        for (const u of inside.filter((u) => doc.transform(u).parent === newHolder)) expect(ents).toContain(String(u));
        expect(ents).not.toMatch(new RegExp(`\\b(${doc.descendants(holder).join("|")})\\b`));
        // anchored things land on tile centres, tiles keep their names
        const t = doc.transform(newDoor);
        expect([t.x % 1, t.y % 1].map(Math.abs)).toEqual([0.5, 0.5]);

        const second = editor.paste(clip, ...scene.toWorld(grid, Math.max(...xs) + 60.3, 0.4), 1)!;
        expect(second.entities.length).toBe(counts.entities);
        // turned a quarter: the door is turned too
        const d2 = doc.transform(second.entities[[...flat(clip)].indexOf(door)]!);
        expect(Math.cos(d2.rotation - doc.transform(door).rotation - Math.PI / 2)).toBeCloseTo(1, 9);

        // a re-read file has every reference of the copies pointing at existing entities
        const reread = new MapDocument(doc.serialize(NOW));
        for (const u of [...first.entities, ...second.entities]) expect(reread.proto(u)).toBe(doc.proto(u));
        doc.undo();
        doc.undo();
        expect(doc.canUndo).toBe(false);
        expect(doc.serialize(NOW)).toBe(box);
    });

    it("pastes onto another map and build, skipping what the build lacks", () => {
        if (!barnacle || !frontier) return;
        const a = open(box, upstream!);
        const { button, door, holder } = find(a.doc, a.grid);
        a.editor.selectArea(a.rect(...around(a.doc, [button, door, holder])), "all", "replace");
        a.editor.selectArea(a.rect(...around(a.doc, [holder])), "all", "add");
        const clip = readClip(clipText(a.editor.copy()!))!;
        // a prototype that no build has
        clip.entities.push({ uid: 999999, proto: "SS14MapperNoSuchThing", x: 0.5, y: 0.5, rot: 0, transform: "", components: [], children: [] });
        const b = open(barnacle, frontier!);
        const known = {
            entity: (p: string) => !!frontier!.prototypes.entities[p],
            tile: (n: string) => !!frontier!.tile(n),
            decal: (p: string) => !!frontier!.prototypes.decals[p],
        };
        const t = b.doc.tiles(b.grid)[0]!;
        const r = b.editor.paste(clip, ...b.scene.toWorld(b.grid, t.x + 40.2, t.y + 0.3), 0, known)!;
        expect(r.missing).toContain("SS14MapperNoSuchThing");
        expect(r.entities.length).toBeGreaterThan(0);
        // barnacle writes transforms the old way: rot, pos, parent
        const out = b.doc.serialize(NOW);
        expect(out).toMatch(new RegExp(`- uid: ${r.roots[0]}\\n    components:\\n(    - type: MetaData\\n(      .*\\n)*)?    - type: Transform\\n(      rot: .*\\n)?      pos: .*\\n      parent: ${b.grid}\\n`));
        b.doc.undo();
        expect(b.doc.serialize(NOW)).toBe(barnacle);
    });

    it("cuts as one undo step and restores the selection with undo and redo", () => {
        const { doc, editor, grid, rect } = open(box, upstream!);
        const { holder } = find(doc, grid);
        editor.selectArea(rect(...around(doc, [holder])), "all", "replace");
        const selected = [...editor.selected.entities].sort();
        const tiles = editor.selected.tileCount;
        editor.deleteSelection();
        expect(editor.selected.isEmpty).toBe(true);
        editor.undo();
        expect([...editor.selected.entities].sort()).toEqual(selected);
        expect(editor.selected.tileCount).toBe(tiles);
        editor.redo();
        expect(editor.selected.isEmpty).toBe(true);
        editor.undo();
        // a move: undo puts the selection back where it was, redo where it went
        const before = [...editor.selected.tileList()].map(String).sort();
        const up = doc.transform(holder);
        editor.nudge(...(sub(editor.scene.toWorld(grid, 0, 1), editor.scene.toWorld(grid, 0, 0))));
        const after = [...editor.selected.tileList()].map(String).sort();
        expect(after).not.toEqual(before);
        editor.undo();
        expect([...editor.selected.tileList()].map(String).sort()).toEqual(before);
        expect(doc.transform(holder)).toEqual(up);
        editor.redo();
        expect([...editor.selected.tileList()].map(String).sort()).toEqual(after);
        editor.undo();
        editor.undo();
        expect(doc.serialize(NOW)).toBe(box);
    });

    it("writes many tiles with one decoding per chunk, as single writes would", () => {
        const a = new MapDocument(box), b = new MapDocument(box);
        const grid = a.listedGrids()[0]!;
        const cells = a.tiles(grid).slice(0, 600).map(({ x, y }, i) => ({ x: x + 3, y, name: i % 3 ? "FloorWhite" : "Space", variant: i % 2 }));
        cells.push({ x: 5000, y: 5000, name: "FloorWhite", variant: 0 }); // a new chunk
        a.setTiles(grid, cells);
        b.begin("Paint");
        for (const c of cells) b.setTile(grid, c.x, c.y, c.name, c.variant);
        b.commit();
        expect(a.serialize(NOW)).toBe(b.serialize(NOW));
        a.undo();
        expect(a.serialize(NOW)).toBe(box);
    });
});

/** Uids of a clipboard's entities in the order a paste makes them. */
function* flat(clip: Clip): Generator<number> {
    const walk = function* (list: Clip["entities"]): Generator<number> {
        for (const e of list) {
            yield e.uid;
            yield* walk(e.children);
        }
    };
    yield* walk(clip.entities);
}

const sub = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];

describe("batched decal edits", () => {
    for (const [name, text] of [["Box", box], ["cargo_hike", cargoHike], ["Barnacle", barnacle]] as const) {
        it.skipIf(!text)(`write what single edits write on ${name}`, () => {
            const a = new MapDocument(text), b = new MapDocument(text);
            const grid = a.listedGrids().reduce((p, q) => (a.decals(q).length > a.decals(p).length ? q : p));
            const some = a.decals(grid).slice(0, 40);
            // across chunk borders, some turned
            const edits = some.map((d, i) => ({ id: d.id, x: d.x + 17, y: d.y - 3, ...(i % 3 ? {} : { props: { angle: d.angle + Math.PI / 2 } }) }));
            const ids = a.editDecals(grid, edits);
            b.begin("Change decals");
            const single = edits.map((e) => {
                if (e.props) b.setDecalProperties(grid, e.id, e.props);
                return b.moveDecal(grid, e.id, e.x, e.y);
            });
            b.commit();
            expect(ids).toEqual(single);
            expect(a.serialize(NOW)).toBe(b.serialize(NOW));
            a.deleteDecals(grid, ids.slice(0, 10));
            for (const id of ids.slice(0, 10)) b.deleteDecal(grid, id);
            expect(a.serialize(NOW)).toBe(b.serialize(NOW));
            a.undo();
            a.undo();
            expect(a.serialize(NOW)).toBe(text);
        });
    }
});

describe.skipIf(!upstream)("decals in the selection", () => {
    for (const [name, text] of [["Box (DecalGrid)", box], ["cargo_hike (chunk entities)", cargoHike]] as const) {
        it.skipIf(!text)(`selects, moves across chunks, turns, copies and deletes decals on ${name}`, () => {
            const { doc, scene, editor } = open(text, upstream!);
            const grid = doc.listedGrids().reduce((a, b) => (doc.decals(b).length > doc.decals(a).length ? b : a));
            const d = doc.decals(grid).find((x) => scene.decalLayer(grid, x.id))!;
            const layer = scene.decalLayer(grid, d.id)!;
            // an area round it, decals only
            const area: Area = { kind: "rect", a: [layer.x - 0.4, layer.y - 0.4], b: [layer.x + 0.4, layer.y + 0.4] };
            editor.selectArea(area, "decals", "replace");
            expect(editor.selected.hasDecal(grid, d.id)).toBe(true);
            expect(editor.selected.entities.size + editor.selected.tileCount).toBe(0);
            expect(collectArea(scene, { visible, decalsShown: () => false }, area, "all").decalCount).toBe(0);
            expect(wandDecals(scene, layer, false).decalCount).toBeGreaterThanOrEqual(wandDecals(scene, layer, true).decalCount);
            const ids = [...editor.selected.decalList()];
            const before = new Map(ids.map(([g, id]) => [id, doc.decal(g, id)!]));
            // 20 tiles along: on chunk entities that is another chunk (new ids)
            const step = sub(scene.toWorld(grid, 20, 0), scene.toWorld(grid, 0, 0));
            expect(editor.beginGroupMove(layer.x, layer.y, true)).toBe(true);
            editor.groupDragTo(layer.x + step[0], layer.y + step[1]);
            expect(editor.finish()).toBe(true);
            const moved = [...editor.selected.decalList()];
            expect(moved.length).toBe(ids.length);
            for (const [g, id] of moved) {
                const now = doc.decal(g, id)!;
                expect(now).toBeDefined();
                expect(scene.decalLayer(g, id)).toBeDefined();
            }
            const xs = moved.map(([g, id]) => doc.decal(g, id)!.x).sort((a, b) => a - b);
            expect(xs).toEqual([...before.values()].map((b) => b.x + 20).sort((a, b) => a - b));
            // a quarter turn: angles turn, ids stay valid
            const anglesBefore = [...before.values()].map((b) => b.angle).sort();
            editor.rotateSelection(1);
            const turned = [...editor.selected.decalList()];
            for (const [g, id] of turned) expect(doc.decal(g, id)).toBeDefined();
            const anglesAfter = turned.map(([g, id]) => doc.decal(g, id)!.angle);
            expect(anglesAfter.map((a) => Math.round(Math.cos(a) * 1e6) / 1e6).sort()).toEqual(anglesBefore.map((a) => Math.round(Math.cos(a + Math.PI / 2) * 1e6) / 1e6).sort());
            // copy and paste them back where they came from, then delete the moved ones
            const clip = editor.copy()!;
            expect(clip.decals.length).toBe(ids.length);
            const r = pasteClip(doc, clip, { grid, anchor: [d.x, d.y], turns: 0 });
            expect(r.decals.length).toBe(ids.length);
            const removed = editor.deleteSelection();
            expect(removed).toEqual([]);
            for (const [g, id] of turned) expect(doc.decal(g, id)).toBeUndefined();
            while (doc.canUndo) doc.undo();
            expect(doc.serialize(NOW)).toBe(text);
        });
    }
});
