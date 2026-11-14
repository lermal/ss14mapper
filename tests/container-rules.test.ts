// The game's container checks on prototypes: a small hand-made pack, then the packs built next to the corpus.
import { describe, expect, it } from "vitest";
import { containerRules, ContainerRulesEngine } from "../src/map/container-rules";
import { findStorageSpot, fitsInStorage, type ContainerPack } from "../src/map/containers";
import { MapDocument } from "../src/map/document";
import type { ContainerRules, PrototypeData } from "../src/pack/format";
import { packFor } from "./pack-files";

const RULES: ContainerRules = {
    itemSizes: {
        Tiny: { weight: 1, shape: ["0,0,0,0"] },
        Small: { weight: 2, shape: ["0,0,0,1"] },
        Normal: { weight: 4, shape: ["0,0,1,1"] },
        Large: { weight: 8, shape: ["0,0,3,1"] },
    },
    defaultItemSize: "Small",
    defaultStorageMaxItemSize: "Normal",
    entityStorage: { capacity: 30, maxSize: 1, whitelist: { components: ["MobState", "Item"] }, blacklist: true },
    boundsFloor: 0.6,
    bounds: { Sofa: [1.5, 0.8], Locker: [0.82, 0.82] },
};

const DATA: PrototypeData = {
    entities: {
        BaseItem: { abstract: true, components: { Item: {}, Physics: {} } },
        Crowbar: { parents: ["BaseItem"], components: { Tag: { tags: ["Crowbar", "Tool"] } } },
        Pen: { parents: ["BaseItem"], components: { Item: { size: "Tiny" }, Tag: { tags: ["Pen"] } } },
        Rifle: { parents: ["BaseItem"], components: { Item: { size: "Large", shape: ["0,0,3,0"] } } },
        Magazine: { parents: ["BaseItem"], components: { Tag: { tags: ["Magazine"] } } },
        Bomb: { parents: ["BaseItem"], components: { Tag: { tags: ["Crowbar", "Explosive"] } } },
        Statue: { components: { Transform: { anchored: true } } },
        Sofa: { components: { Item: {} } },
        Mouse: { components: { MobState: {} } },
        Rock: { components: {} },
        Locker: { components: { EntityStorage: { blacklist: { tags: ["Explosive"] } }, ContainerContainer: { containers: { entity_storage: { "!type": "Container" } } } } },
        Vault: { components: { EntityStorage: { maxSize: 2, whitelist: { components: ["Item"], tags: ["Crowbar"], requireAll: true } } } },
        Bag: { components: { Item: { size: "Normal" }, Storage: { grid: ["0,0,3,1"], whitelist: { tags: ["Crowbar", "Pen"] } } } },
        BagPlain: { components: { Item: { size: "Large" }, Storage: { grid: ["0,0,1,1"], defaultStorageOrientation: "Horizontal" } } },
        BagOfBags: { components: { Item: { size: "Large" }, Storage: { grid: ["0,0,3,3"], maxItemSize: "Large" } } },
        Box: { components: { Item: { size: "Large" }, Storage: { grid: ["0,0,3,3"] } } },
        Gun: {
            parents: ["BaseItem"],
            components: {
                ItemSlots: { slots: { magazine: { whitelist: { tags: ["Magazine"] } }, safe: { locked: true }, anything: {}, noBombs: { blacklist: { tags: ["Explosive"] } } } },
                PaperLabel: { labelSlot: { whitelist: { components: ["Paper"] } } },
            },
        },
        Paper: { components: { Item: {}, Paper: {} } },
        LockerFilled: { parents: ["Locker"], components: { EntityTableContainerFill: {} } },
        Orphan: { components: { StorageFill: {} } },
    },
};

const entities = {
    Locker: {},
    LockerFilled: { fills: true as const, plainBase: "Locker" },
    Orphan: { fills: true as const },
};
const rules = new ContainerRulesEngine({ data: DATA, rules: RULES, entities, migrate: (id) => (id === "OldCrowbar" ? "Crowbar" : id === "Gone" ? null : id) });

