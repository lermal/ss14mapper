// Inspector logic without DOM, and field edits as the panel does them, on real maps.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
import type { ComponentSchemas, FieldSchema } from "../src/pack/format";
import type { Pack } from "../src/pack/loader";
import {
    componentViews,
    editorText,
    effective,
    entryFor,
    fieldViews,
    formatValue,
    sameValue,
    toYaml,
    valueText,
    writeField,
    overrideEntries,
    type FieldView,
} from "../src/ui/inspector-fields";
import { componentNames, filterNames } from "../src/ui/inspector-model";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const file = path.join(corpusRoot(), "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml");
const frontier = packFor("frontier");

describe("names", () => {
    it("filters with prefix matches first", () => {
        const names = ["Door", "AirlockDoor", "Sprite", "Doorstop"];
        expect(filterNames(names, "door")).toEqual(["Door", "Doorstop", "AirlockDoor"]);
        expect(filterNames(names, "", 2)).toEqual(["Door", "AirlockDoor"]);
        expect(filterNames(names, "zzz")).toEqual([]);
    });
    it("lists the pack's component names", () => {
        if (!frontier) return;
        const names = componentNames(frontier);
        expect(names).toContain("Sprite");
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(names).toContain("MetaData");
    });
    it("uses the pack's full list, or falls back to the components of its prototypes", () => {
        const pack = (extra: object) => ({ prototypes: { entities: { A: { name: "a", components: { Sprite: {}, Door: {} } } }, ...extra } }) as unknown as Parameters<typeof componentNames>[0];
        expect(componentNames(pack({ componentNames: ["AirAlarm", "Door", "MetaData"] }))).toEqual(["AirAlarm", "Door", "MetaData"]);
        expect(componentNames(pack({}))).toEqual(["Door", "MetaData", "Sprite"]);
    });
});

const schema = (name: string, kind: FieldSchema["kind"], type: string, def?: string): FieldSchema => ({ name, kind, type, ...(def !== undefined ? { default: def } : {}) });

