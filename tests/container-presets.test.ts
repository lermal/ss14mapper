// Contents presets: the model and its storage, presets read from a container, and applied to others through the
// game's checks as one undo step.
import { describe, expect, it } from "vitest";
import { Contents } from "../src/editor/contents";
import { ContainerRulesEngine } from "../src/map/container-rules";
import { MapDocument } from "../src/map/document";
import type { ContainerRules, PrototypeData } from "../src/pack/format";
import { applyPreset, countItems, describeItems, loadPresets, parsePresets, presetItems, Presets, presetsKey, savePresets, type PresetItem } from "../src/ui/container-presets";

const NOW = new Date(2026, 10, 14, 12, 0, 0);

const RULES: ContainerRules = {
    itemSizes: {
        Tiny: { weight: 1, shape: ["0,0,0,0"] },
        Small: { weight: 2, shape: ["0,0,0,1"] },
        Normal: { weight: 4, shape: ["0,0,1,1"] },
        Large: { weight: 8, shape: ["0,0,3,1"] },
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
        Pen: { parents: ["BaseItem"], components: { Item: { size: "Tiny" } } },
        Toolbox: { parents: ["BaseItem"], components: { Item: { size: "Normal" }, Storage: { grid: ["0,0,3,1"] }, ContainerContainer: { containers: { storagebase: { "!type": "Container", ents: [] } } } } },
        Locker: { components: { EntityStorage: { capacity: 4 }, Physics: { bodyType: "Static" }, ContainerContainer: { containers: { entity_storage: null } } } },
        LockerFilled: { parents: ["Locker"], components: { EntityTableContainerFill: {} } },
        Table: { components: { Physics: { bodyType: "Static" } } },
    },
};

const kit = { pack: { data: DATA }, rules: new ContainerRulesEngine({ data: DATA, rules: RULES, entities: { LockerFilled: { fills: true, plainBase: "Locker" } } }) };

