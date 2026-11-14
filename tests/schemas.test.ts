// Component data fields read from C# sources, and the full prototype data of real packs.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveComponents } from "../src/pack/prototype-data";
import { Checkout } from "../tools/pack/game";
import { blank, componentSchemas, shortType } from "../tools/pack/schemas";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const colors = new Map<string, readonly number[]>([["white", [1, 1, 1, 1]], ["red", [1, 0, 0, 1]]]);
const schemasOf = (...texts: string[]) => componentSchemas(texts.map((text, i) => ({ file: `F${i}.cs`, text })), colors).schemas;

describe("C# data fields", () => {
    it("blanks comments and string contents, keeping lengths", () => {
        const src = 'var a = "x // y"; // note\n/* c */ int b; char c = \'}\';';
        const { code, masked } = blank(src);
        expect(code.length).toBe(src.length);
        expect(code).toContain('"x // y"');
        expect(code).not.toContain("note");
        expect(masked).not.toContain("x // y");
        expect(masked).not.toContain("}");
    });

    it("shortens types", () => {
        expect(shortType("System.Collections.Generic.Dictionary<string,  Robust.Shared.Maths.Color>?")).toBe("Dictionary<string, Color>?");
    });

    it("reads fields, names, types, defaults, access and required", () => {
        const s = schemasOf(
            `
[Serializable]
public enum DoorState : byte { Closed, Open = 2, [Obsolete] Welded }
[Flags] public enum Layers { None = 0, A = 1 }
[Prototype("tag")] public sealed partial class TagPrototype : IPrototype { }
public abstract partial class SharedFooComponent : Component
{
    [DataField("baseValue"), ViewVariables(VVAccess.ReadWrite)]
    public float Base { get; set; } = 1.5f;
}
[RegisterComponent, NetworkedComponent]
[Access(typeof(FooSystem))]
public sealed partial class FooComponent : SharedFooComponent
{
    // a comment with [DataField] in it
    [DataField] public bool Enabled = true;
    [DataField(required: true)] public string Name = "door \\"x\\"";
    [ViewVariables] [DataField] public DoorState State = DoorState.Open;
    [DataField] public Layers Mask;
    [DataField] public Color Light = Color.Red;
    [DataField] public Color Hex = Color.FromHex("#102030");
    [DataField] public Vector2 Offset = new(0.5f, -1);
    [DataField] public Angle Rot = Angle.FromDegrees(90);
    [DataField] public TimeSpan Delay = TimeSpan.FromMilliseconds(250);
    [DataField] public EntProtoId? Spawn;
    [DataField] public ProtoId<TagPrototype> Tag = "Wall";
    [DataField("old", customTypeSerializer: typeof(PrototypeIdSerializer<EntityPrototype>))] public string Old = "Foo";
    [DataField] public List<EntProtoId> Items = new();
    [DataField] public Dictionary<string, int> Counts = new() { };
    [DataField] public SoundSpecifier Sound = new SoundPathSpecifier("/a.ogg");
    [DataField] public int Count { get; private set; }
    [DataField] public required uint Limit;
    public float NotData = 3;
    [DataField] public static int Never;
    public void Method([DataField] int x) { }
    [DataField] public DamageSpecifier? Damage;
}
[RegisterComponent, ComponentProtoName("Renamed")]
public sealed partial class OtherComponent : Component;
`,
        );
        const foo = Object.fromEntries(s.components.Foo!.map((f) => [f.name, f]));
        expect(Object.keys(foo)).toEqual(["baseValue", "enabled", "name", "state", "mask", "light", "hex", "offset", "rot", "delay", "spawn", "tag", "old", "items", "counts", "sound", "count", "limit", "damage"]);
        expect(foo.baseValue).toEqual({ name: "baseValue", type: "float", kind: "float", default: "1.5", vv: "rw" });
        expect(foo.enabled).toMatchObject({ kind: "bool", default: "True" });
        expect(foo.name).toMatchObject({ kind: "string", default: 'door "x"', required: true });
        expect(foo.state).toMatchObject({ kind: "enum", enum: "DoorState", default: "Open", vv: "r" });
        expect(s.enums.DoorState).toEqual({ members: ["Closed", "Open", "Welded"] });
        expect(foo.mask).toMatchObject({ kind: "other" });
        expect(foo.light).toMatchObject({ kind: "color", default: "#FF0000FF" });
        expect(foo.hex!.default).toBe("#102030FF");
        expect(foo.offset).toMatchObject({ kind: "vector2", default: "0.5,-1" });
        expect(foo.rot).toMatchObject({ kind: "angle", default: "1.5707963267948966 rad" });
        expect(foo.delay).toMatchObject({ kind: "timespan", default: "0.25" });
        expect(foo.spawn).toMatchObject({ kind: "proto", proto: "entity" });
        expect(foo.spawn!.default).toBeUndefined();
        expect(foo.tag).toMatchObject({ kind: "proto", proto: "tag", default: "Wall" });
        expect(foo.old).toMatchObject({ kind: "proto", proto: "entity", default: "Foo" });
        expect(foo.items).toMatchObject({ kind: "list", type: "List<EntProtoId>", default: "[]" });
        expect(foo.counts).toMatchObject({ kind: "dict", default: "{}" });
        expect(foo.sound).toMatchObject({ kind: "sound" });
        expect(foo.count).toMatchObject({ kind: "int", default: "0" });
        expect(foo.limit).toMatchObject({ kind: "int", required: true });
        expect(foo.damage).toMatchObject({ kind: "other", type: "DamageSpecifier?" });
        expect(s.components.Renamed).toEqual([]);
        expect(s.components.SharedFoo).toBeUndefined();
    });
});

