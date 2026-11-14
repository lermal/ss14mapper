import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
import { newMapText, startingFloors, type NewMapKind } from "../src/map/new-map";
import { Scene } from "../src/render/scene";
import { packFor } from "./pack-files";

const forks = ["upstream", "frontier", "goob"];
// components after MapGrid that the game writes on a fresh grid of each fork (corpus: grids of recent maps)
const common = ["Broadphase", "Physics", "Fixtures", "OccluderTree", "SpreaderGrid", "Shuttle", "GridPathfinding", "Gravity", "GridAtmosphere", "GasTileOverlay", "RadiationGridResistance", "ImplicitRoof"];
const expected: Record<string, string[]> = {
    upstream: common,
    frontier: [...common, "DecalGrid"],
    goob: [...common, "DecalGrid", "FTLDrive"],
};
const now = new Date(2026, 10, 14, 12, 0, 0);

describe.each(forks)("new maps for %s", (fork) => {
    const pack = packFor(fork);
    describe.skipIf(!pack)("with a pack", () => {
        const make = (kind: NewMapKind, floor?: { tile: string; width: number; height: number }) =>
            newMapText({ kind, name: "Tug", pack: pack!, floor, now });

        for (const kind of ["shuttle", "map"] as const) {
            describe(kind, () => {
                it("opens and saves byte for byte, with and without a floor", () => {
                    for (const floor of [undefined, { tile: "Plating", width: 5, height: 3 }, { tile: "FloorSteel", width: 40, height: 33 }]) {
                        const text = make(kind, floor);
                        expect(text.endsWith("\n...\n")).toBe(true);
                        expect(text).not.toContain("\r");
                        expect(new MapDocument(text).serialize()).toBe(text);
                    }
                });

                it("has the structure of the fork's grids", () => {
                    const text = make(kind, { tile: "Plating", width: 5, height: 3 });
                    const doc = new MapDocument(text);
                    const isMap = kind === "map";
                    expect(doc.format).toBe(7);
                    expect(text).toContain(`category: ${isMap ? "Map" : "Grid"}\n`);
                    expect(text).toContain(`entityCount: ${doc.uids().length}\n`);
                    expect(doc.uids().length).toBe(isMap ? 2 : 1);
                    expect(doc.grids()).toEqual([isMap ? 2 : 1]);
                    expect(doc.listedGrids()).toEqual(doc.grids());
                    const grid = doc.grids()[0]!;
                    expect(doc.transform(grid).parent).toBe(isMap ? 1 : null);
                    expect(text.match(/^orphans:.*$/m)![0]).toBe(isMap ? "orphans: []" : "orphans:");
                    expect(text.startsWith("meta:\n  format: 7\n")).toBe(true);
                    expect(text).toMatch(/\ntilemap:\n {2}0: Space\n {2}1: Plating\nentities:\n- proto: ""\n/);
                    expect(doc.components(grid).map((c) => c.type)).toEqual(expect.arrayContaining(expected[fork]!));
                    const types = (text.slice(text.indexOf(`  - uid: ${grid}`)).match(/^ {4}- type: (\w+)/gm) ?? []).map((l) => l.replace(/.*type: /, ""));
                    expect(types.slice(0, 3)).toEqual(["MetaData", "Transform", "MapGrid"]);
                    expect([...types].sort()).toEqual(["MetaData", "Transform", "MapGrid", ...expected[fork]!].sort());
                    if (isMap) expect(text).toMatch(/- type: Map\n {6}mapPaused: True\n {4}- type: GridTree/);
                    expect(doc.tiles(grid)).toHaveLength(15);
                    expect(doc.tiles(grid).every((t) => doc.tilemap().get(t.tile.id) === "Plating")).toBe(true);
                });

                it("has no tiles without a floor", () => {
                    const doc = new MapDocument(make(kind));
                    expect(doc.tiles(doc.grids()[0]!)).toEqual([]);
                    expect(make(kind)).toContain("      chunks: {}\n");
                });

                it("draws the floor and edits like any map", () => {
                    const text = make(kind, { tile: "Plating", width: 5, height: 3 });
                    const doc = new MapDocument(text);
                    const grid = doc.grids()[0]!;
                    const scene = new Scene(doc, pack!);
                    expect([...scene.tiles].filter((t) => t.grid === grid)).toHaveLength(15);

                    const wall = doc.addEntity("WallSolid", grid, 1.5, 1.5);
                    doc.setTile(grid, 7, 0, "FloorSteel");
                    doc.setTile(grid, 0, 0, "Space");
                    expect(doc.proto(wall)).toBe("WallSolid");
                    const edited = doc.serialize(new Date(2027, 0, 1));
                    expect(edited).toContain("proto: WallSolid");
                    expect(new MapDocument(edited).serialize()).toBe(edited);
                    while (doc.undo());
                    expect(doc.serialize()).toBe(text);
                });
            });
        }

        it("names the grid of a shuttle and the entity of a map", () => {
            expect(make("shuttle")).toContain("name: Tug\n");
            const map = make("map");
            expect(map).toContain("name: Tug\n");
            expect(map).toContain("name: grid\n");
            expect(newMapText({ kind: "shuttle", name: "Big: ship #1", pack: pack!, now })).toContain("name: 'Big: ship #1'");
        });

        it("writes the fork's engine version and empty fork fields", () => {
            const doc = make("shuttle");
            expect(doc).toMatch(/engineVersion: \d+\.\d+\.\d+\n {2}forkId: ""\n {2}forkVersion: ""\n {2}time: 11\/14\/2026 12:00:00\n/);
            expect(newMapText({ kind: "shuttle", name: "X", pack: pack!, engineVersion: "1.2.3", now })).toContain("engineVersion: 1.2.3");
        });

        it("rejects bad input", () => {
            expect(() => make("shuttle", { tile: "NoSuchTile", width: 1, height: 1 })).toThrow(/Unknown floor tile/);
            expect(() => make("shuttle", { tile: "Plating", width: 0, height: 1 })).toThrow(/floor/);
            expect(() => make("shuttle", { tile: "Plating", width: 1.5, height: 1 })).toThrow(/floor/);
            expect(() => newMapText({ kind: "shuttle", name: " ", pack: pack! })).toThrow(/name/);
        });

        it("offers starting floors that the pack has", () => {
            expect(startingFloors(pack!)).toContain("Plating");
            expect(startingFloors(pack!).every((t) => pack!.tile(t))).toBe(true);
        });
    });
});