function mapOf(entities: Array<[number, string]>): string {
    const lines = ["meta:", "  format: 7", "  entityCount: " + (entities.length + 1), "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
    const byProto = new Map<string, number[]>();
    for (const [uid, proto] of entities) byProto.set(proto, [...(byProto.get(proto) ?? []), uid]);
    for (const [proto, list] of [...byProto].sort()) {
        lines.push(`- proto: ${proto}`, "  entities:");
        for (const uid of list) lines.push(`  - uid: ${uid}`, "    components:", "    - type: Transform", `      pos: ${uid}.5,0.5`, "      parent: 1");
    }
    return lines.join("\n") + "\n...\n";
}

const SMALL = mapOf([
    [10, "Locker"],
    [11, "Locker"],
    [12, "LockerFilled"],
    [20, "Table"],
]);

describe("presets", () => {
    it("adds, renames, deletes and brings back presets", () => {
        const p = new Presets();
        const items: PresetItem[] = [{ proto: "Crowbar", count: 2 }];
        expect(p.add("Engi kit", items)).toBe(true);
        expect(p.add("Engi kit", items)).toBe(false);
        expect(p.add("Empty", [])).toBe(false);
        expect(p.nameError(" ")).toBe("Enter a name");
        expect(p.nameError("Engi kit")).toBe("Name already exists");
        expect(p.nameError("Engi kit", "Engi kit")).toBeNull();
        // a copy is kept: later changes to the list do not reach it
        items[0]!.count = 5;
        expect(p.get("Engi kit")!.items).toEqual([{ proto: "Crowbar", count: 2 }]);
        p.add("Med kit", [{ proto: "Pen", count: 1 }]);
        expect(p.rename("Engi kit", "Med kit")).toBe(false);
        expect(p.rename("Engi kit", "Tools")).toBe(true);
        expect(p.names).toEqual(["Tools", "Med kit"]);
        const snap = p.remove("Tools")!;
        expect(p.names).toEqual(["Med kit"]);
        expect(p.restore(snap)).toBe(true);
        expect(p.names).toEqual(["Tools", "Med kit"]);
        expect(p.remove("Nothing")).toBeNull();
    });

    it("stores presets per build and drops bad entries when reading", () => {
        const store = new Map<string, string>();
        const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
        const p = new Presets();
        p.add("Kit", [{ proto: "Toolbox", count: 1, contents: { storagebase: [{ proto: "Crowbar", count: 2 }] } }]);
        expect(savePresets("upstream", p, storage)).toBe(true);
        expect(JSON.parse(store.get(presetsKey("upstream"))!)).toEqual({ version: 1, presets: [{ name: "Kit", items: [{ proto: "Toolbox", count: 1, contents: { storagebase: [{ proto: "Crowbar", count: 2 }] } }] }] });
        expect(loadPresets("upstream", storage).get("Kit")!.items[0]!.contents!.storagebase).toEqual([{ proto: "Crowbar", count: 2 }]);
        expect(loadPresets("goob", storage).names).toEqual([]);
        expect(loadPresets("upstream", { getItem: () => { throw new Error("denied"); } }).names).toEqual([]);
        expect(savePresets("upstream", p, { setItem: () => { throw new Error("full"); } })).toBe(false);
        expect(parsePresets("not json")).toBeNull();
        expect(parsePresets('{"version":2,"presets":[]}')).toBeNull();
        const file = parsePresets(JSON.stringify({ version: 1, presets: [{ name: "A", items: [{ proto: "Pen", count: 3.7 }, { proto: "" }, { count: 2 }, { proto: "Box", count: -1, contents: { storagebase: "x", other: [{ proto: "Pen" }] } }] }, { name: " ", items: [{ proto: "Pen" }] }, { name: "Empty", items: [] }] }));
        expect(file).toEqual({ version: 1, presets: [{ name: "A", items: [{ proto: "Pen", count: 3 }, { proto: "Box", count: 1, contents: { other: [{ proto: "Pen", count: 1 }] } }] }] });
    });

    it("counts and describes what a preset makes", () => {
        const items: PresetItem[] = [{ proto: "Crowbar", count: 3 }, { proto: "Toolbox", count: 2, contents: { storagebase: [{ proto: "Pen", count: 2 }] } }];
        expect(countItems(items)).toBe(3 + 2 * 3);
        expect(describeItems(items)).toBe("3 Crowbar, 2 Toolbox");
    });

    it("reads contents, counting identical items with the same contents together", () => {
        const reader = {
            proto: (uid: number) => ({ 1: "Crowbar", 2: "Toolbox", 3: "Pen", 4: "Crowbar", 5: "Toolbox", 6: "Toolbox", 7: "Pen", 8: "Pen" })[uid],
            containers: (uid: number) => (uid === 2 ? [{ id: "storagebase", contents: [3] }] : uid === 5 ? [{ id: "storagebase", contents: [7] }] : uid === 6 ? [{ id: "storagebase", contents: [] }] : []),
        };
        expect(presetItems(reader, [1, 2, 4, 5, 6, 8, 99])).toEqual([
            { proto: "Crowbar", count: 2 },
            { proto: "Toolbox", count: 2, contents: { storagebase: [{ proto: "Pen", count: 1 }] } },
            { proto: "Toolbox", count: 1 },
            { proto: "Pen", count: 1 },
        ]);
    });

    it("applies items in order, skipping refused ones with what they hold", () => {
        const made: Array<[number, string, string]> = [];
        let next = 100;
        const target = {
            refusal: (owner: number, id: string, proto: string) => (proto === "Big" ? "Big is too big" : owner === 100 && made.filter((m) => m[0] === 100).length >= 1 ? "Toolbox is full" : null),
            insert: (owner: number, id: string, proto: string) => {
                made.push([owner, id, proto]);
                return next++;
            },
        };
        const r = applyPreset(target, 10, "entity_storage", [
            { proto: "Toolbox", count: 1, contents: { storagebase: [{ proto: "Pen", count: 3 }] } },
            { proto: "Big", count: 2, contents: { storagebase: [{ proto: "Pen", count: 1 }] } },
            { proto: "Crowbar", count: 1 },
        ]);
        expect(made).toEqual([
            [10, "entity_storage", "Toolbox"],
            [100, "storagebase", "Pen"],
            [10, "entity_storage", "Crowbar"],
        ]);
        expect(r).toEqual({ added: 3, skipped: 2 + 4, reasons: ["Toolbox is full", "Big is too big"] });
    });
});

describe("presets on a map", () => {
    it("saves a locker's contents and applies them to another locker as one undo step", () => {
        const doc = new MapDocument(SMALL);
        const c = new Contents(doc, kit);
        const box = c.put(10, "entity_storage", { proto: "Toolbox" });
        expect(box.ok).toBe(true);
        const toolbox = box.ok ? box.uids[0]! : 0;
        expect(c.put(toolbox, "storagebase", { proto: "Crowbar" }, 2)).toMatchObject({ ok: true, uids: [22, 23] });
        expect(c.put(10, "entity_storage", { proto: "Pen" }, 2)).toMatchObject({ ok: true, uids: [24, 25] });
        const items = c.preset(10, "entity_storage");
        expect(items).toEqual([
            { proto: "Toolbox", count: 1, contents: { storagebase: [{ proto: "Crowbar", count: 2 }] } },
            { proto: "Pen", count: 2 },
        ]);
        const before = doc.serialize(NOW);
        const steps = () => {
            let n = 0;
            while (doc.canUndo) (doc.undo(), n++);
            while (doc.canRedo) doc.redo();
            return n;
        };
        const n = steps();
        // twice into a locker of 4: the second time only one more fits
        expect(c.applyPreset(11, "entity_storage", items)).toEqual({ added: 5, skipped: 0, reasons: [] });
        expect(steps()).toBe(n + 1);
        expect(c.containers(11)[0]!.contents.length).toBe(3);
        expect(c.preset(11, "entity_storage")).toEqual(items);
        // the toolbox and its crowbars go in, the pens do not
        expect(c.applyPreset(11, "entity_storage", items)).toEqual({ added: 3, skipped: 2, reasons: ["Locker is full (4)"] });
        // each locker has its own copies
        expect(new Set(doc.descendants(10)).size + new Set(doc.descendants(11)).size).toBe(doc.descendants(10).length + doc.descendants(11).length);
        expect(doc.descendants(10).some((u) => doc.descendants(11).includes(u))).toBe(false);
        doc.undo();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(before);
        while (doc.canUndo) doc.undo();
        expect(doc.serialize(NOW)).toBe(SMALL);
    });
});
