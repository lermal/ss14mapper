import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerData } from "../tools/pack/containers";
import { DeviceData } from "../tools/pack/devices";
import { Checkout, expandVariants, type Raw } from "../tools/pack/game";
import { bodyMass, gridPhysics, shapeArea } from "../tools/pack/physics";
import { packTextures } from "../tools/pack/textures";
import { packFor } from "./pack-files";

let root: string;

function write(rel: string, content: string | Buffer) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/** Solid-colour PNG strip of `frames` square frames of `size` px, each frame a different shade. */
async function strip(size: number, frames: number): Promise<Buffer> {
    const data = Buffer.alloc(size * frames * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size * frames; x++) {
            const i = (y * size * frames + x) * 4;
            data[i] = Math.floor(x / size) * 40;
            data[i + 1] = 100;
            data[i + 2] = 200;
            data[i + 3] = 255;
        }
    }
    return sharp(data, { raw: { width: size * frames, height: size, channels: 4 } }).png().toBuffer();
}

beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ss14mapper-pack-"));
    write(
        "RobustToolbox/Resources/EnginePrototypes/entityCategory.yml",
        "- type: entityCategory\n  id: HideSpawnMenu\n  hideSpawnMenu: true\n  inheritable: false\n",
    );
    write("RobustToolbox/Robust.Shared.Maths/Color.cs", "public static Color Green => new(0, 128, 0, 255);\n");
    write(
        "Resources/Prototypes/categories.yml",
        [
            "- type: entityCategory",
            "  id: Actions",
            "  hideSpawnMenu: true",
            "- type: entityCategory",
            "  id: GameRules",
            "  hideSpawnMenu: true",
            "  components: [ GameRule ]",
            "- type: entityCategory",
            "  id: DoNotMap",
            "  suffix: entity-category-suffix-donotmap",
        ].join("\n"),
    );
    write(
        "Resources/Prototypes/entities.yml",
        [
            "- type: entity",
            "  id: BaseWall",
            "  abstract: true",
            "  name: base wall",
            "  components:",
            "  - type: Sprite",
            "    sprite: Walls/solid.rsi",
            "    state: full",
            "  - type: Transform",
            "    anchored: true",
            "- type: entity",
            "  id: Other",
            "  abstract: true",
            "  components:",
            "  - type: Sprite",
            "    sprite: Other/other.rsi",
            "- type: entity",
            "  id: WallSolid",
            "  parent: [ BaseWall, Other ]",
            "  categories: [ HideSpawnMenu ]",
            "- type: entity",
            "  id: WallSolidChild",
            "  parent: WallSolid",
            "- type: entity",
            "  id: SomeAction",
            "  components:",
            "  - type: Action",
            "- type: entity",
            "  id: SomeRule",
            "  components:",
            "  - type: GameRule",
            "- type: entity",
            "  id: Prop",
            "  categories: [ DoNotMap ]",
            "  name: prop",
            "- type: tile",
            "  id: FloorSteel",
            "  name: tiles-steel-floor",
            "  sprite: /Textures/Tiles/steel.png",
            "  variants: 4",
        ].join("\n"),
    );
    write(
        "Resources/Locale/en-US/entities.ftl",
        "ent-WallSolid = solid wall\n    .desc = A wall.\n    .suffix = Station\nent-WallSolidChild = { ent-WallSolid }\nentity-category-suffix-donotmap = DO NOT MAP\ntiles-steel-floor = steel floor\n",
    );
    write(
        "Content.Shared/Actions/ActionComponent.cs",
        '[RegisterComponent, NetworkedComponent]\n[EntityCategory("Actions")]\npublic sealed partial class ActionComponent : Component { }\n',
    );
    write(
        "Resources/Textures/Walls/solid.rsi/meta.json",
        JSON.stringify({ version: 1, license: "CC-BY-SA-3.0", copyright: "test", size: { x: 32, y: 32 }, states: [{ name: "full" }, { name: "dirs", directions: 4, delays: [[0.1, 0.1], [0.1], [0.1], [0.1]] }] }),
    );
    write("Resources/Textures/Walls/solid.rsi/full.png", await strip(32, 1));
    // 4 directions, the first one has two animation frames: frames 0,1 | 2 | 3 | 4
    write("Resources/Textures/Walls/solid.rsi/dirs.png", await strip(32, 5));
    write("Resources/Textures/Tiles/steel.png", await strip(32, 4));

    // device linking: port prototypes, ports from YAML and from C# systems
    write(
        "Resources/Prototypes/ports.yml",
        [
            "- type: sourcePort",
            "  id: DoorStatus",
            "  name: signal-port-name-doorstatus",
            "  description: signal-port-description-doorstatus",
            "  defaultLinks: [ Open ]",
            "- type: sinkPort",
            "  id: Open",
            "  name: signal-port-name-open",
            "  description: signal-port-description-open",
            "- type: sinkPort",
            "  id: Missing",
            "  name: signal-port-name-missing",
            "  description: signal-port-description-missing",
        ].join("\n"),
    );
    write("Resources/Locale/en-US/ports.ftl", "signal-port-name-doorstatus = Door status\nsignal-port-description-doorstatus = Fires when the door opens.\nsignal-port-name-open = Open\n");
    write(
        "Resources/Prototypes/devices.yml",
        [
            "- type: entity",
            "  id: Door",
            "  components:",
            "  - type: DoorSignalControl",
            "  - type: DoorBolt",
            "  - type: DeviceLinkSink",
            "    ports: [ AutoClose ]",
            "  - type: DeviceNetwork",
            "    deviceNetId: Wireless",
            "    receiveFrequencyId: BasicDevice",
            "- type: entity",
            "  id: DoorNoBolt",
            "  components:",
            "  - type: DoorSignalControl",
            "    openPort: Toggle",
            "- type: entity",
            "  id: Vent",
            "  components:",
            "  - type: GasVentPump",
            "- type: entity",
            "  id: VentLinked",
            "  parent: Vent",
            "  components:",
            "  - type: GasVentPump",
            "    canLink: true",
            "- type: entity",
            "  id: Alarm",
            "  components:",
            "  - type: DeviceList",
            "  - type: DeviceNetwork",
            "    deviceNetId: AtmosDevices",
            "- type: entity",
            "  id: BaseBox",
            "  abstract: true",
            "  components:",
            "  - type: Physics",
            "  - type: Fixtures",
            "    fixtures:",
            "      fix1:",
            "        shape:",
            "          !type:PhysShapeAabb",
            '          bounds: "-0.5,-0.5,0.5,0.5"',
            "        density: 10",
            "      fix2:",
            "        shape:",
            "          !type:PhysShapeCircle",
            "          radius: 0.5",
            "          position: 0,1",
            "        density: 4",
            "      sensor:",
            "        shape:",
            "          !type:PhysShapeCircle",
            "          radius: 3",
            "        density: 0",
            "- type: entity",
            "  id: Box",
            "  parent: BaseBox",
            "- type: entity",
            "  id: BoxRelayered",
            "  parent: BaseBox",
            "  components:",
            "  - type: Fixtures",
            "    fixtures:",
            "      fix1:",
            "        layer: [ WallLayer ]",
            "- type: entity",
            "  id: BoxNoFixtures",
            "  parent: BaseBox",
            "  components:",
            "  - type: Fixtures",
            "- type: entity",
            "  id: Ghostly",
            "  components:",
            "  - type: Fixtures",
            "    fixtures: {}",
        ].join("\n"),
    );
    write(
        "Content.Shared/DeviceLinking/DeviceLink.cs",
        "public readonly partial record struct DeviceLink(ProtoId<SourcePortPrototype> Source, ProtoId<SinkPortPrototype> Sink);\n",
    );
    write(
        "Content.Shared/DeviceLinking/Components/DoorSignalControlComponent.cs",
        [
            "[RegisterComponent]",
            "public sealed partial class DoorSignalControlComponent : Component",
            "{",
            "    [DataField]",
            '    public ProtoId<SinkPortPrototype> OpenPort = "Open";',
            '    [DataField("boltPort")]',
            '    public ProtoId<SinkPortPrototype> InBolt = "DoorBolt";',
            '    [DataField("onOpenPort")]',
            '    public ProtoId<SourcePortPrototype> OutOpen = "DoorStatus";',
            "}",
        ].join("\n"),
    );
    write(
        "Content.Shared/DeviceLinking/Systems/DoorSignalControlSystem.cs",
        [
            "public sealed class DoorSignalControlSystem : EntitySystem",
            "{",
            "    [SubscribeLocalEvent]",
            "    private void OnInit(Entity<DoorSignalControlComponent> ent, ref ComponentInit args)",
            "    {",
            "        _signal.EnsureSinkPorts(ent.Owner, ent.Comp.OpenPort);",
            "",
            "        if (HasComp<DoorBoltComponent>(ent.Owner))",
            "            _signal.EnsureSinkPort(ent.Owner, ent.Comp.InBolt);",
            "",
            "        _signal.EnsureSourcePort(ent.Owner, ent.Comp.OutOpen);",
            "    }",
            "}",
        ].join("\n"),
    );
    write(
        "Content.Server/Atmos/GasVentPumpSystem.cs",
        [
            "public sealed partial class GasVentPumpComponent : Component",
            "{",
            "    [DataField] public bool CanLink = false;",
            '    [DataField("pressurizePort", customTypeSerializer: typeof(PrototypeIdSerializer<SinkPortPrototype>))]',
            '    public string PressurizePort = "Pressurize";',
            "}",
            "public sealed class GasVentPumpSystem : EntitySystem",
            "{",
            "    private void OnInit(EntityUid uid, GasVentPumpComponent component, ComponentInit args)",
            "    {",
            "        if (component.CanLink)",
            "        {",
            "            _signalSystem.EnsureSinkPorts(uid, component.PressurizePort);",
            "        }",
            "    }",
            "}",
        ].join("\n"),
    );
    write(
        "Resources/Prototypes/containers.yml",
        [
            "- type: itemSize",
            "  id: Small",
            "  weight: 2",
            "  defaultShape:",
            "  - 0,0,0,1",
            "- type: itemSize",
            "  id: Normal",
            "  weight: 4",
            "  defaultShape:",
            "  - 0,0,1,1",
            "- type: entity",
            "  id: LockerBase",
            "  abstract: true",
            "  components:",
            "  - type: ContainerContainer",
            "    containers:",
            "      entity_storage: !type:Container",
            "      paper_label: !type:ContainerSlot",
            "      ammo: !type:Container",
            "        showEnts: true",
            "  - type: EntityStorage",
            "  - type: Fixtures",
            "    fixtures:",
            "      fix1:",
            "        shape: !type:PhysShapeAabb",
            "          bounds: -0.4,-0.4,0.4,0.4",
            "- type: entity",
            "  id: Locker",
            "  parent: LockerBase",
            "- type: entity",
            "  id: LockerFilled",
            "  parent: Locker",
            "  components:",
            "  - type: EntityTableContainerFill",
            "    containers:",
            "      entity_storage: !type:NestedSelector",
            "        tableId: Stuff",
            "- type: entity",
            "  id: LockerFilledRare",
            "  parent: LockerFilled",
            "- type: entity",
            "  id: OnlyAbstractBase",
            "  parent: LockerBase",
            "  components:",
            "  - type: StorageFill",
            "- type: entity",
            "  id: Crate",
            "  components:",
            "  - type: Fixtures",
            "    fixtures:",
            "      fix1:",
            "        shape: !type:PhysShapeAabb",
            "          bounds: -0.5,-0.5,0.5,0.5",
            "      fix2:",
            "        shape: !type:PhysShapeCircle",
            "          radius: 0.2",
            "          position: 1,0",
            "- type: entity",
            "  id: Pebble",
            "  components:",
            "  - type: Fixtures",
            "    fixtures:",
            "      fix1:",
            "        shape: !type:PhysShapeCircle",
            "          radius: 0.1",
        ].join("\n"),
    );
    write(
        "Content.Shared/Item/ItemComponent.cs",
        'public sealed partial class ItemComponent : Component\n{\n    [DataField]\n    public ProtoId<ItemSizePrototype> Size = "Small";\n}\n',
    );
    write(
        "Content.Shared/Storage/EntitySystems/SharedStorageSystem.cs",
        'public abstract class SharedStorageSystem\n{\n    public static readonly ProtoId<ItemSizePrototype> DefaultStorageMaxItemSize = "Normal";\n}\n',
    );
    write(
        "Content.Shared/Storage/Components/EntityStorageComponent.cs",
        [
            "public sealed partial class EntityStorageComponent : Component",
            "{",
            "    /// Whitelist = new() { Components = [ \"Nothing\" ] }",
            "    [DataField] public float MaxSize = 1.0f;",
            "    [DataField] public int Capacity = 30;",
            "    [DataField] public EntityWhitelist? Whitelist = new()",
            "    {",
            "        Components =",
            "        [",
            '            "MobState",',
            '            "Item",',
            "        ],",
            "    };",
            "    [DataField] public EntityWhitelist? Blacklist;",
            "}",
        ].join("\n"),
    );
    write("Content.Shared/Shuttles/Systems/SharedShuttleSystem.cs", "public abstract partial class SharedShuttleSystem\n{\n    public const float TileDensityMultiplier = 800f;\n}\n");
    write("Content.Shared/Maps/ContentTileDefinition.cs", "public sealed partial class ContentTileDefinition\n{\n    [DataField]\n    public float Mass = SharedShuttleSystem.TileDensityMultiplier;\n}\n");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("checkout", () => {
    it("merges parents with the first one winning and keeps own fields", () => {
        const game = new Checkout(root);
        const wall = game.entity("WallSolid");
        expect(wall.components.Sprite).toMatchObject({ sprite: "Walls/solid.rsi", state: "full" });
        expect(wall.components.Transform).toMatchObject({ anchored: true });
        expect(wall.name).toBe("base wall");
    });

    it("hides prototypes like the game's spawn menu", () => {
        const game = new Checkout(root);
        expect(game.hidden("BaseWall")).toBe(true); // abstract
        expect(game.hidden("WallSolid")).toBe(true); // HideSpawnMenu
        expect(game.hidden("WallSolidChild")).toBe(false); // HideSpawnMenu is not inheritable
        expect(game.hidden("SomeAction")).toBe(true); // category from the C# attribute of ActionComponent
        expect(game.hidden("SomeRule")).toBe(true); // category listing the component in YAML
        expect(game.hidden("Prop")).toBe(false);
    });

    it("collects component names from prototypes and registered C# classes", () => {
        write("Content.Shared/Misc/BreathToolComponent.cs", "[RegisterComponent, NetworkedComponent]\n[ComponentProtoName(\"BreathMask\")]\npublic sealed partial class BreathToolComponent : Component { }\n");
        write("Content.Server/Misc/FooBarComponent.cs", "namespace X;\n\n[RegisterComponent]\npublic sealed partial class FooBarComponent : Component { }\n");
        write("Content.Server/Misc/NotRegisteredComponent.cs", "[NetworkedComponent]\npublic sealed partial class NotRegisteredComponent : Component { }\n");
        write("RobustToolbox/Robust.Shared/GameObjects/MetaDataComponent.cs", "[RegisterComponent, NetworkedComponent]\npublic sealed partial class MetaDataComponent : Component { }\n");
        const names = new Checkout(root).componentNames();
        expect(names).toEqual(expect.arrayContaining(["Sprite", "Transform", "BreathMask", "FooBar", "MetaData"]));
        expect(names).not.toContain("BreathTool");
        expect(names).not.toContain("NotRegistered");
        expect(names).toEqual([...names].sort());
        expect(new Set(names).size).toBe(names.length);
    });

    it("names entities from localisation with suffixes", () => {
        const game = new Checkout(root);
        expect(game.displayName("WallSolid")).toBe("solid wall");
        expect(game.displayName("WallSolidChild")).toBe("solid wall");
        expect(game.displaySuffix("WallSolid")).toBe("Station");
        expect(game.displaySuffix("Prop")).toBe("DO NOT MAP");
        expect(game.localize("tiles-steel-floor")).toBe("steel floor");
        expect(game.colors.get("green")).toEqual([0, 128 / 255, 0, 1]);
    });
});

