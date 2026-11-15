import { describe, expect, it } from "vitest";
import { flipClip, type Clip } from "../src/editor/clipboard";
import { mirrorCopies, mirrorEntity, mirrorTileRotation } from "../src/editor/mirror";
import { Editor } from "../src/editor/tools";
import { MapDocument } from "../src/map/document";
import { Pack } from "../src/pack/loader";
import { pipeConnectionsAtRotation, Scene } from "../src/render/scene";

const TRIAD = "https://github.com/Triad-Sector/Triad_Sector";
const lattice = { name: "lattice", sprite: null, variants: 1, isSubfloor: true };
const bend = {
    NodeContainer: { nodes: { pipe: { pipeDirection: "NEBend" } } },
    Transform: { anchored: true },
};
const packFor = (repo = TRIAD) => Pack.fromData(
    {
        format: 1, fork: { id: "test", repo, branch: "", commit: "", engineCommit: null }, builtAt: "",
        files: { prototypes: "", textures: "" }, stats: { entities: 2, placeable: 2, tiles: 4, decals: 2, rsi: 0, frames: 2, pages: 1 },
    },
    {
        entities: {
            Bend: { name: "Bend", components: bend, placement: { mode: "SnapgridCenter" } },
            Thruster: {
                name: "Thruster", components: {
                    Transform: { anchored: true },
                    Thruster: {},
                    Sprite: { layers: [
                        { texture: "body.png" },
                        { texture: "flame.png", visible: false, map: ["enum.ThrusterVisualLayers.ThrustOn"] },
                    ] },
                },
            },
        },
        tiles: { Lattice: { ...lattice, isSpace: true }, LatticeCornerNE: lattice, Plating: lattice, Floor: { ...lattice, variants: 4 } },
        decals: { StripeNE: { sprite: null }, StripeNW: { sprite: null } },
        stacks: {}, migrations: {}, tileAliases: {}, colors: {},
    },
    { pages: ["page.webp"], textures: { "body.png": [[0, 0, 0, 32, 32]], "flame.png": [[0, 32, 0, 32, 32]] }, rsi: {} },
);

const now = new Date(2026, 10, 15, 10, 0, 0);
function open(format = 7, repo = TRIAD) {
    const pack = packFor(repo);
    const doc = new MapDocument(`meta:
  format: ${format}
tilemap:
  0: Space
entities:
- proto: ""
  entities:
  - uid: 1
    components:
    - type: MapGrid
      chunks: {}
...
`);
    const scene = new Scene(doc, pack);
    const editor = new Editor(doc, scene, pack, { visible: () => true });
    doc.onChange((e) => { scene.apply(e); editor.validate(); });
    return { doc, scene, editor, pack };
}

