// Component overrides: read as the file has them, replaced, added and removed in the game's style, undone
// byte for byte, and followed by the scene.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
const NOW = new Date(2026, 10, 13, 12, 34, 56);
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const has = (f: string) => fs.existsSync(path.join(root, f));

const BARNACLE = "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml";
const EMERGENCY = "upstream/Resources/Maps/Shuttles/emergency.yml";
const HAUNTED = "goob/Resources/Maps/Dungeon/haunted.yml"; // old format: `type:` after the fields
const MAPS = [BARNACLE, EMERGENCY, "upstream/Resources/Maps/Shuttles/cargo_hike.yml"].filter(has);

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

const small = [
    "meta:", "  format: 7", "  entityCount: 2", "tilemap:", "  0: Space", "entities:", "- proto: \"\"", "  entities:", "  - uid: 1", "    components:",
    "    - type: MapGrid", "      chunks: {}", "- proto: AirlockCommand", "  entities:", "  - uid: 2", "    components:", "    - type: Transform",
    "      pos: 0.5,0.5", "      parent: 1", "    - type: DeviceLinkSink", "      ports:", "      - Open", "      - Close", "...",
].join("\n") + "\n";

describe.skipIf(!MAPS.length)("component overrides as in the file", () => {
    for (const file of MAPS) {
        it(`${file}: every override written back from its text is unchanged`, () => {
            const source = read(file);
            const doc = new MapDocument(source);
            let n = 0;
            for (const uid of doc.uids()) {
                for (const c of doc.components(uid)) {
                    doc.setComponent(uid, c.type, c.text);
                    n++;
                }
            }
            expect(n).toBeGreaterThan(100);
            expect(doc.canUndo).toBe(false);
            expect(doc.serialize(NOW)).toBe(source);
        });
    }

    it.skipIf(!has(HAUNTED))("rewrites an old-format override with `type:` first", () => {
        const source = read(HAUNTED);
        const doc = new MapDocument(source);
        const grid = doc.listedGrids()[0]!;
        const decals = doc.components(grid).find((c) => c.type === "DecalGrid")!;
        expect(decals.text.startsWith("chunkCollection:\n  version: 2\n  nodes:\n  - node:\n")).toBe(true);
        doc.setComponent(grid, "DecalGrid", decals.text);
        expect(doc.components(grid).find((c) => c.type === "DecalGrid")).toEqual(decals);
        const out = doc.serialize(NOW);
        expect(out).toContain("    - type: DecalGrid\n      chunkCollection:\n        version: 2\n");
        expect(new MapDocument(out).decals(grid)).toEqual(doc.decals(grid));
        doc.undo();
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe("component edits", () => {
    it("adds MetaData first, as saved maps have it, and undoes byte for byte", () => {
        const doc = new MapDocument(small);
        doc.setComponent(2, "MetaData", "name: Bridge");
        expect(changed(small, doc.serialize(NOW)).added).toEqual(["    - type: MetaData", "      name: Bridge"]);
        expect(doc.serialize(NOW)).toContain("  - uid: 2\n    components:\n    - type: MetaData\n      name: Bridge\n    - type: Transform\n");
        expect(doc.components(2)[0]).toEqual({ type: "MetaData", text: "name: Bridge", data: { name: "Bridge" } });
        expect(doc.entityData(2)!.components[0]).toEqual({ type: "MetaData", name: "Bridge" });
        doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
    });

    it("replaces an override, keeping the text as written, with or without `type:`", () => {
        const doc = new MapDocument(small);
        expect(doc.components(2)[1]).toEqual({ type: "DeviceLinkSink", text: "ports:\n- Open\n- Close", data: { ports: ["Open", "Close"] } });
        doc.setComponent(2, "DeviceLinkSink", "type: DeviceLinkSink\nports:\n- Toggle  # comment\nlinks: {}\n");
        expect(changed(small, doc.serialize(NOW))).toEqual({
            removed: ["      - Open", "      - Close"],
            added: ["      - Toggle  # comment", "      links: {}"],
        });
        expect(doc.components(2)[1]!.data).toEqual({ ports: ["Toggle"], links: {} });
        // indented text (pasted from a file) is read the same
        doc.setComponent(2, "DeviceLinkSink", "      ports:\n      - Open\n      - Close");
        expect(doc.serialize(NOW)).toBe(small.replace(/  time: .*\n/, ""));
        doc.undo();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
    });

    it("adds components where other entities of the prototype have them, else last", () => {
        const two = small.replace(
            "...\n",
            ["  - uid: 3", "    components:", "    - type: Transform", "      pos: 1.5,0.5", "      parent: 1", "    - type: AccessReader", "      access: []",
                "    - type: DeviceLinkSink", "      ports: []", "...", ""].join("\n"),
        );
        const doc = new MapDocument(two);
        doc.setComponent(2, "AccessReader", "access: [['Command']]");
        expect(doc.components(2).map((c) => c.type)).toEqual(["Transform", "AccessReader", "DeviceLinkSink"]);
        doc.setComponent(2, "Wires", "layoutId: Airlock");
        expect(doc.components(2).map((c) => c.type)).toEqual(["Transform", "AccessReader", "DeviceLinkSink", "Wires"]);
        doc.setComponent(2, "Paper", "");
        expect(doc.serialize(NOW)).toContain("    - type: Wires\n      layoutId: Airlock\n    - type: Paper\n  - uid: 3\n");
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(two);
    });

    it("removes overrides, but not Transform or MapGrid", () => {
        const doc = new MapDocument(small);
        expect(doc.removeComponent(2, "DeviceLinkSink")).toBe(true);
        expect(doc.removeComponent(2, "DeviceLinkSink")).toBe(false);
        expect(changed(small, doc.serialize(NOW)).removed).toEqual(["    - type: DeviceLinkSink", "      ports:", "      - Open", "      - Close"]);
        expect(() => doc.removeComponent(2, "Transform")).toThrow(/Transform/);
        expect(() => doc.removeComponent(1, "MapGrid")).toThrow(/MapGrid/);
        doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
        expect(doc.canUndo).toBe(false);
    });

    it("edits Transform only within what the editor keeps consistent", () => {
        const doc = new MapDocument(small);
        doc.setComponent(2, "Transform", "rot: 1.5707963267948966 rad\npos: 2.5,3.5\nparent: 1");
        expect(doc.transform(2)).toEqual({ x: 2.5, y: 3.5, rotation: Math.PI / 2, parent: 1 });
        expect(() => doc.setComponent(2, "Transform", "pos: 0.5,0.5\nparent: 2")).toThrow(/parent/);
        expect(() => doc.setComponent(2, "Transform", "pos: 0.5,0.5")).toThrow(/parent/);
        expect(() => doc.setComponent(2, "Transform", "pos: here\nparent: 1")).toThrow(/pos/);
        expect(() => doc.setComponent(2, "Transform", "rot: 90 deg\npos: 1,1\nparent: 1")).toThrow(/rot/);
        doc.undo();
        expect(doc.serialize(NOW)).toBe(small);
    });

    it("rejects text the game could not read", () => {
        const doc = new MapDocument(small);
        const bad: Array<[string, RegExp]> = [
            ["name: 'Bridge", /quote/],
            ['name: "Bridge', /quote/],
            ["ports: [Open, Close", /brackets/],
            ["name: a\nname: b", /Duplicate/],
            ["name: a: b", /":"/],
            ["\tname: Bridge", /tabs/],
            ["- name: Bridge", /YAML|fields/],
            ["just text", /YAML|fields/],
            ["type: Other\nname: x", /does not match/],
        ];
        for (const [text, error] of bad) expect(() => doc.setComponent(2, "MetaData", text), text).toThrow(error);
        expect(() => doc.setComponent(2, "Bad Name", "")).toThrow(/component name/);
        expect(() => doc.setComponent(99, "MetaData", "")).toThrow(/No entity/);
        expect(doc.canUndo).toBe(false);
        expect(doc.serialize(NOW)).toBe(small);
    });
});

describe.skipIf(!has(BARNACLE) || !packFor("frontier"))("scenes follow component edits", () => {
    it("redraws an entity whose overrides change", () => {
        const pack = packFor("frontier")!;
        const source = read(BARNACLE);
        const doc = new MapDocument(source);
        const scene = new Scene(doc, pack);
        doc.onChange((c) => scene.apply(c));
        const layers = (s: Scene, uid: number) => s.layersOf(uid).map((l) => `${l.x},${l.y} ${l.rot} ${s.frames[l.frame]!.join(":")} ${l.color}`).sort();
        const uid = doc.uids().find((u) => scene.layersOf(u).length > 0 && doc.transform(u).parent !== null && !doc.components(u).some((c) => c.type === "Sprite"))!;
        const drawn = layers(scene, uid);

        doc.setComponent(uid, "Sprite", "color: '#FF0000FF'");
        expect(layers(scene, uid)).toEqual(layers(new Scene(doc, pack), uid));
        expect(layers(scene, uid)).not.toEqual(drawn);
        expect(scene.layersOf(uid).every((l) => l.color?.[1] === 0)).toBe(true);

        const t = doc.transform(uid);
        doc.setComponent(uid, "Transform", doc.components(uid).find((c) => c.type === "Transform")!.text.replace(/pos: .*/, `pos: ${t.x + 2},${t.y}`));
        expect(layers(scene, uid)).toEqual(layers(new Scene(doc, pack), uid));

        doc.removeComponent(uid, "Sprite");
        doc.undo();
        doc.undo();
        doc.undo();
        expect(layers(scene, uid)).toEqual(drawn);
        expect(doc.serialize()).toBe(source);
    });
});