describe("whitelists", () => {
    it("match by component names, item sizes and tags like EntityWhitelistSystem", () => {
        expect(rules.matches({ components: ["Item"] }, "Crowbar")).toBe(true);
        expect(rules.matches({ components: ["MobState"] }, "Crowbar")).toBe(false);
        expect(rules.matches({ tags: ["Crowbar"] }, "Crowbar")).toBe(true);
        expect(rules.matches({ tags: ["Pen", "Crowbar"] }, "Rifle")).toBe(false);
        expect(rules.matches({ sizes: ["Large"] }, "Rifle")).toBe(true);
        expect(rules.matches({ sizes: ["Tiny"] }, "Rifle")).toBe(false);
        // any one of the components, a size or the tags suffices; a component match returns before the tags are read
        expect(rules.matches({ components: ["Paper"], tags: ["Crowbar"] }, "Crowbar")).toBe(true);
        // requireAll: every component and every tag
        expect(rules.matches({ components: ["Item", "Physics"], tags: ["Crowbar", "Tool"], requireAll: true }, "Crowbar")).toBe(true);
        expect(rules.matches({ components: ["Item", "Physics"], tags: ["Crowbar", "Tool"], requireAll: true }, "Bomb")).toBe(false);
        expect(rules.matches({ components: ["Item", "MobState"], requireAll: true }, "Crowbar")).toBe(false);
        // nothing listed: only requireAll lets it in
        expect(rules.matches({}, "Crowbar")).toBe(false);
        expect(rules.matches({ requireAll: true }, "Crowbar")).toBe(true);
    });

    it("read tags and components with parents applied, through migrations", () => {
        expect(rules.tags("Crowbar")).toEqual(["Crowbar", "Tool"]);
        expect(Object.keys(rules.components("Crowbar"))).toEqual(expect.arrayContaining(["Item", "Physics", "Tag"]));
        expect(rules.components("NoSuchThing")).toEqual({});
        expect(rules.resolve("OldCrowbar")).toBe("Crowbar");
        expect(rules.resolve("Gone")).toBeNull();
        expect(rules.refusal("OldCrowbar", "Locker", "entity_storage")).toBeNull();
        expect(rules.refusal("Gone", "Locker", "entity_storage")).toBe("Unknown prototype Gone");
    });
});

describe("items", () => {
    it("have the size and shape of the item or its size", () => {
        expect(rules.itemSize("Crowbar")).toBe("Small");
        expect(rules.itemSize("Pen")).toBe("Tiny");
        expect(rules.itemSize("Rock")).toBeNull();
        expect(rules.itemShape("Crowbar")).toEqual([[0, 0, 0, 1]]);
        expect(rules.itemShape("Pen")).toEqual([[0, 0, 0, 0]]);
        expect(rules.itemShape("Rifle")).toEqual([[0, 0, 3, 0]]);
        expect(rules.itemShape("Rock")).toBeNull();
    });
});

describe("entity storage", () => {
    it("takes items and mobs, not other things, and obeys its lists", () => {
        expect(rules.refusal("Crowbar", "Locker", "entity_storage")).toBeNull();
        expect(rules.refusal("Mouse", "Locker", "entity_storage")).toBeNull();
        expect(rules.refusal("Rock", "Locker", "entity_storage")).toBe("Locker does not take Rock");
        expect(rules.refusal("Bomb", "Locker", "entity_storage")).toBe("Locker does not take Bomb");
        // a whitelist of its own replaces the default one
        expect(rules.refusal("Crowbar", "Vault", "entity_storage")).toBeNull();
        expect(rules.refusal("Pen", "Vault", "entity_storage")).toBe("Vault does not take Pen");
        expect(rules.refusal("Mouse", "Vault", "entity_storage")).toBe("Vault does not take Mouse");
    });

    it("compares the bounds with MaxSize", () => {
        expect(rules.entityFits("Crowbar", "Locker")).toBe(true);
        expect(rules.entityFits("Locker", "Locker")).toBe(true);
        expect(rules.entityFits("Sofa", "Locker")).toBe(false);
        expect(rules.refusal("Sofa", "Locker", "entity_storage")).toBe("Sofa is too big for Locker");
        expect(rules.entityFits("Sofa", "Vault")).toBe(true);
        expect(rules.entityStorageMaxSize("Vault")).toBe(2);
        expect(rules.entityStorageMaxSize("Locker")).toBe(1);
        expect(rules.entityStorageCapacity("Locker")).toBe(30);
    });

    it("ignores a blacklist the fork does not have", () => {
        const old = new ContainerRulesEngine({ data: DATA, rules: { ...RULES, entityStorage: { ...RULES.entityStorage, blacklist: false } } });
        expect(old.refusal("Bomb", "Locker", "entity_storage")).toBeNull();
    });
});