describe("mirror building", () => {
    it("deduplicates points on either axis and mirrors a pipe bend's connections", () => {
        expect(mirrorCopies([1, 0.5], [1, 1], "both").map((c) => c.at)).toEqual([[1, 0.5], [1, 1.5]]);
        const look = mirrorEntity(packFor(), "Bend", 0, "horizontal");
        expect(pipeConnectionsAtRotation(bend, look.angle)).toEqual([["Pipe", 0, 1 | 4]]);
        for (const flip of ["horizontal", "vertical", "both"] as const) {
            for (let rm = 0; rm < 8; rm++) expect(mirrorTileRotation(mirrorTileRotation(rm, flip), flip)).toBe(rm);
        }
    });

    it.each([6, 7])("paints all four tile positions with one variant and undoes one stroke (format %s)", (format) => {
        const { editor, doc } = open(format);
        editor.mirrorMode = "both";
        editor.mirrorAxes.set(1, [2, 2]);
        editor.variant = () => 2;
        const before = doc.serialize(now);
        editor.beginStroke("Paint");
        expect(editor.paint("Floor", 0.5, 0.5)).toBe(true);
        expect(editor.paint("Floor", 3.5, 3.5)).toBe(false);
        expect(editor.finish()).toBe(true);
        const cells = [[0, 0], [3, 0], [0, 3], [3, 3]] as const;
        expect(cells.map(([x, y]) => doc.tile(1, x, y).variant)).toEqual([2, 2, 2, 2]);
        expect(cells.map(([x, y]) => doc.tile(1, x, y).rotationMirroring)).toEqual(format === 7 ? [0, 4, 6, 2] : [0, 0, 0, 0]);
        expect(editor.undo()).toBe("Paint");
        expect(doc.serialize(now)).toBe(before);
    });

    it("places mirrored entities only on tiles, even if only the reflected side has one", () => {
        const { doc, editor } = open();
        doc.setTile(1, 2, 0, "Plating");
        editor.mirrorMode = "horizontal";
        editor.mirrorAxes.set(1, [1.5, 0]);
        const before = doc.serialize(now);
        const uid = editor.place("Bend", 0.5, 0.5)!;
        expect(doc.transform(uid)).toMatchObject({ x: 2.5, y: 0.5 });
        expect(pipeConnectionsAtRotation(bend, doc.transform(uid).rotation)).toEqual([["Pipe", 0, 1 | 4]]);
        expect(doc.uids()).toHaveLength(2);
        expect(editor.undo()).toBe("Place");
        expect(doc.serialize(now)).toBe(before);
    });

    it("draws mirrored shapes and places the directional decal pair", () => {
        const { doc, editor, scene } = open();
        editor.mirrorMode = "horizontal";
        editor.mirrorAxes.set(1, [2, 0]);
        expect(editor.drawShape("line", false, { kind: "tile", id: "Plating" }, [0.5, 0.5], [0.5, 2.5])).toBe(6);
        expect([...scene.tileCells(1)]).toHaveLength(6);
        const before = doc.serialize(now);
        const props = { proto: "StripeNE", color: null, angle: 0, zIndex: 0, cleanable: false };
        expect(editor.placeDecals(props, 1, [[0, 0]])).toHaveLength(2);
        expect(doc.decals(1).map((d) => [d.x, d.proto])).toEqual([[0, "StripeNE"], [3, "StripeNW"]]);
        editor.undo();
        expect(doc.serialize(now)).toBe(before);
    });

    it("reflects a selected tile and the paste plan with its real tile orientation", () => {
        const { doc, scene, editor, pack } = open();
        doc.setTile(1, 0, 0, "Floor", 2, 1);
        doc.setTile(1, 2, 0, "Plating");
        editor.selected.addTile(1, 0, 0);
        editor.selected.addTile(1, 2, 0);
        const text = doc.serialize(now);
        expect(editor.flipSelection("horizontal")).toBe(true);
        expect(scene.tileAt(1, 2, 0)).toBe("Floor");
        expect(doc.tile(1, 2, 0).rotationMirroring).toBe(5);
        expect(editor.flipSelection("horizontal")).toBe(true);
        expect(doc.serialize(now)).toBe(text);
        expect(editor.undo()).toBe("Flip horizontally");
        expect(scene.tileAt(1, 2, 0)).toBe("Floor");
        expect(editor.redo()).toBe("Flip horizontally");
        expect(doc.serialize(now)).toBe(text);

        const clip: Clip = editor.copy()!;
        const flipped = flipClip(clip, 1, "vertical", pack);
        const floor = flipped.tiles.find((t) => t.name === "Floor")!;
        expect(floor.y).toBe(1);
        expect(floor.rot).toBe(4);
    });
});

describe("Triad thruster preview", () => {
    it.each([TRIAD, "https://github.com/example/another-fork"])("checks lattice and plating for %s", (repo) => {
        const { scene, doc } = open(7, repo);
        doc.setTile(1, 0, 0, "Plating");
        doc.setTile(1, 0, 1, "LatticeCornerNE");
        const uid = doc.addEntity("Thruster", 1, 0.5, 0.5);
        const glows = () => scene.layersOf(uid).some((l) => l.layer === 1 && l.power === 1);
        expect(glows()).toBe(repo === TRIAD);
        doc.setTile(1, 0, 1, "Plating");
        expect(glows()).toBe(false);
        doc.setTile(1, 0, 1, "Lattice");
        expect(glows()).toBe(true);
    });
});