describe("device linking", () => {
    it("gives entities the ports of their components and of the systems that start them", () => {
        const game = new Checkout(root);
        const devices = new DeviceData(game);
        expect(devices.ports(game.entity("Door"))).toEqual({ source: ["DoorStatus"], sink: ["AutoClose", "Open", "DoorBolt"] });
        // no DoorBolt: the bolt port is not added; the YAML field overrides the C# default
        expect(devices.ports(game.entity("DoorNoBolt"))).toEqual({ source: ["DoorStatus"], sink: ["Toggle"] });
        // `if (component.CanLink)` with the C# default false
        expect(devices.ports(game.entity("Vent"))).toEqual({ source: [], sink: [] });
        expect(devices.ports(game.entity("VentLinked"))).toEqual({ source: [], sink: ["Pressurize"] });
        expect(game.problems.filter((p) => p.includes("port"))).toEqual([]);
    });

    it("reads port prototypes with localised names and default links", () => {
        const devices = new DeviceData(new Checkout(root));
        expect(devices.portPrototypes("sourcePort")).toEqual({
            DoorStatus: { name: "Door status", description: "Fires when the door opens.", defaultLinks: ["Open"] },
        });
        // a name missing from the locale stays the key, as the game shows it
        expect(devices.portPrototypes("sinkPort")).toEqual({
            Missing: { name: "signal-port-name-missing", description: "signal-port-description-missing" },
            Open: { name: "Open", description: "signal-port-description-open" },
        });
        expect(devices.storage).toEqual({ linkFormat: "struct", deviceListBackReference: "DeviceNetwork" });
    });
});

