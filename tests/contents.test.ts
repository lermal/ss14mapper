// Putting entities into containers from the editor: the container a drop goes into, several copies in one step,
// refusals, and where an entity taken out lands.
import { describe, expect, it } from "vitest";
import { Contents, freeTileNear, takeOutPlace, type Floor } from "../src/editor/contents";
import { ContainerRulesEngine } from "../src/map/container-rules";
import { MapDocument } from "../src/map/document";
import type { ContainerRules, PrototypeData } from "../src/pack/format";

const NOW = new Date(2026, 10, 14, 12, 0, 0);

const RULES: ContainerRules = {
    itemSizes: {
        Tiny: { weight: 1, shape: ["0,0,0,0"] },
        Small: { weight: 2, shape: ["0,0,0,1"] },
        Normal: { weight: 4, shape: ["0,0,1,1"] },
        Huge: { weight: 16, shape: ["0,0,3,3"] },
    },
    defaultItemSize: "Small",
    defaultStorageMaxItemSize: "Normal",
    entityStorage: { capacity: 30, maxSize: 1, whitelist: { components: ["Item"] }, blacklist: true },
    boundsFloor: 0.6,
    bounds: { Locker: [0.9, 0.9], Table: [1.5, 1] },
};

const DATA: PrototypeData = {
    entities: {
        BaseItem: { abstract: true, components: { Item: {}, Physics: { bodyType: "Dynamic" } } },
        Crowbar: { parents: ["BaseItem"], components: {} },
        Cell: { parents: ["BaseItem"], components: { Tag: { tags: ["Cell"] } } },
        Bag: { parents: ["BaseItem"], components: { Item: { size: "Normal" }, Storage: { grid: ["0,0,1,1"] }, ContainerContainer: { containers: { storagebase: { "!type": "Container", ents: [] } } } } },
        Lamp: { parents: ["BaseItem"], components: { ItemSlots: { slots: { cell_slot: { whitelist: { tags: ["Cell"] } } } }, ContainerContainer: { containers: { cell_slot: null } } } },
        Locker: { components: { EntityStorage: { capacity: 3 }, Physics: { bodyType: "Static" }, ContainerContainer: { containers: { entity_storage: null } } } },
        Table: { components: { Physics: { bodyType: "Static" } } },
    },
};

const kit = { pack: { data: DATA }, rules: new ContainerRulesEngine({ data: DATA, rules: RULES }) };