describe("storage", () => {
    it("refuses what is not an item, what is anchored and what is too big", () => {
        expect(rules.refusal("Locker", "Bag", "storagebase")).toBe("Locker is not an item");
        expect(rules.refusal("Rock", "Box", "storagebase")).toBe("Rock is not an item");
        expect(rules.refusal("Crowbar", "Box", "storagebase")).toBeNull();
        expect(rules.refusal("Rifle", "Box", "storagebase")).toBe("Rifle is too big for Box"); // Large over Normal
        expect(rules.refusal("Rifle", "BagOfBags", "storagebase")).toBeNull();
        const anchored = new ContainerRulesEngine({ data: { entities: { ...DATA.entities, Anchored: { components: { Item: {}, Transform: { anchored: true } } } } }, rules: RULES });
        expect(anchored.refusal("Anchored", "Box", "storagebase")).toBe("Anchored is anchored");
    });

    it("applies the storage's lists and takes the max item size from the bag", () => {
        expect(rules.refusal("Crowbar", "Bag", "storagebase")).toBeNull();
        expect(rules.refusal("Magazine", "Bag", "storagebase")).toBe("Bag does not take Magazine");
        expect(rules.storageMaxItemSize("Box")).toBe("Normal"); // Large item: one size below
        expect(rules.storageMaxItemSize("Bag")).toBe("Small");
        expect(rules.storageMaxItemSize("BagOfBags")).toBe("Large");
        expect(rules.storageMaxItemSize("Locker")).toBe("Normal"); // not an item: the default
    });

    it("keeps a bag out of a bag that holds items as big as itself", () => {
        // the inner bag holds items below its own size, the outer one's limit is higher: allowed
        expect(rules.refusal("Bag", "Box", "storagebase")).toBeNull();
        expect(rules.refusal("BagPlain", "BagOfBags", "storagebase")).toBeNull();
        // its limit (Large) reaches the outer one's: refused although it is only a Large item
        expect(rules.refusal("BagOfBags", "BagOfBags", "storagebase")).toBe("BagOfBags is too big for BagOfBags");
        expect(rules.refusal("BagOfBags", "Box", "storagebase")).toBe("BagOfBags is too big for Box");
    });

    it("gives the grid, the item shape and the orientation", () => {
        const g = rules.geometry("Crowbar", "Bag")!;
        expect(g.grid).toEqual([[0, 0, 3, 1]]);
        expect(g.shape).toEqual([[0, 0, 0, 1]]);
        expect(rules.geometry("Rock", "Bag")).toBeNull();
        expect(rules.geometry("Crowbar", "Locker")).toBeNull();
        expect(rules.geometry("Crowbar", "BagPlain")!.orientation).toBe("Horizontal");
    });

    it("fits what the game fits", () => {
        // 4×2 grid: the Rifle (4×1) lies on its side, a crowbar (1×2) stands up
        const g = rules.geometry("Rifle", "Box")!;
        expect(findStorageSpot(g.grid, g.shape)).toEqual({ x: 0, y: 0, rotation: "South" });
        const crowbar = rules.geometry("Crowbar", "Bag")!;
        const rifle = rules.geometry("Rifle", "Bag")!;
        expect(fitsInStorage(rifle.grid, [], rifle.shape, { x: 0, y: 0, rotation: "South" })).toBe(true);
        // a 1×4 item turned does not fit the 2-high grid
        expect(fitsInStorage(rifle.grid, [], rifle.shape, { x: 0, y: 0, rotation: "East" })).toBe(false);
        // two crowbars side by side, the next on top of one does not fit
        const placed = [{ shape: crowbar.shape, location: { x: 0, y: 0, rotation: "South" as const } }];
        expect(fitsInStorage(crowbar.grid, placed, crowbar.shape, { x: 0, y: 0, rotation: "South" })).toBe(false);
        expect(fitsInStorage(crowbar.grid, placed, crowbar.shape, { x: 1, y: 0, rotation: "South" })).toBe(true);
    });
});

describe("item slots", () => {
    it("obey the slot's whitelist, blacklist and lock", () => {
        expect(rules.refusal("Magazine", "Gun", "magazine")).toBeNull();
        expect(rules.refusal("Crowbar", "Gun", "magazine")).toBe("Crowbar does not fit in magazine");
        expect(rules.refusal("Crowbar", "Gun", "safe")).toBe("safe is locked");
        expect(rules.refusal("Crowbar", "Gun", "anything")).toBeNull();
        expect(rules.refusal("Crowbar", "Gun", "noBombs")).toBeNull();
        expect(rules.refusal("Bomb", "Gun", "noBombs")).toBe("Bomb does not fit in noBombs");
        expect(rules.slot("Gun", "nothing")).toBeNull();
    });

    it("include PaperLabel's slot", () => {
        expect(rules.refusal("Paper", "Gun", "paper_label")).toBeNull();
        expect(rules.refusal("Crowbar", "Gun", "paper_label")).toBe("Crowbar does not fit in paper_label");
    });

    it("leave the game's own containers alone", () => {
        expect(rules.refusal("Crowbar", "Gun", "ballistic-ammo")).toBeNull();
        expect(rules.refusal("Crowbar", "NoSuchOwner", "entity_storage")).toBeNull();
    });
});