describe("masses", () => {
    it("computes body masses from fixtures as the engine composes them", () => {
        const game = new Checkout(root);
        const box = bodyMass(game, "Box")!;
        // 1 × 10 at the origin plus π·0.25 × 4 at (0, 1); the zero-density sensor adds nothing
        expect(box.mass).toBeCloseTo(10 + Math.PI, 9);
        expect(box.centre[1]).toBeCloseTo(Math.PI / (10 + Math.PI), 9);
        // fixtures are never inherited: a child declaring Fixtures has only its own (fix1 with the default unit box)
        expect(bodyMass(game, "BoxRelayered")).toEqual({ mass: 1, centre: [0, 0] });
        // no fixtures at all: the engine still gives the body a mass of 1
        expect(bodyMass(game, "BoxNoFixtures")).toEqual({ mass: 1, centre: [0, 0] });
        expect(bodyMass(game, "Ghostly")).toBeNull(); // no Physics, no body
        expect(gridPhysics(game)).toEqual({ tileDensity: 800, tileMass: 800 });
    });

    it("takes polygon areas from the convex hull", () => {
        const tri = shapeArea({ "!type": "PolygonShape", vertices: ["0,0", "1,0", "0,1", "0.2,0.2"] });
        expect(tri.area).toBeCloseTo(0.5, 9);
        expect(tri.centre[0]).toBeCloseTo(1 / 3, 9);
        expect(shapeArea({ "!type": "PhysShapeAabb", bounds: "0,0,2,1" })).toEqual({ area: 2, centre: [1, 0.5] });
    });
});