function mapOf(entities: Array<[number, string, number, number]>): string {
    const lines = ["meta:", "  format: 7", "  entityCount: " + (entities.length + 1), "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
    const byProto = new Map<string, Array<[number, number, number]>>();
    for (const [uid, proto, x, y] of entities) byProto.set(proto, [...(byProto.get(proto) ?? []), [uid, x, y]]);
    for (const [proto, list] of [...byProto].sort()) {
        lines.push(`- proto: ${proto}`, "  entities:");
        for (const [uid, x, y] of list) lines.push(`  - uid: ${uid}`, "    components:", "    - type: Transform", `      pos: ${x}.5,${y}.5`, "      parent: 1");
    }
    return lines.join("\n") + "\n...\n";
}

const SMALL = mapOf([
    [10, "Locker", 0, 0],
    [20, "Crowbar", 5, 5],
    [21, "Table", 1, 0],
    [30, "Bag", 6, 6],
    [40, "Lamp", 7, 7],
]);

describe("putting in from the editor", () => {
    it("picks the container a drop goes into and says why when none takes it", () => {
        const doc = new MapDocument(SMALL);
        const c = new Contents(doc, kit);
        expect(c.hasContainers(10)).toBe(true);
        expect(c.hasContainers(21)).toBe(false);
        expect(c.target(10, { proto: "Crowbar" })).toEqual({ id: "entity_storage" });
        expect(c.target(30, { proto: "Crowbar" })).toEqual({ id: "storagebase" });
        expect(c.target(40, { proto: "Cell" })).toEqual({ id: "cell_slot" });
        expect(c.target(40, { proto: "Crowbar" })).toEqual({ reason: "Crowbar does not fit in cell_slot" });
        // a locker into a bag: not an item
        expect(c.target(30, 10)).toEqual({ reason: "Locker is not an item" });
        expect(c.target(21, { proto: "Crowbar" })).toEqual({ reason: "Table has no containers" });
    });

    it("adds several copies as one undo step and stops when full", () => {
        const doc = new MapDocument(SMALL);
        const c = new Contents(doc, kit);
        const r = c.put(10, "entity_storage", { proto: "Crowbar" }, 5);
        expect(r).toEqual({ ok: true, uids: [41, 42, 43], reason: "Locker is full (3)" });
        expect(doc.containers(10, kit.pack)[0]!.contents).toEqual([41, 42, 43]);
        expect(c.put(10, "entity_storage", { proto: "Crowbar" })).toEqual({ ok: false, reason: "Locker is full (3)" });
        doc.undo();
        expect(doc.serialize(NOW)).toBe(SMALL);
        expect(doc.canUndo).toBe(false);
    });

    it("moves a placed entity in and a stored one between containers, bag places from the rules", () => {
        const doc = new MapDocument(SMALL);
        const c = new Contents(doc, kit);
        expect(c.put(30, "storagebase", 20)).toEqual({ ok: true, uids: [20] });
        expect(doc.serialize(NOW)).toContain("        20:\n          position: 0,0\n          _rotation: South");
        expect(c.put(10, "entity_storage", 20)).toEqual({ ok: true, uids: [20] });
        expect(doc.containerOf(20)).toMatchObject({ owner: 10 });
        expect(c.put(10, "entity_storage", 30)).toMatchObject({ ok: true });
        // nested: the bag's contents, the outermost holder
        c.put(30, "storagebase", { proto: "Crowbar" });
        expect(c.outermost(41)).toBe(10);
        expect(c.preset(10, "entity_storage")).toEqual([{ proto: "Crowbar", count: 1 }, { proto: "Bag", count: 1, contents: { storagebase: [{ proto: "Crowbar", count: 1 }] } }]);
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it("takes out onto the tile of the outermost holder", () => {
        const doc = new MapDocument(SMALL);
        const c = new Contents(doc, kit);
        c.put(10, "entity_storage", 30);
        const [crowbar] = (c.put(30, "storagebase", { proto: "Crowbar" }) as { uids: number[] }).uids;
        // floor: a 3×3 room around the locker at 0,0; the table at 1,0 is anchored, a loose item at 0,1
        const floor: Floor = {
            tileAt: (_g, x, y) => (Math.abs(x) <= 1 && Math.abs(y) <= 1 ? "Floor" : null),
            anchoredAt: (_g, x, y) => (x === 1 && y === 0 ? [21] : []),
            looseAt: (_g, x, y) => x === 0 && y === 1,
        };
        const holder = doc.transform(10);
        const at = { grid: 1, x: Math.floor(holder.x) + 0.5, y: Math.floor(holder.y) + 0.5 };
        expect(takeOutPlace(c, floor, crowbar!)).toEqual(at);
        c.takeOut(crowbar!, takeOutPlace(c, floor, crowbar!)!);
        expect(doc.transform(crowbar!)).toEqual({ x: at.x, y: at.y, rotation: 0, parent: 1 });
        expect(doc.containerOf(crowbar!)).toBeNull();
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it("searches free tiles nearest first, then tiles with loose items, then the tile itself", () => {
        const tiles = new Set(["0,0", "1,0", "0,1", "2,0", "-1,-1"]);
        const floor = (anchored: string[], loose: string[]): Floor => ({
            tileAt: (_g, x, y) => (tiles.has(`${x},${y}`) ? "Floor" : null),
            anchoredAt: (_g, x, y) => (anchored.includes(`${x},${y}`) ? [1] : []),
            looseAt: (_g, x, y) => loose.includes(`${x},${y}`),
        });
        expect(freeTileNear(floor([], []), 1, 0.5, 0.5)).toEqual([1, 0]);
        expect(freeTileNear(floor(["1,0"], []), 1, 0.5, 0.5)).toEqual([0, 1]);
        expect(freeTileNear(floor(["1,0", "0,1"], []), 1, 0.5, 0.5)).toEqual([-1, -1]);
        expect(freeTileNear(floor(["1,0", "0,1", "-1,-1"], []), 1, 0.5, 0.5)).toEqual([2, 0]);
        expect(freeTileNear(floor(["1,0", "0,1", "-1,-1"], ["2,0"]), 1, 0.5, 0.5)).toEqual([2, 0]);
        expect(freeTileNear(floor(["1,0", "0,1"], ["-1,-1", "2,0"]), 1, 0.5, 0.5)).toEqual([-1, -1]);
        expect(freeTileNear(floor(["1,0", "0,1", "-1,-1", "2,0"], []), 1, 0.5, 0.5)).toEqual([0, 0]);
        expect(freeTileNear(floor([], []), 1, 9.5, 9.5)).toBeNull();
    });
});