describe("fields", () => {
    it("lists components of the prototype and the map, sorted, with markers", () => {
        const views = componentViews({ Sprite: {}, Door: {} }, [{ type: "Door" }, { type: "Anchorable" }], { components: { Door: [] }, enums: {}, prototypeIds: {} } as ComponentSchemas);
        expect(views).toEqual([
            { type: "Anchorable", inPrototype: false, overridden: true, known: false },
            { type: "Door", inPrototype: true, overridden: true, known: true },
            { type: "Sprite", inPrototype: true, overridden: false, known: false },
        ]);
    });

    it("takes values from the map, else the prototype, else the default", () => {
        const fields = fieldViews([schema("radius", "float", "float", "5"), schema("energy", "float", "float", "1"), schema("color", "color", "Color", "#FFFFFFFF")], { radius: 3, extra: [1] }, "energy: 2\n# note\ncolor: '#FF0000FF'");
        expect(fields.map((f) => f.name)).toEqual(["color", "energy", "extra", "radius"]);
        const by = Object.fromEntries(fields.map((f) => [f.name, f]));
        expect(effective(by.radius!)).toEqual({ value: 3, source: "prototype" });
        expect(effective(by.energy!)).toEqual({ value: 2, source: "map" });
        expect(effective(by.color!)).toEqual({ value: "#FF0000FF", source: "map" });
        expect(by.color!.override!.text).toBe("'#FF0000FF'");
        expect(by.extra).toMatchObject({ kind: "other", type: "?" });
        expect(editorText(by.color!, "White", { white: [1, 1, 1, 1] })).toBe("#FFFFFFFF");
    });

    it("formats editor values in the game's style", () => {
        const f = (kind: FieldSchema["kind"], type: string) => ({ kind, type });
        expect(formatValue(f("bool", "bool"), true)).toBe("True");
        expect(formatValue(f("float", "float"), "0.1")).toBe("0.1");
        expect(formatValue(f("float", "float"), "1e-5")).toBe("1E-05");
        expect(() => formatValue(f("float", "float"), "abc")).toThrow("Expected a number");
        expect(formatValue(f("int", "int"), "+7")).toBe("7");
        expect(() => formatValue(f("int", "int"), "1.5")).toThrow();
        expect(formatValue(f("angle", "Angle"), "90")).toBe("1.5707963267948966 rad");
        expect(formatValue(f("angle", "Angle"), "0")).toBe("0 rad");
        expect(formatValue(f("vector2", "Vector2"), ["0.5", "-1"])).toBe("0.5,-1");
        expect(formatValue(f("color", "Color"), "#ff330080")).toBe("'#FF330080'");
        expect(formatValue(f("timespan", "TimeSpan"), "500ms")).toBe("0.5");
        expect(formatValue(f("string", "string"), "Bridge")).toBe("Bridge");
        expect(formatValue(f("string", "string"), "a: b")).toBe("'a: b'");
        expect(formatValue(f("entity", "EntityUid"), "")).toBe("invalid");
    });

    it("writes block values as the game does", () => {
        expect(entryFor("tags", "- A\n- B")).toBe("tags:\n- A\n- B");
        expect(entryFor("map", "a: 1\nb: 2")).toBe("map:\n  a: 1\n  b: 2");
        expect(entryFor("sound", "!type:SoundPathSpecifier\npath: /a.ogg")).toBe("sound: !type:SoundPathSpecifier\n  path: /a.ogg");
        expect(entryFor("x", "[]")).toBe("x: []");
        expect(toYaml({ path: "/a.ogg", params: { volume: -2 }, list: ["a", true], [`!type`]: "SoundPathSpecifier" })).toBe("path: /a.ogg\nparams:\n  volume: -2\nlist:\n- a\n- True");
        expect(toYaml([{ "!type": "Foo", a: 1 }, { b: 2, c: 3 }])).toBe("- !type:Foo\n  a: 1\n- b: 2\n  c: 3");
        const [e] = overrideEntries("sound:\n  path: /a.ogg\n  params:\n    volume: 2");
        expect(valueText(e!)).toBe("path: /a.ogg\nparams:\n  volume: 2");
    });

    it("compares values as the game reads them", () => {
        expect(sameValue("bool", "True", true)).toBe(true);
        expect(sameValue("float", "0.50", 0.5)).toBe(true);
        expect(sameValue("color", "#fff", "#FFFFFFFF")).toBe(true);
        expect(sameValue("color", "White", "#FFFFFFFF", { white: [1, 1, 1, 1] })).toBe(true);
        expect(sameValue("angle", "0 rad", 0)).toBe(true);
        expect(sameValue("timespan", "2s", 2)).toBe(true);
        expect(sameValue("other", { a: [1, "x"] }, { a: ["1", "x"], "!type": "T" })).toBe(true);
        expect(sameValue("string", "a", "b")).toBe(false);
    });

    it("hides netsync unless the map overrides it", () => {
        const fields = (over?: string) => fieldViews([schema("netsync", "bool", "bool", "True"), schema("radius", "float", "float", "5")], { netsync: false }, over).map((f) => f.name);
        expect(fields()).toEqual(["radius"]);
        expect(fields("radius: 4")).toEqual(["radius"]);
        expect(fields("netsync: False")).toEqual(["netsync", "radius"]);
    });

    it("keeps only the fields that differ from the prototype", () => {
        const radius: FieldView = { name: "radius", kind: "float", type: "float", proto: 3, default: "5" };
        const energy: FieldView = { name: "energy", kind: "float", type: "float", default: "1" };
        const order = ["color", "energy", "radius"];
        expect(writeField(undefined, radius, "4", order, true)).toBe("radius: 4");
        expect(writeField(undefined, radius, "3", order, true)).toBe(null);
        expect(writeField("radius: 4", radius, "3", order, true)).toBe(null);
        expect(writeField("radius: 4", radius, null, order, false)).toBe("");
        // other fields keep their text (comments too); a new field goes in the schema's order
        expect(writeField("# hi\nradius: 4.0", energy, "2", order, true)).toBe("energy: 2\n# hi\nradius: 4.0");
        expect(writeField("radius: 4.0\nenergy: 2", energy, "1", order, true)).toBe("radius: 4.0");
        expect(writeField("radius: 4.0\nzzz: 1", energy, "3", order, true)).toBe("energy: 3\nradius: 4.0\nzzz: 1");
    });
});

/** A field of the pack's schema with the map's and the prototype's values, as the panel builds it. */
async function field(pack: Pack, doc: MapDocument, uid: number, type: string, name: string): Promise<{ f: FieldView; order: string[]; inPrototype: boolean }> {
    const schemas = (await pack.componentSchemas())!;
    const data = (await pack.prototypeData())!;
    const id = doc.proto(uid)!;
    const proto = { ...pack.fullComponents(data, id) };
    proto.MetaData = { name: pack.prototypes.entities[id]!.name };
    const over = doc.components(uid).find((c) => c.type === type)?.text;
    const f = fieldViews(schemas.components[type], proto[type], over).find((x) => x.name === name)!;
    return { f, order: schemas.components[type]!.map((s) => s.name), inPrototype: type in proto };
}

/** Sets a field like the panel: the override recomputed, removed when nothing differs. */
async function set(pack: Pack, doc: MapDocument, uid: number, type: string, name: string, input: unknown | null): Promise<void> {
    const { f, order, inPrototype } = await field(pack, doc, uid, type, name);
    const over = doc.components(uid).find((c) => c.type === type)?.text;
    const text = writeField(over, f, input === null ? null : formatValue(f, input), order, inPrototype, pack.prototypes.colors);
    if (text === null) {
        if (over !== undefined) doc.removeComponent(uid, type);
    } else if (text !== over) doc.setComponent(uid, type, text);
}

const withSchemas = frontier?.manifest.files.componentSchemas ? frontier : null;