// the packs built next to the corpus (SS14MAPPER_PACKS to test others)
describe.each(["upstream", "frontier", "goob"])("pack %s", (fork) => {
    const pack = packFor(fork);
    it.skipIf(!pack)("lists every component name of the fork, sorted", () => {
        const names = pack!.prototypes.componentNames!;
        expect(names).toEqual(expect.arrayContaining(["Transform", "Sprite", "DeviceLinkSource"].filter((n) => n !== "AirAlarm")));
        expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        for (const e of Object.values(pack!.prototypes.entities)) for (const c of Object.keys(e.components)) expect(names).toContain(c);
        expect(names.length).toBeGreaterThan(fork === "upstream" ? 1000 : 500);
    });

    it.skipIf(!pack)("has signal ports, configurators and masses", () => {
        const p = pack!.prototypes;
        const e = p.entities;
        expect(e.SignalButton!.ports?.source).toContain("Pressed");
        for (const door of ["Airlock", "AirlockGlass"]) expect(e[door]!.ports?.sink).toEqual(expect.arrayContaining(["Toggle", "Open", "Close"]));
        expect(e.AirlockGlass!.ports?.source).toContain("DoorStatus");
        expect(e.ConveyorBelt!.ports?.sink).toEqual(expect.arrayContaining(["Forward", "Reverse", "Off"]));
        expect(e.AirAlarm!.ports?.source).toEqual(expect.arrayContaining(["AirDanger", "AirWarning", "AirNormal"]));
        expect(p.ports!.source.Pressed).toMatchObject({ name: "Pressed", defaultLinks: expect.arrayContaining(["Toggle"]) });
        expect(p.ports!.sink.Toggle!.name).toBe("Toggle");
        for (const ports of Object.values(e).map((x) => x.ports)) {
            for (const id of ports?.source ?? []) expect(p.ports!.source[id], id).toBeDefined();
        }
        // air and fire alarms keep device lists; vents, scrubbers and firelocks join them on the same network
        for (const alarm of ["AirAlarm", "FireAlarm"]) {
            expect(e[alarm]!.components.DeviceList).toBeDefined();
            expect(e[alarm]!.components.DeviceNetwork?.deviceNetId).toBe("AtmosDevices");
        }
        for (const device of ["GasVentPump", "GasVentScrubber", "AirSensor", "FirelockGlass"]) {
            expect(e[device]!.components.DeviceNetwork?.deviceNetId).toBe("AtmosDevices");
            expect(e[device]!.components.DeviceList).toBeUndefined();
        }
        expect(p.devices).toEqual(
            fork === "upstream"
                ? { linkFormat: "struct", deviceListBackReference: "LinkedDeviceNetwork" }
                : { linkFormat: "tuple", deviceListBackReference: "DeviceNetwork" },
        );
        expect(p.tileDensity).toBe(fork === "upstream" ? 800 : 0.5);
        expect(e.WallSolid!.mass).toBe(1000);
        expect(p.tiles.FloorSteel!.mass).toBe(800);
    });

    it.skipIf(!pack)("keeps placement replacement keys", () => {
        const e = pack!.prototypes.entities;
        expect(e.WallSolid!.components.PlacementReplacement).toEqual({ key: "walls" });
        expect(e.Airlock!.components.PlacementReplacement).toEqual({ key: "walls" });
        if (fork === "upstream") expect(e.Grille!.components.PlacementReplacement).toEqual({ key: "grilles" });
        expect(e.Table?.components.PlacementReplacement).toBeUndefined();
    });

    it.skipIf(!pack)("keeps container kinds and says which prototypes the game fills", async () => {
        const data = (await pack!.prototypeData())!;
        const full = pack!.fullComponents(data, "LockerEngineer");
        expect(full.ContainerContainer?.containers).toMatchObject({ entity_storage: { "!type": "Container" } });
        for (const p of Object.values(data.entities)) {
            for (const def of Object.values((p.components.ContainerContainer?.containers as Record<string, unknown>) ?? {})) expect(def, "container kinds").toMatchObject({ "!type": expect.stringMatching(/^Container(Slot)?$/) });
        }
        const e = pack!.prototypes.entities;
        expect(e.LockerEngineerFilled).toMatchObject({ fills: true, plainBase: "LockerEngineer" });
        expect(e.LockerEngineer!.fills).toBeUndefined();
        for (const [id, p] of Object.entries(e)) {
            if (!p.plainBase) continue;
            expect(p.fills, id).toBe(true);
            expect(e[p.plainBase], `${id} → ${p.plainBase}`).toBeDefined();
            expect(e[p.plainBase]!.fills, `${p.plainBase} fills`).toBeUndefined();
        }
    });

    it.skipIf(!pack)("has item sizes, entity storage defaults and bounds", async () => {
        const rules = (await pack!.containerRules())!;
        expect(rules.itemSizes.Small).toEqual({ weight: 2, shape: ["0,0,0,1"] });
        expect(rules.itemSizes.Normal!.weight).toBeGreaterThan(rules.itemSizes.Small!.weight);
        expect(rules.defaultItemSize).toBe("Small");
        expect(rules.defaultStorageMaxItemSize).toBe("Normal");
        // upstream's EntityStorage has a blacklist, the older forks' does not
        expect(rules.entityStorage).toEqual({ capacity: 30, maxSize: 1, whitelist: { components: ["MobState", "Item"] }, blacklist: fork === "upstream" });
        expect(Math.max(...Object.values(rules.bounds).map((b) => Math.max(...b)))).toBeGreaterThan(1);
    });

    it.skipIf(!pack)("marks space-like tiles (isSpace)", () => {
        const t = pack!.prototypes.tiles;
        expect(t.Space!.isSpace).toBe(true);
        expect(t.Lattice!.isSpace).toBe(true);
        expect(t.Plating!.isSpace).toBeUndefined();
        expect(t.FloorSteel!.isSpace).toBeUndefined();
    });
});

