// References to deleted entities: container contents, uid fields of other components, docking joints. They are
// removed from the entities left in the same undo step, in the form the game saves.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";

const root: string = corpusRoot();
const NOW = new Date(2026, 10, 14, 12, 0, 0);
const BOX = path.join(root, "upstream/Resources/Maps/box.yml");

function undoAll(doc: MapDocument): void {
    while (doc.canUndo) doc.undo();
}

/** A map of a grid (uid 1) and entities given as [uid, parent, component lines]. */
function mapOf(entities: Array<[number, number, string]>, extra = ""): string {
    const lines = ["meta:", "  format: 7", "  entityCount: 0", "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
    if (extra) lines.push(...extra.split("\n"));
    lines.push("- proto: Thing", "  entities:");
    for (const [uid, parent, components] of entities) {
        lines.push(`  - uid: ${uid}`, "    components:", "    - type: Transform", `      parent: ${parent}`, ...components.split("\n").filter(Boolean).map((l) => "    " + l));
    }
    return lines.join("\n") + "\n...\n";
}

const LOCKER = [
    "- type: ContainerContainer",
    "  containers:",
    "    entity_storage: !type:Container",
    "      ents:",
    "      - 31",
    "      - 32",
    "      showEnts: False",
    "      occludes: True",
    "    paper_label: !type:ContainerSlot",
    "      ent: 33",
    "      showEnts: False",
    "      occludes: True",
].join("\n");

const LOCKER_MAP = mapOf([
    [30, 1, LOCKER],
    [31, 30, ""],
    [32, 30, ""],
    [33, 30, ""],
    [34, 1, ""],
]);

describe("container contents", () => {
    it("removes a deleted item from the container that holds it", () => {
        const doc = new MapDocument(LOCKER_MAP);
        doc.deleteEntity(31);
        const text = doc.serialize(NOW);
        expect(text).toContain("          ents:\n          - 32\n          showEnts: False");
        expect(text).toContain("          ent: 33\n");
        doc.deleteEntity(32);
        expect(doc.serialize(NOW)).toContain("          ents: []\n          showEnts: False\n          occludes: True");
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(LOCKER_MAP.replace("entityCount: 0", "entityCount: 0"));
    });

    it("writes an emptied slot as null", () => {
        const doc = new MapDocument(LOCKER_MAP);
        doc.deleteEntity(33);
        expect(doc.serialize(NOW)).toContain("        paper_label: !type:ContainerSlot\n          ent: null\n          showEnts: False");
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(LOCKER_MAP);
        doc.redo();
        expect(doc.serialize(NOW)).toContain("ent: null");
    });

    it("leaves the field out in a map that writes empty containers without it", () => {
        const bare = [
            "- type: ContainerContainer",
            "  containers:",
            "    stash: !type:ContainerSlot",
            "      showEnts: False",
            "      occludes: True",
            "    bin: !type:Container",
            "      showEnts: False",
            "      occludes: True",
        ].join("\n");
        const text = mapOf([[30, 1, LOCKER], [31, 30, ""], [32, 30, ""], [33, 30, ""], [35, 1, bare]]);
        const doc = new MapDocument(text);
        doc.deleteEntity(33);
        doc.deleteEntity(31);
        doc.deleteEntity(32);
        const out = doc.serialize(NOW);
        expect(out).toContain("        paper_label: !type:ContainerSlot\n          showEnts: False");
        expect(out).toContain("        entity_storage: !type:Container\n          showEnts: False");
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(text);
    });

    it("deletes a container with its contents without touching them", () => {
        const doc = new MapDocument(LOCKER_MAP);
        expect(doc.deleteEntity(30).sort()).toEqual([30, 31, 32, 33]);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(LOCKER_MAP);
    });
});

describe("other uid fields", () => {
    const text = mapOf([
        [40, 1, "- type: Storage\n  storedItems:\n    41:\n      position: 0,0\n      rotation: 0\n    42:\n      position: 1,0\n      rotation: 0\n  grid:\n  - 0,0,1,1"],
        [41, 40, ""],
        [42, 40, ""],
        [43, 1, "- type: HandheldLight\n  toggleActionEntity: 44\n- type: Action\n  container: 44"],
        [44, 1, "- type: Action\n  attachedEntity: 43\n  container: 43\n  icon: x"],
    ]);

    it("removes storedItems entries, and an emptied one is left out", () => {
        const doc = new MapDocument(text);
        doc.deleteEntity(41);
        expect(doc.serialize(NOW)).not.toContain("    41:");
        expect(doc.serialize(NOW)).toContain("    42:");
        doc.deleteEntity(42);
        expect(doc.serialize(NOW)).toContain("- type: Storage\n      grid:");
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(text);
    });

    it("clears single uid fields and drops components left with none", () => {
        const doc = new MapDocument(text);
        doc.deleteEntity(44);
        expect(doc.components(43).map((c) => c.type)).toEqual(["Transform"]);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(text);
        const other = new MapDocument(text);
        other.deleteEntity(43);
        expect(other.components(44).find((c) => c.type === "Action")?.text).toBe("icon: x");
        undoAll(other);
        expect(other.serialize(NOW)).toBe(text);
    });
});

describe("docking", () => {
    // two grids (1 and 2) docked by ports 50 and 51; the joint is on both grids
    const joint = [
        "- type: Joint",
        "  joints:",
        "    docking7: !type:WeldJoint",
        "      id: docking7",
        "      bodyB: 2",
        "      bodyA: 1",
    ].join("\n");
    const lines = (grid: number) => `  - uid: ${grid}\n    components:\n    - type: Transform\n      parent: invalid\n    - type: MapGrid\n      chunks: {}\n${joint.split("\n").map((l) => "    " + l).join("\n")}\n`;
    const text = [
        "meta:", "  format: 7", "  entityCount: 0", "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:",
        lines(1).trimEnd(), lines(2).trimEnd(),
        "- proto: Airlock", "  entities:",
        "  - uid: 50", "    components:", "    - type: Transform", "      parent: 1", "    - type: Docking", "      dockJointId: docking7", "      dockedWith: 51",
        "  - uid: 51", "    components:", "    - type: Transform", "      parent: 2", "    - type: Docking", "      dockJointId: docking7", "      dockedWith: 50",
    ].join("\n") + "\n...\n";

    it("undocks the partner and removes the joint from both grids", () => {
        const doc = new MapDocument(text);
        doc.deleteEntity(50);
        expect(doc.components(51).map((c) => c.type)).toEqual(["Transform"]);
        expect(doc.components(1).map((c) => c.type)).not.toContain("Joint");
        expect(doc.components(2).map((c) => c.type)).not.toContain("Joint");
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(text);
    });

    it("removes the joints of a deleted grid from the other grid", () => {
        const doc = new MapDocument(text);
        doc.deleteEntity(2);
        expect(doc.components(1).map((c) => c.type)).not.toContain("Joint");
        expect(doc.components(50).find((c) => c.type === "Docking")).toBeUndefined();
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(text);
    });
});

describe.skipIf(!fs.existsSync(BOX))("box", () => {
    const source = fs.existsSync(BOX) ? fs.readFileSync(BOX, "utf8") : "";

    it("deleting contents of surviving containers leaves no stale uid, and undoes byte for byte", () => {
        const doc = new MapDocument(source);
        // uids listed in `ents:` of a container
        const items = [...source.matchAll(/^ +ents:\n((?: +- \d+\n)+)/gm)].flatMap((m) => [...m[1]!.matchAll(/\d+/g)].map((n) => Number(n[0])));
        expect(items.length).toBeGreaterThan(20);
        const before = doc.serialize(NOW);
        for (const item of items) {
            const parent = doc.transform(item).parent!;
            doc.deleteEntity(item);
            expect(doc.components(parent).find((c) => c.type === "ContainerContainer")?.text).not.toMatch(new RegExp(`(^|\\s|- )${item}\\s*$`, "m"));
        }
        const after = doc.serialize(NOW);
        expect(after).not.toBe(before);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(before);
    });

    it("deletes every entity in the same order of time as before", () => {
        const doc = new MapDocument(source);
        const before = doc.serialize(NOW);
        const grid = doc.grids().reduce((a, b) => (doc.descendants(b).length > doc.descendants(a).length ? b : a));
        const start = performance.now();
        const removed = doc.deleteEntity(grid);
        const ms = performance.now() - start;
        expect(removed.length).toBeGreaterThan(10000);
        expect(ms).toBeLessThan(5000);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(before);
    });
});