describe.skipIf(!fs.existsSync(file) || !withSchemas)("field edits on barnacle", () => {
    const pack = withSchemas!;
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    /** The map as saved, without the save time (written anew whenever the map changed). */
    const saved = (doc: MapDocument) => doc.serialize().replace(/^  time: .*$/m, text.match(/^  time: .*$/m)?.[0] ?? "");
    const find = (doc: MapDocument, re: RegExp, without: string) => doc.uids().find((u) => re.test(doc.proto(u) ?? "") && doc.components(u).every((c) => c.type !== without))!;

    it("names a door and resets it byte for byte", async () => {
        const doc = new MapDocument(text);
        const uid = find(doc, /^Airlock/, "MetaData");
        expect(uid).toBeDefined();
        await set(pack, doc, uid, "MetaData", "name", "Bridge");
        expect(doc.components(uid).find((c) => c.type === "MetaData")?.text).toBe("name: Bridge");
        await set(pack, doc, uid, "MetaData", "name", null);
        expect(saved(doc)).toBe(text);
        // the prototype's own name is no difference
        await set(pack, doc, uid, "MetaData", "name", pack.prototypes.entities[doc.proto(uid)!]!.name);
        expect(doc.components(uid).find((c) => c.type === "MetaData")).toBeUndefined();
        expect(saved(doc)).toBe(text);
    });

    it("edits light and thruster fields, one undo step each", async () => {
        const doc = new MapDocument(text);
        const data = (await pack.prototypeData())!;
        const lamp = doc.uids().find((u) => doc.proto(u) && "PointLight" in pack.fullComponents(data, doc.proto(u)!) && doc.components(u).every((c) => c.type !== "PointLight"))!;
        const thruster = doc.uids().find((u) => doc.proto(u) && "Thruster" in pack.fullComponents(data, doc.proto(u)!) && doc.components(u).every((c) => c.type !== "Thruster"))!;
        expect(lamp).toBeDefined();
        expect(thruster).toBeDefined();
        await set(pack, doc, lamp, "PointLight", "color", "#FF3300FF");
        await set(pack, doc, lamp, "PointLight", "radius", "7.5");
        expect(doc.components(lamp).find((c) => c.type === "PointLight")?.text).toBe("color: '#FF3300FF'\nradius: 7.5");
        await set(pack, doc, thruster, "Thruster", "thrust", "250");
        expect(doc.components(thruster).find((c) => c.type === "Thruster")?.text).toBe("thrust: 250");
        const { f } = await field(pack, doc, thruster, "Thruster", "thrust");
        expect(effective(f)).toEqual({ value: 250, source: "map" });
        // the prototype's colour again drops the field; the radius stays
        const protoColor = (await field(pack, doc, lamp, "PointLight", "color")).f.proto;
        await set(pack, doc, lamp, "PointLight", "color", editorText({ kind: "color" } as FieldView, protoColor ?? "#FFFFFFFF", pack.prototypes.colors));
        expect(doc.components(lamp).find((c) => c.type === "PointLight")?.text).toBe("radius: 7.5");
        for (let i = 0; i < 4; i++) expect(doc.undo()).not.toBeNull();
        expect(doc.serialize()).toBe(text);
    });

    it("does not list netsync for a component without an override, and lists it when the map sets it", async () => {
        const doc = new MapDocument(text);
        const data = (await pack.prototypeData())!;
        const lamp = doc.uids().find((u) => doc.proto(u) && "PointLight" in pack.fullComponents(data, doc.proto(u)!) && doc.components(u).every((c) => c.type !== "PointLight"))!;
        expect(lamp).toBeDefined();
        const names = async (uid: number, type: string) => {
            const schemas = (await pack.componentSchemas())!;
            const proto = { ...pack.fullComponents(data, doc.proto(uid)!) };
            const over = doc.components(uid).find((c) => c.type === type)?.text;
            return fieldViews(schemas.components[type], proto[type], over).map((f) => f.name);
        };
        expect(await names(lamp, "PointLight")).not.toContain("netsync");
        doc.setComponent(lamp, "PointLight", "netsync: False");
        expect(await names(lamp, "PointLight")).toContain("netsync");
        expect(doc.components(lamp).find((c) => c.type === "PointLight")?.text).toBe("netsync: False");
        doc.undo();
        expect(doc.serialize()).toBe(text);
    });

    it("keeps an added component without fields, and its other fields' text", async () => {
        const doc = new MapDocument(text);
        const data = (await pack.prototypeData())!;
        const uid = doc.uids().find((u) => !!pack.prototypes.entities[doc.proto(u) ?? ""] && !("Rotatable" in pack.fullComponents(data, doc.proto(u)!)))!;
        expect(uid).toBeDefined();
        doc.setComponent(uid, "Rotatable", "");
        await set(pack, doc, uid, "Rotatable", "increment", "45");
        expect(doc.components(uid).find((c) => c.type === "Rotatable")?.text).toBe("increment: 0.7853981633974483 rad");
        // the default (90 degrees) is no difference; the added component stays, without fields
        await set(pack, doc, uid, "Rotatable", "increment", "90");
        expect(doc.components(uid).find((c) => c.type === "Rotatable")?.text).toBe("");
        doc.undo();
        doc.undo();
        doc.undo();
        expect(doc.serialize()).toBe(text);
    });
});