describe("container data", () => {
    it("keeps container kinds written without fields and leaves other empty tags alone", () => {
        const game = new Checkout(root);
        const boxes = (game.entity("Locker").components.ContainerContainer as Raw).containers as Raw;
        expect(boxes.entity_storage).toEqual({ "!type": "Container" });
        expect(boxes.paper_label).toEqual({ "!type": "ContainerSlot" });
        expect(boxes.ammo).toEqual({ "!type": "Container", showEnts: true });
        expect(game.entity("LockerFilled").components.EntityTableContainerFill).toMatchObject({ containers: { entity_storage: { "!type": "NestedSelector" } } });
    });

    it("maps filling prototypes to the nearest plain ancestor that is not abstract", () => {
        const data = new ContainerData(new Checkout(root));
        expect(data.fills("Locker")).toEqual({ fills: false });
        expect(data.fills("LockerFilled")).toEqual({ fills: true, plainBase: "Locker" });
        expect(data.fills("LockerFilledRare")).toEqual({ fills: true, plainBase: "Locker" });
        // its only plain ancestor is abstract: nothing to offer
        expect(data.fills("OnlyAbstractBase")).toEqual({ fills: true });
    });

    it("reads item sizes, entity storage defaults from C# and the bounds of fixtures", () => {
        const rules = new ContainerData(new Checkout(root)).rules();
        expect(rules.itemSizes).toEqual({ Small: { weight: 2, shape: ["0,0,0,1"] }, Normal: { weight: 4, shape: ["0,0,1,1"] } });
        expect(rules.defaultItemSize).toBe("Small");
        expect(rules.defaultStorageMaxItemSize).toBe("Normal");
        expect(rules.entityStorage).toEqual({ capacity: 30, maxSize: 1, whitelist: { components: ["MobState", "Item"] }, blacklist: true });
        // boxes and polygons count their skin; the union includes the origin; small things are left out
        expect(rules.bounds.Locker).toEqual([0.82, 0.82]);
        expect(rules.bounds.Crate).toEqual([1.71, 1.02]);
        expect(rules.bounds.Pebble).toBeUndefined();
        expect(rules.bounds.LockerBase).toBeUndefined(); // abstract
    });
});

