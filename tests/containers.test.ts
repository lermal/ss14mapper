// Container contents: entities put into lockers, bags and slots, taken out and moved, written as the game saves
// stored entities; taking out and putting back gives the file back byte for byte, and so does undo.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findStorageSpot, fitsInStorage, parseBox, placedShape, type Box, type ContainerPack } from "../src/map/containers";
import { MapDocument } from "../src/map/document";
import type { PrototypeData } from "../src/pack/format";
// @ts-expect-error plain JS helper shared with the command line
import { corpusFiles, corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
const NOW = new Date(2026, 10, 14, 12, 0, 0);
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const has = (f: string) => fs.existsSync(path.join(root, f));
/** The file without its save time (written anew by every edited save). */
const timeless = (s: string) => s.replace(/^  time: .*$/m, "");

function undoAll(doc: MapDocument): void {
    while (doc.canUndo) doc.undo();
}

const entityIndex = new Map<string, Map<number, string>>();
/** An entity's lines in a saved file, from "  - uid: N" to the next entity or group (indexed once per file). */
function entityText(file: string, uid: number): string {
    let index = entityIndex.get(file);
    if (!index) {
        index = new Map();
        const lines = file.split("\n");
        let start = -1;
        const close = (end: number) => {
            if (start !== -1) index!.set(Number(lines[start]!.slice("  - uid: ".length)), lines.slice(start, end).join("\n"));
            start = -1;
        };
        lines.forEach((l, i) => {
            if (/^ {2}- uid: |^- proto: |^[a-z.]/.test(l)) close(i);
            if (/^ {2}- uid: \d+$/.test(l)) start = i;
        });
        close(lines.length);
        if (entityIndex.size > 4) entityIndex.clear();
        entityIndex.set(file, index);
    }
    return index.get(uid) ?? "";
}

/** A component's lines inside an entity's text. */
function componentText(entity: string, type: string): string {
    const lines = entity.split("\n");
    const start = lines.indexOf(`    - type: ${type}`);
    if (start === -1) return "";
    let end = start + 1;
    while (end < lines.length && lines[end]!.startsWith("      ")) end++;
    return lines.slice(start, end).join("\n");
}

const packs = new Map<string, Promise<ContainerPack | undefined>>();
function packData(fork: string): Promise<ContainerPack | undefined> {
    if (!packs.has(fork)) {
        packs.set(
            fork,
            (async () => {
                const pack = packFor(fork === "ci-test" ? "upstream" : fork);
                if (!pack) return undefined;
                const schemas = await pack.componentSchemas();
                return {
                    data: await pack.prototypeData(),
                    migrate: (id: string) => pack.migrate(id),
                    insideStorageField: !!schemas?.components.InsideEntityStorage?.some((f) => f.name === "storage"),
                };
            })(),
        );
    }
    return packs.get(fork)!;
}

// ---------------------------------------------------------------------------------------------
// A small map and pack

const DATA: PrototypeData = {
    entities: {
        BaseItem: { abstract: true, components: { Item: { size: "Small" }, Physics: { bodyType: "Dynamic" } } },
        Crowbar: { parents: ["BaseItem"], components: { Tag: { tags: ["Crowbar"] } } },
        Locker: { components: { EntityStorage: { capacity: 2 }, Physics: { bodyType: "Static" }, ContainerContainer: { containers: { entity_storage: null, paper_label: null } }, PaperLabel: {} } },
        Bag: { parents: ["BaseItem"], components: { Storage: { grid: ["0,0,3,1"] }, ContainerContainer: { containers: { storagebase: { "!type": "Container", ents: [] } } } } },
        Lamp: { parents: ["BaseItem"], components: { ItemSlots: { slots: { cell_slot: {} } }, ContainerContainer: { containers: { cell_slot: null } } } },
        Hologram: { components: {} },
    },
};
const PACK: ContainerPack = { data: DATA };

/** A map in the older engine's order (Transform `pos, parent`), with entities as [uid, proto, extra component lines]. */
function mapOf(entities: Array<[number, string, string]>): string {
    const lines = ["meta:", "  format: 7", "  entityCount: " + (entities.length + 1), "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
    const byProto = new Map<string, Array<[number, string]>>();
    for (const [uid, proto, extra] of entities) byProto.set(proto, [...(byProto.get(proto) ?? []), [uid, extra]]);
    for (const [proto, list] of [...byProto].sort()) {
        lines.push(`- proto: ${proto}`, "  entities:");
        for (const [uid, extra] of list) lines.push(`  - uid: ${uid}`, "    components:", "    - type: Transform", `      pos: ${uid}.5,0.5`, "      parent: 1", ...extra.split("\n").filter(Boolean).map((l) => "    " + l));
    }
    return lines.join("\n") + "\n...\n";
}

const SMALL = mapOf([
    [10, "Locker", ""],
    [11, "Locker", "- type: EntityStorage\n  open: True"],
    [20, "Crowbar", ""],
    [21, "Crowbar", ""],
    [22, "Crowbar", ""],
    [30, "Bag", ""],
    [40, "Lamp", ""],
    [50, "Hologram", ""],
]);

describe("putting in and taking out", () => {
    it("writes a placed entity put into an empty locker as the game stores it, and takes it out again", () => {
        const doc = new MapDocument(SMALL);
        const changes: number[][] = [];
        doc.onChange((c) => changes.push(c.entities));
        expect(doc.containers(10, PACK).map((c) => [c.id, c.kind, c.role, c.contents])).toEqual([
            ["entity_storage", "Container", "entityStorage", []],
            ["paper_label", "ContainerSlot", "itemSlot", []],
        ]);
        doc.insertIntoContainer(10, "entity_storage", 20, { pack: PACK });
        const text = doc.serialize(NOW);
        expect(entityText(text, 10)).toBe(
            [
                "  - uid: 10",
                "    components:",
                "    - type: Transform",
                "      pos: 10.5,0.5",
                "      parent: 1",
                "    - type: ContainerContainer",
                "      containers:",
                "        entity_storage: !type:Container",
                "          showEnts: False",
                "          occludes: True",
                "          ents:",
                "          - 20",
                "        paper_label: !type:ContainerSlot",
                "          showEnts: False",
                "          occludes: True",
                "          ent: null",
            ].join("\n"),
        );
        expect(entityText(text, 20)).toBe(["  - uid: 20", "    components:", "    - type: Transform", "      parent: 10", "    - type: Physics", "      canCollide: False", "    - type: InsideEntityStorage"].join("\n"));
        expect(doc.containerOf(20)).toEqual({ owner: 10, id: "entity_storage", kind: "Container", index: 0 });
        expect(doc.descendants(10)).toEqual([20]);
        // the scene hears of both: the item is hidden, the locker holds it
        expect(changes.at(-1)).toEqual(expect.arrayContaining([10, 20]));

        // out where it was: the file as it was, the emptied container override gone with it
        doc.removeFromContainer(20, { grid: 1, x: 20.5, y: 0.5 }, PACK);
        expect(timeless(doc.serialize(NOW))).toBe(timeless(SMALL));
        expect(doc.containerOf(20)).toBeNull();
        expect(doc.descendants(10)).toEqual([]);
        expect(doc.transform(20)).toEqual({ x: 20.5, y: 0.5, rotation: 0, parent: 1 });
        expect(changes.at(-1)).toEqual(expect.arrayContaining([10, 20]));
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
        doc.redo();
        expect(doc.containerOf(20)?.owner).toBe(10);
        expect(doc.descendants(10)).toEqual([20]);
    });

    it("makes a new entity of a prototype inside, and takes it out with a rotation", () => {
        const doc = new MapDocument(SMALL);
        const uid = doc.insertIntoContainer(10, "entity_storage", { proto: "Crowbar" }, { pack: { ...PACK, insideStorageField: true } });
        expect(uid).toBe(51);
        let text = doc.serialize(NOW);
        expect(text).toContain("  entityCount: 10\n");
        expect(entityText(text, 51)).toBe(["  - uid: 51", "    components:", "    - type: Transform", "      parent: 10", "    - type: Physics", "      canCollide: False", "    - type: InsideEntityStorage", "      storage: 10"].join("\n"));
        doc.removeFromContainer(51, { grid: 1, x: 3, y: 4, rotation: Math.PI / 2 }, PACK);
        text = doc.serialize(NOW);
        expect(entityText(text, 51)).toBe(["  - uid: 51", "    components:", "    - type: Transform", "      rot: 1.5707963267948966 rad", "      pos: 3,4", "      parent: 1"].join("\n"));
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it("refuses what the game refuses", () => {
        const doc = new MapDocument(SMALL);
        doc.insertIntoContainer(10, "entity_storage", 20, { pack: PACK });
        doc.insertIntoContainer(10, "entity_storage", 21, { pack: PACK });
        expect(doc.canInsert(10, "entity_storage", 22, { pack: PACK })).toEqual({ ok: false, reason: "Locker is full (2)" });
        expect(() => doc.insertIntoContainer(10, "entity_storage", 22, { pack: PACK })).toThrow("Locker is full (2)");
        expect(doc.canInsert(11, "entity_storage", 22, { pack: PACK })).toEqual({ ok: false, reason: "Locker is open" });
        expect(doc.canInsert(10, "nothing", 22, { pack: PACK }).ok).toBe(false);
        expect(doc.canInsert(10, "entity_storage", 1, { pack: PACK }).ok).toBe(false);
        expect(doc.canInsert(10, "entity_storage", 10, { pack: PACK }).ok).toBe(false);
        expect(doc.canInsert(10, "entity_storage", 20, { pack: PACK })).toEqual({ ok: false, reason: "Already in entity_storage" });
        expect(doc.canInsert(10, "entity_storage", { proto: "NoSuchThing" }, { pack: PACK }).ok).toBe(false);
        // the whitelist comes from the caller
        const allow = (proto: string) => proto === "Crowbar" || "Only crowbars";
        expect(doc.canInsert(40, "cell_slot", 30, { pack: PACK, allow })).toEqual({ ok: false, reason: "Only crowbars" });
        expect(doc.canInsert(40, "cell_slot", 22, { pack: PACK, allow }).ok).toBe(true);
        // a slot holds one
        doc.insertIntoContainer(40, "cell_slot", 22, { pack: PACK });
        expect(doc.canInsert(40, "cell_slot", { proto: "Crowbar" }, { pack: PACK })).toEqual({ ok: false, reason: "cell_slot is taken" });
        // nothing goes inside what it holds
        doc.insertIntoContainer(30, "storagebase", 40, { pack: PACK, location: { x: 0, y: 0, rotation: "South" } });
        expect(doc.canInsert(40, "cell_slot", 30, { pack: PACK })).toEqual({ ok: false, reason: "An entity cannot go inside itself" });
        expect(() => doc.removeFromContainer(40, { grid: 22, x: 0, y: 0 }, PACK)).toThrow("inside itself");
        expect(() => doc.removeFromContainer(50, { grid: 1, x: 0, y: 0 }, PACK)).toThrow("not in a container");
        expect(() => doc.insertIntoContainer(30, "storagebase", 50, { pack: PACK })).toThrow("A place in the storage grid is needed");
        // nothing was written by the refusals
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it("fills a slot and empties it as the map writes empty slots", () => {
        const doc = new MapDocument(SMALL);
        doc.insertIntoContainer(40, "cell_slot", 22, { pack: PACK });
        let text = doc.serialize(NOW);
        expect(componentText(entityText(text, 40), "ContainerContainer")).toBe(["    - type: ContainerContainer", "      containers:", "        cell_slot: !type:ContainerSlot", "          showEnts: False", "          occludes: True", "          ent: 22"].join("\n"));
        expect(entityText(text, 22)).toBe(["  - uid: 22", "    components:", "    - type: Transform", "      parent: 40", "    - type: Physics", "      canCollide: False"].join("\n"));
        doc.removeFromContainer(22, "delete", PACK);
        text = doc.serialize(NOW);
        expect(text).not.toContain("ContainerContainer");
        expect(text).toContain("  entityCount: 8\n");
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it("keeps Storage places, finds free ones, and moves between containers in one step", () => {
        const doc = new MapDocument(SMALL);
        const geometry = { grid: [parseBox("0,0,3,1")], shape: [parseBox("0,0,1,0")], shapeOf: () => [parseBox("0,0,1,0")] };
        expect(doc.storageSpot(30, geometry)).toEqual({ x: 0, y: 0, rotation: "South" });
        doc.insertIntoContainer(30, "storagebase", 20, { pack: PACK, geometry });
        doc.insertIntoContainer(30, "storagebase", 21, { pack: PACK, geometry });
        doc.insertIntoContainer(30, "storagebase", { proto: "Crowbar" }, { pack: PACK, location: { x: 0, y: 1, rotation: "South" } });
        expect(doc.canInsert(30, "storagebase", 22, { pack: PACK, geometry })).toEqual({ ok: true });
        expect(doc.canInsert(30, "storagebase", 22, { pack: PACK, geometry, location: { x: 0, y: 1, rotation: "South" } })).toEqual({ ok: false, reason: "It does not fit there" });
        let text = doc.serialize(NOW);
        expect(entityText(text, 30)).toBe(
            [
                "  - uid: 30",
                "    components:",
                "    - type: Transform",
                "      pos: 30.5,0.5",
                "      parent: 1",
                "    - type: Storage",
                "      storedItems:",
                "        20:",
                "          position: 0,0",
                "          _rotation: South",
                "        21:",
                "          position: 2,0",
                "          _rotation: South",
                "        51:",
                "          position: 0,1",
                "          _rotation: South",
                "    - type: ContainerContainer",
                "      containers:",
                "        storagebase: !type:Container",
                "          showEnts: False",
                "          occludes: True",
                "          ents:",
                "          - 20",
                "          - 21",
                "          - 51",
            ].join("\n"),
        );
        // a bag item has no InsideEntityStorage
        expect(entityText(text, 21)).toBe(["  - uid: 21", "    components:", "    - type: Transform", "      parent: 30", "    - type: Physics", "      canCollide: False"].join("\n"));

        // into the locker: out of the bag's list and places, in with InsideEntityStorage, one undo step
        const steps = () => {
            let n = 0;
            while (doc.canUndo) {
                doc.undo();
                n++;
            }
            while (doc.canRedo) doc.redo();
            return n;
        };
        const before = steps();
        doc.moveToContainer(21, 10, "entity_storage", { pack: PACK });
        expect(steps()).toBe(before + 1);
        text = doc.serialize(NOW);
        expect(entityText(text, 30)).not.toContain("21");
        expect(entityText(text, 21)).toContain("    - type: InsideEntityStorage");
        // back to the bag at another place
        doc.moveToContainer(21, 30, "storagebase", { pack: PACK, location: { x: 2, y: 1, rotation: "South" } });
        expect(entityText(doc.serialize(NOW), 30)).toContain("        21:\n          position: 2,1\n          _rotation: South");
        // within the bag: a new place keeps the entry's slot (a Dictionary updated in place)
        doc.moveToContainer(20, 30, "storagebase", { pack: PACK, location: { x: 2, y: 0, rotation: "South" }, index: 2 });
        text = doc.serialize(NOW);
        expect(entityText(text, 30)).toContain("        20:\n          position: 2,0\n          _rotation: South\n        21:");
        expect(entityText(text, 30)).toContain("          ents:\n          - 51\n          - 21\n          - 20");

        // emptied, the bag writes neither its places nor its containers
        for (const uid of [20, 21, 51]) doc.removeFromContainer(uid, { grid: 1, x: uid + 0.5, y: 0.5 }, PACK);
        expect(entityText(doc.serialize(NOW), 30)).toBe(entityText(SMALL, 30));
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it("stores containers inside containers", () => {
        const doc = new MapDocument(SMALL);
        doc.insertIntoContainer(30, "storagebase", 20, { pack: PACK, location: { x: 0, y: 0, rotation: "South" } });
        doc.insertIntoContainer(10, "entity_storage", 30, { pack: PACK });
        expect(doc.descendants(10).sort()).toEqual([20, 30]);
        expect(doc.containerOf(30)).toMatchObject({ owner: 10, id: "entity_storage" });
        expect(doc.containerOf(20)).toMatchObject({ owner: 30, id: "storagebase" });
        // out of the locker, the bag keeps its contents
        doc.removeFromContainer(30, { grid: 1, x: 30.5, y: 0.5 }, PACK);
        expect(doc.containerOf(20)).toMatchObject({ owner: 30 });
        expect(entityText(doc.serialize(NOW), 30)).not.toContain("InsideEntityStorage");
        // deleting the bag from the locker deletes what it holds
        doc.insertIntoContainer(10, "entity_storage", 30, { pack: PACK });
        doc.removeFromContainer(30, "delete", PACK);
        expect(doc.uids()).not.toContain(20);
        expect(entityText(doc.serialize(NOW), 10)).toBe(entityText(SMALL, 10));
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
        expect(doc.descendants(10)).toEqual([]);
        expect(doc.transform(20).parent).toBe(1);
    });

    it("works from the map alone without prototype data", () => {
        const doc = new MapDocument(SMALL);
        // no override and no prototype data: no containers known
        expect(doc.containers(10)).toEqual([]);
        doc.insertIntoContainer(10, "entity_storage", 20, { pack: PACK });
        expect(doc.containers(10).map((c) => [c.id, c.role])).toEqual([
            ["entity_storage", "entityStorage"],
            ["paper_label", "itemSlot"],
        ]);
        doc.insertIntoContainer(10, "entity_storage", 21);
        doc.removeFromContainer(21, { grid: 1, x: 21.5, y: 0.5 });
        // without prototype data the emptied override cannot be known to equal the prototype's
        doc.removeFromContainer(20, { grid: 1, x: 20.5, y: 0.5 });
        expect(entityText(doc.serialize(NOW), 10)).toContain("          ents: []\n");
    });
});

describe("storage grids", () => {
    const box = (s: string): Box => parseBox(s);
    it("turns item shapes around their bounds as the game does", () => {
        expect(placedShape([box("0,0,1,0")], { x: 0, y: 0, rotation: "South" })).toEqual([[0, 0, 1, 0]]);
        expect(placedShape([box("0,0,1,0")], { x: 2, y: 1, rotation: "East" })).toEqual([[2, 1, 2, 2]]);
        expect(placedShape([box("0,0,2,0"), box("1,1,1,1")], { x: 0, y: 0, rotation: "North" })).toEqual([[0, 1, 2, 1], [1, 0, 1, 0]]);
        expect(() => parseBox("1,2,3")).toThrow();
    });

    it("finds the first free place row by row, turning oblong items", () => {
        const grid = [box("0,0,3,1")];
        const long = [box("0,0,1,0")];
        expect(findStorageSpot(grid, long)).toEqual({ x: 0, y: 0, rotation: "South" });
        const row = [
            { shape: long, location: { x: 0, y: 0, rotation: "South" as const } },
            { shape: long, location: { x: 2, y: 0, rotation: "South" as const } },
        ];
        expect(findStorageSpot(grid, long, row)).toEqual({ x: 0, y: 1, rotation: "South" });
        // a 2×1 item fits a 1×2 grid only turned, and nothing fits a full one
        expect(findStorageSpot([box("0,0,0,1")], long)).toEqual({ x: 0, y: 0, rotation: "East" });
        expect(findStorageSpot(grid, [box("0,0,3,1")], row)).toBeNull();
        expect(fitsInStorage(grid, row, long, { x: 1, y: 1, rotation: "South" })).toBe(true);
        expect(fitsInStorage(grid, row, long, { x: 3, y: 1, rotation: "South" })).toBe(false);
        expect(fitsInStorage(grid, row, long, { x: 1, y: 0, rotation: "East" })).toBe(false);
        // a grid wider than a chunk is searched chunk column by chunk column
        expect(findStorageSpot([box("0,0,9,1")], [box("0,0,0,0")], [{ shape: [box("0,0,7,1")], location: { x: 0, y: 0, rotation: "South" } }])).toEqual({ x: 8, y: 0, rotation: "South" });
    });
});

// ---------------------------------------------------------------------------------------------
// Corpus

/** Stored entities of a map: [item, owner, container id, index]. */
function storedItems(doc: MapDocument): Array<[number, number, string, number]> {
    const out: Array<[number, number, string, number]> = [];
    for (const uid of doc.uids()) {
        const place = doc.containerOf(uid);
        if (place) out.push([uid, place.owner, place.id, place.index]);
    }
    return out;
}

/**
 * Takes out every stored entity (up to `limit`) and puts it back at its index: the file must come back byte for
 * byte. Containers the game fills itself (machine parts, actions, solutions...) refuse; the others must not.
 */
async function roundTrips(file: string, limit = Infinity): Promise<{ tried: number; refused: number }> {
    const fork = file.split("/")[0]!;
    const pack = await packData(fork);
    const source = read(file);
    const doc = new MapDocument(source);
    const grid = doc.listedGrids()[0] ?? doc.uids()[0]!;
    let tried = 0, refused = 0;
    const bad: string[] = [];
    for (const [uid, owner, id, index] of storedItems(doc).slice(0, limit)) {
        try {
            doc.batch("Round trip", () => {
                doc.removeFromContainer(uid, { grid, x: 0.5, y: 0.5 }, pack);
                doc.insertIntoContainer(owner, id, uid, { pack, index });
            });
        } catch (e) {
            const message = (e as Error).message;
            if (!/is filled by the game$/.test(message)) bad.push(`${uid} in ${owner}/${id}: ${message}`);
            refused++;
            continue;
        }
        tried++;
        if (timeless(doc.serialize(NOW)) !== timeless(source)) bad.push(`${uid} in ${owner}/${id}`);
        doc.undo();
    }
    expect(bad, file).toEqual([]);
    expect(doc.serialize(NOW)).toBe(source);
    return { tried, refused };
}

describe("corpus round trips", () => {
    const MAPS = [
        "upstream/Resources/Maps/box.yml", // lockers, slots
        "upstream/Resources/Maps/centcomm.yml", // Storage with storedItems
        "upstream/Resources/Maps/Shuttles/emergency_gear.yml", // saved before InsideEntityStorage was written
        "upstream/Resources/Maps/Ruins/displaced_telescience.yml", // InsideEntityStorage.storage
        "upstream/Resources/Maps/marathon.yml", // InsideEntityStorage on some lockers only
        "frontier/Resources/Maps/Nonstations/wizardsden.yml",
        "frontier/Resources/Maps/Dungeon/haunted.yml", // keys in name order (old saves)
        "frontier/Resources/Maps/Shuttles/emergency_meta.yml", // storagebase without storedItems
        "goob/Resources/Maps/.amber.yml",
        "goob/Resources/Maps/_Goobstation/Shuttles/consul.yml", // InsideEntityStorage left on a bag's item
        "goob/Resources/Maps/_Goobstation/Shuttles/ShuttleEvent/alien_tourist.yml", // Physics with damping
    ];
    for (const file of MAPS) {
        it.skipIf(!has(file))(`takes out and puts back every stored entity of ${file}`, async () => {
            const { tried } = await roundTrips(file);
            expect(tried).toBeGreaterThan(0);
        });
    }

    // every map of the corpus, some entities of each (slow: SS14MAPPER_ALL_MAPS=1)
    it.runIf(!!process.env.SS14MAPPER_ALL_MAPS)("takes out and puts back stored entities on every map", async () => {
        let tried = 0, refused = 0;
        for (const { file } of corpusFiles() as Array<{ fork: string; file: string }>) {
            const r = await roundTrips(path.relative(root, file), Number(process.env.SS14MAPPER_ALL_MAPS) || 25);
            tried += r.tried;
            refused += r.refused;
        }
        console.log(`round trips: ${tried}, refused (the game's own containers): ${refused}`);
    });

    it.skipIf(!has("upstream/Resources/Maps/centcomm.yml"))("keeps a bag's storedItems places through take out and put back", async () => {
        const pack = await packData("upstream");
        const source = read("upstream/Resources/Maps/centcomm.yml");
        const doc = new MapDocument(source);
        // centcomm.yml:3841, a box in a locker: items 4617-4620 and 4656 at 0,0 1,0 3,0 2,0 4,0
        for (const uid of [4619, 4617, 4656]) doc.removeFromContainer(uid, { grid: 1668, x: 0.5, y: 0.5 }, pack);
        expect(entityText(doc.serialize(NOW), 4560)).not.toContain("4617:");
        for (const [uid, index] of [[4656, 2], [4617, 0], [4619, 2]] as const) doc.insertIntoContainer(4560, "storagebase", uid, { pack, index });
        expect(timeless(doc.serialize(NOW))).toBe(timeless(source));
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe("writing new contents like the game", () => {
    // [map, a stored entity the game wrote there (else the map's most common form), whether the fork's
    // InsideEntityStorage.storage is written (from the pack) or the map's habit followed]
    const CASES: Array<[string, number | null, boolean]> = [
        ["upstream/Resources/Maps/Ruins/displaced_telescience.yml", 478, true], // storage: put in in-session
        ["upstream/Resources/Maps/box.yml", 26298, false], // box.yml:135557, as loaded
        ["frontier/Resources/Maps/box.yml", null, true], // Frontier never writes storage
        ["frontier/Resources/Maps/amber.yml", null, true],
        ["goob/Resources/Maps/_DV/shoukou.yml", 4853, true],
        ["goob/Resources/Maps/.amber.yml", 20660, false],
    ];
    for (const [file, example, fromPack] of CASES) {
        it.skipIf(!has(file))(`puts a crowbar into a plain locker of ${file}`, async () => {
            const fork = file.split("/")[0]!;
            const full = await packData(fork);
            const pack = fromPack ? full : { ...full, insideStorageField: undefined };
            const source = read(file);
            const doc = new MapDocument(source);
            const locker = doc.uids().find((u) => /^(Locker|Closet)/.test(doc.proto(u) ?? "") && !/Filled/.test(doc.proto(u)!) && doc.containers(u, pack).some((c) => c.role === "entityStorage") && !doc.components(u).some((c) => c.type === "ContainerContainer") && doc.canInsert(u, "entity_storage", { proto: "Crowbar" }, { pack }).ok);
            expect(locker).toBeDefined();
            const uid = doc.insertIntoContainer(locker!, "entity_storage", { proto: "Crowbar" }, { pack });
            const text = doc.serialize(NOW);
            const form = (s: string) => s.replace(/\b\d+\b/g, "#");
            const forms = new Map<string, number>();
            for (const [item, , id] of storedItems(new MapDocument(source))) {
                if (id !== "entity_storage") continue;
                const f = form(entityText(source, item));
                forms.set(f, (forms.get(f) ?? 0) + 1);
            }
            const expected = example !== null ? form(entityText(source, example)) : [...forms].sort((a, b) => b[1] - a[1])[0]![0];
            expect(forms.has(expected)).toBe(true);
            expect(form(entityText(text, uid))).toBe(expected);
            // the locker's containers as the map writes those of lockers holding something (lists cut to one uid)
            const containersForm = (c: string) => form(c).replace(/(ents:\n)( {10}- #(\n|$))+/g, "$1          - #\n").trimEnd();
            const lockerForms = new Set<string>();
            for (const u of new MapDocument(source).uids()) {
                const c = containersForm(componentText(entityText(source, u), "ContainerContainer"));
                if (c.includes("entity_storage: !type:Container") && c.includes("ents:\n          - #")) lockerForms.add(c);
            }
            expect([...lockerForms]).toContain(containersForm(componentText(entityText(text, locker!), "ContainerContainer")));
            undoAll(doc);
            expect(doc.serialize(NOW)).toBe(source);
        });
    }
});

describe("changing the prototype", () => {
    it("moves the entity's item to the group of the new prototype, where the game lists it", () => {
        const doc = new MapDocument(SMALL);
        const groupOf = (text: string, uid: number) => {
            const lines = text.split("\n");
            const at = lines.indexOf(`  - uid: ${uid}`);
            for (let i = at; i >= 0; i--) if (lines[i]!.startsWith("- proto: ")) return lines[i]!.slice("- proto: ".length);
            return null;
        };
        doc.insertIntoContainer(10, "entity_storage", 20, { pack: PACK });
        // a new group, after "Locker" in name order
        doc.changePrototype(10, "LockerFilled");
        let text = doc.serialize(NOW);
        expect(doc.proto(10)).toBe("LockerFilled");
        expect(groupOf(text, 10)).toBe("LockerFilled");
        expect(text).toContain("- proto: Locker\n  entities:\n  - uid: 11\n");
        expect(text.indexOf("- proto: LockerFilled")).toBeGreaterThan(text.indexOf("- proto: Locker\n"));
        expect(text.indexOf("- proto: Crowbar")).toBeLessThan(text.indexOf("- proto: Locker\n"));
        // uid, components and contents stay
        expect(entityText(text, 10)).toBe(entityText(doc.serialize(NOW), 10));
        expect(entityText(text, 10)).toContain("          - 20");
        expect(doc.containerOf(20)?.owner).toBe(10);
        expect(text).toContain("  entityCount: 9\n");
        // into an existing group, by uid; the emptied group goes
        doc.changePrototype(11, "LockerFilled");
        text = doc.serialize(NOW);
        expect(text).not.toContain("- proto: Locker\n");
        expect(text).toContain("- proto: LockerFilled\n  entities:\n  - uid: 10\n");
        expect(text.indexOf("  - uid: 11\n")).toBeGreaterThan(text.indexOf("  - uid: 10\n"));
        doc.changePrototype(10, "Crowbar");
        text = doc.serialize(NOW);
        expect(text).toContain("- proto: Crowbar\n  entities:\n  - uid: 10\n");
        expect(text.indexOf("  - uid: 20\n")).toBeGreaterThan(text.indexOf("  - uid: 10\n"));
        // the same prototype changes nothing; grids cannot
        doc.changePrototype(10, "Crowbar");
        expect(() => doc.changePrototype(1, "Crowbar")).toThrow();
        const changed = doc.serialize(NOW);

        // undo: byte for byte, and the document keeps working on the restored records
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
        expect(doc.proto(10)).toBe("Locker");
        expect(doc.proto(11)).toBe("Locker");
        expect(doc.containers(10, PACK).map((c) => c.id)).toEqual(["entity_storage", "paper_label"]);
        while (doc.canRedo) doc.redo();
        expect(doc.serialize(NOW)).toBe(changed);
        expect(doc.proto(10)).toBe("Crowbar");
        expect(doc.containerOf(20)?.owner).toBe(10);
        undoAll(doc);
        doc.insertIntoContainer(10, "entity_storage", { proto: "Crowbar" }, { pack: PACK });
        doc.deleteEntity(10);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(SMALL);
    });

    it.skipIf(!has("upstream/Resources/Maps/box.yml"))("swaps a Filled locker of box.yml for its plain base and back", async () => {
        const pack = await packData("upstream");
        const full = packFor("upstream")!;
        const source = read("upstream/Resources/Maps/box.yml");
        const doc = new MapDocument(source);
        const filled = doc.uids().filter((u) => full.prototypes.entities[doc.proto(u) ?? ""]?.plainBase);
        expect(filled.length).toBeGreaterThan(10);
        for (const uid of filled.slice(0, 40)) {
            const base = full.prototypes.entities[doc.proto(uid)!]!.plainBase!;
            const before = entityText(doc.serialize(NOW), uid);
            doc.changePrototype(uid, base);
            expect(doc.proto(uid)).toBe(base);
            expect(entityText(doc.serialize(NOW), uid)).toBe(before);
            if (doc.canInsert(uid, "entity_storage", { proto: "Crowbar" }, { pack }).ok) doc.insertIntoContainer(uid, "entity_storage", { proto: "Crowbar" }, { pack });
        }
        expect(new MapDocument(doc.serialize(NOW)).uids().length).toBe(doc.uids().length);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});