describe("filled prototypes", () => {
    it("say which are filled and what the plain one is", () => {
        expect(rules.fill("Locker")).toEqual({ fills: false });
        expect(rules.fill("LockerFilled")).toEqual({ fills: true, plainBase: "Locker" });
        expect(rules.fill("Orphan")).toEqual({ fills: true });
        expect(rules.fill("NoSuchThing")).toEqual({ fills: false });
    });
});

describe("with a map", () => {
    const map = (entities: Array<[number, string]>) => {
        const lines = ["meta:", "  format: 7", "  entityCount: " + (entities.length + 1), "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
        for (const [uid, proto] of entities) lines.push(`- proto: ${proto}`, "  entities:", `  - uid: ${uid}`, "    components:", "    - type: Transform", `      pos: ${uid}.5,0.5`, "      parent: 1");
        return lines.join("\n") + "\n...\n";
    };
    const pack: ContainerPack = { data: DATA };
    const doc = new MapDocument(map([[10, "Locker"], [11, "Bag"], [12, "BagPlain"], [20, "Crowbar"], [21, "Rock"], [22, "Magazine"], [23, "Rifle"], [30, "Gun"]]));

    it("feed allow and geometry to the container operations", () => {
        const options = (owner: number, id: string, item: number) => ({ pack, ...rules.insertOptions(doc, owner, id, item) });
        expect(doc.canInsert(10, "entity_storage", 20, options(10, "entity_storage", 20)).ok).toBe(true);
        expect(doc.canInsert(10, "entity_storage", 21, options(10, "entity_storage", 21))).toEqual({ ok: false, reason: "Locker does not take Rock" });
        expect(doc.canInsert(30, "magazine", 22, options(30, "magazine", 22)).ok).toBe(true);
        expect(doc.canInsert(30, "magazine", 20, options(30, "magazine", 20))).toEqual({ ok: false, reason: "Crowbar does not fit in magazine" });
        // storage: the game's first free spot; 23 (Rifle, 4×1) fits the 4×2 bag only side-on
        expect(doc.canInsert(11, "storagebase", 23, options(11, "storagebase", 23)).ok).toBe(false); // the bag's whitelist
        expect(doc.canInsert(12, "storagebase", 23, options(12, "storagebase", 23))).toEqual({ ok: false, reason: "No room in BagPlain" });
        expect(doc.canInsert(11, "storagebase", 20, options(11, "storagebase", 20)).ok).toBe(true);
        const uid = doc.insertIntoContainer(11, "storagebase", { proto: "Pen" }, { pack, ...rules.insertOptions(doc, 11, "storagebase", { proto: "Pen" }) });
        expect(doc.containerOf(uid)?.owner).toBe(11);
        expect(doc.serialize(new Date(2026, 10, 14))).toMatch(/storedItems:\n {8}\d+:\n {10}position: 0,0\n {10}_rotation: South/);
    });
});

describe("containerRules", () => {
    it("is null without the pack's data", () => {
        expect(containerRules({ data: null, rules: RULES })).toBeNull();
        expect(containerRules({ data: DATA, rules: null })).toBeNull();
        expect(containerRules({ data: DATA, rules: RULES })).toBeInstanceOf(ContainerRulesEngine);
    });
});

// ---------------------------------------------------------------------------------------------
// The packs built next to the corpus (SS14MAPPER_PACKS to test others)

describe.each(["upstream", "frontier", "goob"])("pack %s", (fork) => {
    const pack = packFor(fork);
    const real = pack
        ? (async () => {
              const engine = containerRules({ data: await pack.prototypeData(), rules: await pack.containerRules(), entities: pack.prototypes.entities, migrate: (id) => pack.migrate(id) });
              return engine!;
          })()
        : null;
    const rulesOf = () => real!;

    it.skipIf(!pack)("puts a crowbar into a plain engineering locker and keeps lockers out of bags", async () => {
        const r = await rulesOf();
        expect(r.refusal("Crowbar", "LockerEngineer", "entity_storage")).toBeNull();
        expect(r.refusal("Crowbar", "LockerEngineer", "entity_storage")).toBeNull();
        // a locker is no item, whatever bag it goes into
        expect(r.refusal("LockerEngineer", "ClothingBackpack", "storagebase")).toBe("LockerEngineer is not an item");
        expect(r.refusal("Crowbar", "ClothingBackpack", "storagebase")).toBeNull();
        // a rock-like structure is not stored in lockers either
        expect(r.refusal("WallSolid", "LockerEngineer", "entity_storage")).not.toBeNull();
    });

    it.skipIf(!pack)("keeps crowbars out of magazine slots", async () => {
        const r = await rulesOf();
        const data = (await pack!.prototypeData())!;
        const ids = Object.keys(data.entities).filter((id) => !data.entities[id]!.abstract);
        // a gun with a slot that takes magazines by tag, and a magazine carrying one of the tags
        let found: { gun: string; slot: string; magazine: string } | undefined;
        for (const gun of ids) {
            const slots = (r.components(gun).ItemSlots?.slots ?? {}) as Record<string, { whitelist?: { tags?: string[] } }>;
            for (const [slot, def] of Object.entries(slots)) {
                const tag = def.whitelist?.tags?.find((t) => /Magazine/.test(t));
                const magazine = tag && ids.find((id) => r.components(id).Item && r.tags(id).includes(tag));
                if (magazine) found ??= { gun, slot, magazine };
            }
        }
        expect(found).toBeDefined();
        const { gun, slot, magazine } = found!;
        expect(r.refusal(magazine, gun, slot)).toBeNull();
        expect(r.refusal("Crowbar", gun, slot)).toBe(`Crowbar does not fit in ${slot}`);
        if (fork === "upstream") expect(r.refusal("Crowbar", "WeaponPistolMk58", "gun_magazine")).toBe("Crowbar does not fit in gun_magazine");
    });

    it.skipIf(!pack)("fits tools into a toolbox as the game does", async () => {
        const r = await rulesOf();
        expect(r.itemShape("Crowbar")).toEqual([[0, 0, 0, 1]]);
        expect(r.storageGrid("ToolboxMechanical")).toEqual([[0, 0, 6, 3]]);
        expect(r.storageMaxItemSize("ToolboxMechanical")).toBe("Normal");
        expect(r.refusal("Crowbar", "ToolboxMechanical", "storagebase")).toBeNull();
        // a toolbox in a toolbox: Ginormous over Normal
        expect(r.refusal("ToolboxMechanical", "ToolboxMechanical", "storagebase")).toContain("too big");
        const g = r.geometry("Crowbar", "ToolboxMechanical")!;
        expect(findStorageSpot(g.grid, g.shape, [], g.orientation)).not.toBeNull();
        // 7×4 cells hold 14 crowbars of 1×2 and not a 15th
        const placed: Array<{ shape: typeof g.shape; location: { x: number; y: number; rotation: "South" } }> = [];
        for (let i = 0; i < 14; i++) {
            const spot = findStorageSpot(g.grid, g.shape, placed, g.orientation);
            expect(spot, `crowbar ${i}`).not.toBeNull();
            placed.push({ shape: g.shape, location: { x: spot!.x, y: spot!.y, rotation: spot!.rotation as "South" } });
        }
        expect(findStorageSpot(g.grid, g.shape, placed, g.orientation)).toBeNull();
    });

    it.skipIf(!pack)("maps Filled prototypes to the plain ones", async () => {
        const r = await rulesOf();
        expect(r.fill("LockerEngineerFilled")).toEqual({ fills: true, plainBase: "LockerEngineer" });
        expect(r.fill("ToolboxMechanicalFilled")).toEqual({ fills: true, plainBase: "ToolboxMechanical" });
        expect(r.fill("LockerEngineer")).toEqual({ fills: false });
        // every prototype named Filled fills; most have a plain one
        const e = pack!.prototypes.entities;
        const named = Object.keys(e).filter((id) => /Filled/.test(id) && !e[id]!.hidden);
        expect(named.length).toBeGreaterThan(50);
        const plain = named.filter((id) => e[id]!.plainBase);
        expect(plain.length / named.length).toBeGreaterThan(0.6);
        // the rest are tanks and barrels filled with gas or reagents, not with entities
        expect(named.filter((id) => e[id]!.fills).length / named.length).toBeGreaterThan(0.8);
    });

    it.skipIf(!pack)("keeps big things out of lockers", async () => {
        const r = await rulesOf();
        const rules = (await pack!.containerRules())!;
        const big = Object.entries(rules.bounds).find(([, b]) => Math.max(...b) > 1.2)![0];
        expect(r.entityFits(big, "LockerEngineer")).toBe(false);
        expect(r.entityFits("Crowbar", "LockerEngineer")).toBe(true);
    });
});