describe("prototype variants", () => {
    it("expands !type:CreateVariants into one prototype per variant", () => {
        const doc = {
            type: "entity",
            id: { __createVariants: { values: ["GasPipeStraight", "GasPipeStraightAlt1"] } },
            categories: { __createVariants: { sequences: [[], ["HideSpawnMenu"]] } },
            components: [{ type: "AtmosPipeLayers", pipeLayer: { __createVariants: { values: [0, 1] } } }],
        };
        expect(expandVariants(doc)).toEqual([
            { type: "entity", id: "GasPipeStraight", categories: [], components: [{ type: "AtmosPipeLayers", pipeLayer: 0 }] },
            { type: "entity", id: "GasPipeStraightAlt1", categories: ["HideSpawnMenu"], components: [{ type: "AtmosPipeLayers", pipeLayer: 1 }] },
        ]);
    });
});

describe("texture pages", () => {
    it("packs the first frame of each direction and every tile variant, deterministically", async () => {
        const out1 = fs.mkdtempSync(path.join(os.tmpdir(), "ss14mapper-pages-"));
        const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "ss14mapper-pages-"));
        const plain = new Map([["Tiles/steel.png", 4]]);
        const a = await packTextures(path.join(root, "Resources/Textures"), plain, out1, []);
        const b = await packTextures(path.join(root, "Resources/Textures"), plain, out2, []);
        expect(a.index).toEqual(b.index);
        expect(a.index.pages.length).toBe(1);

        const rsi = a.index.rsi["Walls/solid.rsi"]!;
        expect(rsi.license).toBe("CC-BY-SA-3.0");
        expect(rsi.states.full).toHaveLength(1);
        expect(rsi.states.dirs).toHaveLength(4);
        expect(a.index.textures["Tiles/steel.png"]).toHaveLength(4);

        // the frame of direction 1 is frame 2 of the strip (direction 0 has two animation frames): red = 2 * 40
        const page = await sharp(path.join(out1, a.index.pages[0]!)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const red = ([, x, y]: number[], dx = 0, dy = 0) => page.data[((y! + dy) * page.info.width + x! + dx) * 4]!;
        expect(red(rsi.states.dirs![1]!)).toBe(80);
        expect(red(rsi.states.dirs![3]!)).toBe(160);
        // tile variant 3 has red 120; the 2 px border repeats the frame's edge
        const v3 = a.index.textures["Tiles/steel.png"]![3]!;
        expect(red(v3)).toBe(120);
        expect(red(v3, -2, -2)).toBe(120);
        expect(red(v3, 33, 31)).toBe(120);

        fs.rmSync(out1, { recursive: true, force: true });
        fs.rmSync(out2, { recursive: true, force: true });
    });
});