const kinds = (fork: string) => {
    const pack = packFor(fork);
    return pack?.manifest.files.componentSchemas ? pack : null;
};

describe.each(["upstream", "frontier", "goob"])("schemas of %s", (fork) => {
    const pack = kinds(fork);
    it.skipIf(!pack)("has the fields of content and engine components", async () => {
        const s = (await pack!.componentSchemas())!;
        const field = (c: string, f: string) => s.components[c]?.find((x) => x.name === f);
        expect(field("MetaData", "name")).toMatchObject({ kind: "string" });
        expect(field("MetaData", "desc")).toMatchObject({ kind: "string" });
        expect(field("PointLight", "color")).toMatchObject({ kind: "color", default: "#FFFFFFFF" });
        expect(field("PointLight", "radius")).toMatchObject({ kind: "float", default: "5" });
        expect(field("Thruster", "thrust")).toMatchObject({ kind: "float", type: "float" });
        expect(field("Transform", "rot")).toMatchObject({ kind: "angle" });
        expect(field("Door", "state")).toMatchObject({ kind: "enum", enum: "DoorState", default: "Closed" });
        expect(s.enums.DoorState!.members).toEqual(expect.arrayContaining(["Closed", "Open", "Opening"]));
        expect(field("Door", "openSound")).toMatchObject({ kind: "sound" });
        expect(field("Door", "bumpOpen")).toMatchObject({ kind: "bool", default: "True" });
        expect(field("Airlock", "autoClose")).toMatchObject({ kind: "bool" });
        expect(Object.keys(s.prototypeIds).length).toBeGreaterThan(10);
        expect(field("Thruster", "machinePartThrust") ?? field("Door", "pryingQuality")).toMatchObject({ kind: "proto" });
        // every registered component has an entry
        // (the name list also has classes inside commented-out files, which the schema reader skips)
        const missing = (pack!.prototypes.componentNames ?? []).filter((name) => !s.components[name]);
        expect(missing.length).toBeLessThan(10);
    });

    it.skipIf(!pack)("has every prototype's own components and resolves inheritance", async () => {
        const data = (await pack!.prototypeData())!;
        const comps = pack!.fullComponents(data, "AirlockGlass");
        expect(Object.keys(comps)).toEqual(expect.arrayContaining(["Door", "Airlock", "Sprite", "Physics", "AccessReader"]));
        // the pack's drawing subset is a part of the full data
        for (const [type, fields] of Object.entries(pack!.prototypes.entities.AirlockGlass!.components)) {
            expect(comps[type], type).toBeDefined();
            for (const k of Object.keys(fields)) if (type !== "Paper" && type !== "NodeContainer") expect(comps[type]![k], `${type}.${k}`).toEqual((fields as Record<string, unknown>)[k]);
        }
        expect(data.entities.AirlockGlass!.description).toBeTruthy();
        expect(data.entities.BaseStructure?.abstract).toBe(true);
    });
});

const upstream = path.join(corpusRoot(), "upstream");
describe.skipIf(!fs.existsSync(path.join(upstream, "Resources/Prototypes")) || !kinds("upstream"))("full data against the checkout", () => {
    it("resolves like the builder", async () => {
        const game = new Checkout(upstream);
        const data = (await kinds("upstream")!.prototypeData())!;
        const cache = new Map();
        let n = 0;
        for (const id of [...game.all("entity").keys()].filter((_, i) => i % 7 === 0)) {
            const want = Object.fromEntries(Object.entries(game.entity(id).components).map(([t, { type: _t, ...f }]) => [t, f]));
            expect(resolveComponents(data, id, cache), id).toEqual(want);
            n++;
        }
        expect(n).toBeGreaterThan(1000);
    }, 120_000);
});
