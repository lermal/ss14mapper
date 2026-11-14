// Signal links and device lists: read in every stored form, written as the game writes them, undone byte for
// byte, and cleaned up when the entities they name are deleted.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chooseLinkForm, defaultPairs, type DevicePack } from "../src/map/devices";
import { MapDocument } from "../src/map/document";
import type { DeviceStorage, EntityPrototype } from "../src/pack/format";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
const NOW = new Date(2026, 10, 14, 12, 0, 0);
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
const has = (f: string) => fs.existsSync(path.join(root, f));

const BOX = "upstream/Resources/Maps/box.yml"; // struct pairs
const LAVA_BRIG = "upstream/Resources/Maps/Dungeon/lava_brig.yml"; // upstream map with tuple pairs
const MEDIUM_DOCK = "upstream/Resources/Maps/Salvage/medium-dock.yml"; // legacy `- Pressed: Toggle`
const SUSHI = "upstream/Resources/Maps/sushi.yml"; // LinkedDeviceNetwork back references
const AMBER = "frontier/Resources/Maps/amber.yml"; // tuple pairs
const BAGEL = "upstream/Resources/Maps/Dungeon/RandomMap/bagelrandom.yml"; // old DeviceNetwork.deviceLists
const BARNACLE = "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml"; // DeviceNetwork.deviceLists

/** Lines that differ between two files, ignoring meta.time; common start and end are skipped. */
function changed(before: string, after: string): { removed: string[]; added: string[] } {
    const strip = (s: string) => s.split("\n").filter((l) => !/^  time: /.test(l));
    const a = strip(before);
    const b = strip(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let end = 0;
    while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

function undoAll(doc: MapDocument): void {
    while (doc.canUndo) doc.undo();
}

// ---------------------------------------------------------------------------------------------
// A small map and pack

const proto = (components: EntityPrototype["components"], ports?: EntityPrototype["ports"]): EntityPrototype => ({ name: "x", components, ...(ports ? { ports } : {}) });
const NET = { deviceNetId: "AtmosDevices" };

function fakePack(devices: DeviceStorage): DevicePack {
    return {
        prototypes: {
            migrations: { OldButton: "SignalButton" },
            devices,
            ports: {
                source: {
                    Pressed: { name: "Pressed", defaultLinks: ["Toggle", "Trigger", "Timer"] },
                    DoorStatus: { name: "Door status", defaultLinks: ["DoorBolt"] },
                    DoorBoltStatus: { name: "Bolt status" },
                    AirDanger: { name: "Danger", defaultLinks: ["Close"] },
                },
                sink: Object.fromEntries(["Toggle", "Open", "Close", "AutoClose", "DoorBolt", "Trigger"].map((p) => [p, { name: p }])),
            },
            entities: {
                SignalButton: proto({ DeviceNetwork: { deviceNetId: "Wireless" }, DeviceLinkSource: {} }, { source: ["Pressed"] }),
                Airlock: proto({ DeviceNetwork: { deviceNetId: "Wireless" }, DeviceLinkSink: {}, DeviceLinkSource: {} }, { source: ["DoorStatus"], sink: ["Open", "Close", "Toggle", "AutoClose", "DoorBolt"] }),
                AirlockBolts: proto({ DeviceLinkSink: {}, DeviceLinkSource: {} }, { source: ["DoorStatus", "DoorBoltStatus"], sink: ["Open", "Close", "Toggle", "AutoClose", "DoorBolt"] }),
                AirAlarm: proto({ DeviceNetwork: NET, DeviceList: {}, DeviceLinkSource: {} }, { source: ["AirDanger"] }),
                SmallAlarm: proto({ DeviceNetwork: NET, DeviceList: { deviceLimit: 1 } }),
                GasVentPump: proto({ DeviceNetwork: NET }),
                Pda: proto({ DeviceNetwork: { ...NET, savableAddress: false } }),
                Lamp: proto({}),
            },
        },
    };
}
const UPSTREAM: DeviceStorage = { linkFormat: "struct", deviceListBackReference: "LinkedDeviceNetwork" };
const FRONTIER: DeviceStorage = { linkFormat: "tuple", deviceListBackReference: "DeviceNetwork" };

function smallMap(groups: Array<[string, Array<[number, number, number, string?]>]>): string {
    const lines = ["meta:", "  format: 7", "  entityCount: 0", "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "      name: grid", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
    for (const [p, list] of groups) {
        lines.push(`- proto: ${p}`, "  entities:");
        for (const [uid, x, y, extra] of list) {
            lines.push(`  - uid: ${uid}`, "    components:", "    - type: Transform", `      pos: ${x},${y}`, "      parent: 1");
            if (extra) lines.push(...extra.split("\n").map((l) => "    " + l));
        }
    }
    return lines.join("\n") + "\n...\n";
}

const BASE = smallMap([
    ["AirAlarm", [[2, 0.5, 0.5]]],
    ["Airlock", [[3, 2.5, 0.5], [4, 3.5, 0.5], [5, 40.5, 0.5]]],
    ["AirlockBolts", [[6, 4.5, 0.5]]],
    ["GasVentPump", [[7, 1.5, 1.5], [8, 2.5, 1.5]]],
    ["Lamp", [[9, 0.5, 2.5]]],
    ["Pda", [[10, 1.5, 2.5]]],
    ["SignalButton", [[11, 1.5, 0.5]]],
    ["SmallAlarm", [[12, 5.5, 0.5]]],
]);

describe("signal links on a small map", () => {
    const pack = fakePack(UPSTREAM);

    it("links a button to a door in the fork's form and undoes byte for byte", () => {
        const doc = new MapDocument(BASE);
        expect(doc.link(11, 3, "Pressed", "Toggle", pack)).toBe(true);
        expect(doc.link(11, 3, "Pressed", "Toggle", pack)).toBe(false);
        expect(doc.link(11, 4, "Pressed", "Open", pack)).toBe(true);
        expect(doc.link(11, 3, "Pressed", "Close", pack)).toBe(true);
        const { added } = changed(BASE, doc.serialize(NOW));
        expect(added).toEqual([
            "    - type: DeviceLinkSource",
            "      linkedPorts:",
            "        3:",
            "        - source: Pressed",
            "          sink: Toggle",
            "        - source: Pressed",
            "          sink: Close",
            "        4:",
            "        - source: Pressed",
            "          sink: Open",
        ]);
        expect(doc.links(11)).toEqual([
            { source: 11, sink: 3, sourcePort: "Pressed", sinkPort: "Toggle" },
            { source: 11, sink: 3, sourcePort: "Pressed", sinkPort: "Close" },
            { source: 11, sink: 4, sourcePort: "Pressed", sinkPort: "Open" },
        ]);
        expect(doc.linksTo(3).map((l) => l.sinkPort)).toEqual(["Toggle", "Close"]);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(BASE);
        expect(doc.links(11)).toEqual([]);
        expect(doc.linksTo(3)).toEqual([]);
        doc.redo();
        expect(doc.linksTo(3)).toEqual([{ source: 11, sink: 3, sourcePort: "Pressed", sinkPort: "Toggle" }]);
    });

    it("sees links written by other edits (component overrides, paste)", () => {
        const doc = new MapDocument(BASE);
        expect(doc.linksTo(3)).toEqual([]);
        doc.setComponent(11, "DeviceLinkSource", "linkedPorts:\n  3:\n  - - Pressed\n    - Open");
        expect(doc.linksTo(3)).toEqual([{ source: 11, sink: 3, sourcePort: "Pressed", sinkPort: "Open" }]);
        doc.deleteEntity(3);
        expect(doc.components(11).map((c) => c.type)).toEqual(["Transform"]);
    });

    it("writes tuples for a fork that reads only tuples", () => {
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Toggle", fakePack(FRONTIER));
        expect(changed(BASE, doc.serialize(NOW)).added).toEqual(["    - type: DeviceLinkSource", "      linkedPorts:", "        3:", "        - - Pressed", "          - Toggle"]);
    });

    it("refuses links the game would drop or refuse", () => {
        const doc = new MapDocument(BASE);
        expect(() => doc.link(11, 3, "Pressed", "Explode", pack)).toThrow(/not a sink port of this fork/);
        expect(() => doc.link(11, 3, "DoorStatus", "Toggle", pack)).toThrow(/SignalButton #11 has no source port "DoorStatus" \(it has Pressed\)/);
        expect(() => doc.link(11, 2, "Pressed", "Toggle", pack)).toThrow(/AirAlarm #2 has no sink ports/);
        expect(() => doc.link(9, 3, "Pressed", "Toggle", pack)).toThrow(/Lamp #9 has no source ports/);
        expect(() => doc.link(11, 5, "Pressed", "Toggle", pack)).toThrow(/out of range \(39\.0 m, at most 30 m\)/);
        expect(() => doc.link(11, 99, "Pressed", "Toggle", pack)).toThrow(/No entity 99/);
        expect(doc.canLink(11, 3, "Pressed", "Open", pack)).toEqual({ ok: true });
        expect(doc.canUndo).toBe(false);
    });

    it("uses ports and range the map's overrides add", () => {
        const source = smallMap([
            ["Airlock", [[3, 50.5, 0.5]]],
            ["SignalButton", [[11, 1.5, 0.5, "- type: DeviceLinkSource\n  range: 60\n  ports:\n  - Pressed\n  - AirDanger"]]],
        ]);
        const doc = new MapDocument(source);
        expect(doc.signalPorts(11, pack).source).toEqual(["Pressed", "AirDanger"]);
        doc.link(11, 3, "AirDanger", "Close", pack);
        expect(changed(source, doc.serialize(NOW)).added).toEqual(["      linkedPorts:", "        3:", "        - source: AirDanger", "          sink: Close"]);
        const lines = doc.serialize(NOW).split("\n");
        const at = lines.indexOf("      range: 60");
        expect(lines.slice(at, at + 3)).toEqual(["      range: 60", "      linkedPorts:", "        3:"]);
    });

    it("follows migrated prototypes", () => {
        const doc = new MapDocument(BASE.replace("- proto: SignalButton", "- proto: OldButton"));
        expect(doc.signalPorts(11, pack).source).toEqual(["Pressed"]);
    });

    it("links defaults as the game does, replacing the links between the two", () => {
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Open", pack);
        expect(doc.linkDefaults(11, 3, pack)).toBe(1);
        expect(doc.links(11)).toEqual([{ source: 11, sink: 3, sourcePort: "Pressed", sinkPort: "Toggle" }]);
        expect(doc.linkDefaults(3, 4, pack)).toBe(1);
        expect(doc.links(3)).toEqual([{ source: 3, sink: 4, sourcePort: "DoorStatus", sinkPort: "DoorBolt" }]);
        // DoorBoltStatus has no default links, so the game links nothing from such a door
        expect(doc.linkDefaults(6, 3, pack)).toBe(0);
        expect(doc.links(6)).toEqual([]);
        expect(defaultPairs(["DoorStatus", "DoorBoltStatus"], ["DoorBolt"], pack)).toEqual([]);
        expect(defaultPairs(["Pressed"], ["Trigger", "Toggle"], pack)).toEqual([["Pressed", "Toggle"], ["Pressed", "Trigger"]]);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(BASE);
    });

    it("unlinks, dropping emptied sinks, fields and components", () => {
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Toggle", pack);
        doc.link(11, 3, "Pressed", "Close", pack);
        doc.link(11, 4, "Pressed", "Open", pack);
        const linked = doc.serialize(NOW);
        expect(doc.unlink(11, 3, "Pressed", "Open")).toBe(false);
        expect(doc.unlink(11, 3, "Pressed", "Toggle")).toBe(true);
        expect(doc.links(11).map((l) => `${l.sink}:${l.sinkPort}`)).toEqual(["3:Close", "4:Open"]);
        expect(doc.unlinkAll(11, 3)).toBe(1);
        expect(doc.links(11).map((l) => `${l.sink}:${l.sinkPort}`)).toEqual(["4:Open"]);
        expect(doc.unlinkAll(11)).toBe(1);
        expect(doc.serialize(NOW)).toBe(BASE);
        expect(doc.unlinkAll(11)).toBe(0);
        doc.undo();
        doc.undo();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(linked);
    });

    it("puts a link removed and added back in its old place, as the game's collections do", () => {
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Toggle", pack);
        doc.link(11, 3, "Pressed", "Close", pack);
        doc.link(11, 4, "Pressed", "Open", pack);
        doc.link(11, 6, "Pressed", "Open", pack);
        const order = () => doc.links(11).map((l) => `${l.sink}:${l.sinkPort}`);
        const linked = order();
        doc.unlink(11, 3, "Pressed", "Toggle");
        doc.link(11, 3, "Pressed", "Toggle", pack);
        doc.unlinkAll(11, 4);
        doc.link(11, 4, "Pressed", "Open", pack);
        expect(order()).toEqual(linked);
        // a new pair of another sink leaves the freed sink slot alone; a new sink takes it
        doc.unlinkAll(11, 4);
        doc.link(11, 6, "Pressed", "Close", pack);
        const door = doc.addEntity("Airlock", 1, 2.5, 2.5);
        doc.link(11, door, "Pressed", "Open", pack);
        doc.link(11, 4, "Pressed", "Open", pack);
        expect(order()).toEqual(["3:Toggle", "3:Close", `${door}:Open`, "6:Open", "6:Close", "4:Open"]);
    });

    it("keeps other fields of the component", () => {
        const source = smallMap([["Airlock", [[3, 2.5, 0.5]]], ["SignalButton", [[11, 1.5, 0.5, "- type: DeviceLinkSource\n  linkedPorts:\n    3:\n    - source: Pressed\n      sink: Open\n  lastSignals:\n    Pressed: True"]]]]);
        const doc = new MapDocument(source);
        doc.unlinkAll(11);
        expect(changed(source, doc.serialize(NOW)).removed).toEqual(["      linkedPorts:", "        3:", "        - source: Pressed", "          sink: Open"]);
    });
});

describe("device lists on a small map", () => {
    it("adds vents with LinkedDeviceNetwork back references (upstream)", () => {
        const pack = fakePack(UPSTREAM);
        const doc = new MapDocument(BASE);
        expect(doc.addToDeviceList(2, 7, pack)).toBe(true);
        expect(doc.addToDeviceList(2, 8, pack)).toBe(true);
        expect(doc.addToDeviceList(2, 8, pack)).toBe(false);
        expect(doc.deviceList(2)).toEqual([7, 8]);
        expect(doc.deviceListsWith(8)).toEqual([2]);
        const out = doc.serialize(NOW);
        const block = (uid: number) => {
            const lines = out.split("\n");
            const at = lines.indexOf(`  - uid: ${uid}`);
            let end = at + 1;
            while (end < lines.length && lines[end]!.startsWith("    ")) end++;
            return lines.slice(at + 2, end);
        };
        expect(block(2)).toEqual(["    - type: Transform", "      pos: 0.5,0.5", "      parent: 1", "    - type: DeviceList", "      devices:", "      - 7", "      - 8"]);
        expect(block(7)).toEqual(["    - type: Transform", "      pos: 1.5,1.5", "      parent: 1", "    - type: LinkedDeviceNetwork", "      deviceLists:", "      - 2", "      configurators: []"]);
        expect(doc.removeFromDeviceList(2, 7, pack)).toBe(true);
        expect(doc.removeFromDeviceList(2, 7, pack)).toBe(false);
        expect(doc.removeFromDeviceList(2, 8, pack)).toBe(true);
        expect(doc.serialize(NOW)).toBe(BASE);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(BASE);
    });

    it("adds vents with DeviceNetwork back references (Frontier)", () => {
        const doc = new MapDocument(BASE);
        const pack = fakePack(FRONTIER);
        doc.addToDeviceList(2, 7, pack);
        const { added } = changed(BASE, doc.serialize(NOW));
        expect(added).toContain("    - type: DeviceNetwork");
        expect(added.join("\n")).toContain("    - type: DeviceNetwork\n      deviceLists:\n      - 2");
        expect(added.join("\n")).not.toContain("LinkedDeviceNetwork");
        doc.removeFromDeviceList(2, 7, pack);
        expect(doc.serialize(NOW)).toBe(BASE);
    });

    it("says why a device cannot be added", () => {
        const pack = fakePack(UPSTREAM);
        const doc = new MapDocument(BASE);
        const why = (config: number, device: number) => {
            const c = doc.canAddToDeviceList(config, device, pack);
            return c.ok ? "ok" : c.reason;
        };
        expect(why(2, 7)).toBe("ok");
        expect(why(2, 2)).toMatch(/own device list/);
        expect(why(11, 7)).toMatch(/SignalButton #11 has no device list/);
        expect(why(2, 9)).toMatch(/Lamp #9 is not on a device network/);
        expect(why(2, 10)).toMatch(/Pda #10 cannot be saved/);
        expect(why(2, 3)).toMatch(/Airlock #3 is on the Wireless network, not AtmosDevices/);
        doc.addToDeviceList(12, 7, pack);
        expect(why(12, 7)).toMatch(/in the list already/);
        expect(why(12, 8)).toMatch(/The list is full \(1 devices\)/);
        expect(() => doc.addToDeviceList(2, 3, pack)).toThrow(/Wireless network/);
    });
});

describe("deleting entities", () => {
    it("removes links into them and list entries naming them, in the same undo step", () => {
        const pack = fakePack(UPSTREAM);
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Toggle", pack);
        doc.link(11, 4, "Pressed", "Open", pack);
        doc.addToDeviceList(2, 7, pack);
        doc.addToDeviceList(2, 8, pack);
        const before = doc.serialize(NOW);
        doc.deleteEntity(3);
        expect(doc.links(11).map((l) => l.sink)).toEqual([4]);
        doc.deleteEntity(7);
        expect(doc.deviceList(2)).toEqual([8]);
        doc.deleteEntity(2);
        expect(doc.components(8).map((c) => c.type)).toEqual(["Transform"]);
        doc.undo();
        doc.undo();
        doc.undo();
        expect(doc.serialize(NOW)).toBe(before);
        expect(doc.linksTo(3).length).toBe(1);
    });

    it("removes the source's own links with it, and nothing else", () => {
        const pack = fakePack(UPSTREAM);
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Toggle", pack);
        doc.deleteEntity(11);
        expect(doc.linksTo(3)).toEqual([]);
        expect(doc.canUndo).toBe(true);
        doc.undo();
        expect(doc.links(11).length).toBe(1);
    });
});

describe("pair form", () => {
    it("is the fork's, or the map's where the fork reads both", () => {
        expect(chooseLinkForm(UPSTREAM, { struct: 0, tuple: 0 })).toBe("struct");
        expect(chooseLinkForm(UPSTREAM, { struct: 0, tuple: 5 })).toBe("tuple");
        expect(chooseLinkForm(UPSTREAM, { struct: 5, tuple: 0 })).toBe("struct");
        expect(chooseLinkForm(FRONTIER, { struct: 5, tuple: 0 })).toBe("tuple");
        expect(chooseLinkForm(undefined, { struct: 0, tuple: 0 })).toBe("struct");
    });
});

// ---------------------------------------------------------------------------------------------
// Maps saved by the game

const upstream = packFor("upstream");
const frontier = packFor("frontier");

/** Takes the last pair of the last sink of every source away and links it again: the file must not change. */
function relinkLast(doc: MapDocument, pack: DevicePack): number {
    let n = 0;
    for (const uid of doc.uids()) {
        const last = doc.links(uid).at(-1);
        if (!last) continue;
        expect(doc.unlink(uid, last.sink, last.sourcePort, last.sinkPort)).toBe(true);
        doc.link(uid, last.sink, last.sourcePort, last.sinkPort, pack);
        n++;
    }
    return n;
}

describe.skipIf(!upstream || !has(BOX))("box (upstream, struct pairs)", () => {
    it("relinks every source's last link to the same text, and undoes byte for byte", () => {
        const source = read(BOX);
        const doc = new MapDocument(source);
        const failures: string[] = [];
        let n = 0;
        for (const uid of doc.uids()) {
            const last = doc.links(uid).at(-1);
            if (!last) continue;
            doc.unlink(uid, last.sink, last.sourcePort, last.sinkPort);
            try {
                doc.link(uid, last.sink, last.sourcePort, last.sinkPort, upstream!);
            } catch (e) {
                failures.push(`${uid}: ${(e as Error).message}`);
            }
            n++;
        }
        expect(n).toBeGreaterThan(100);
        expect(failures).toEqual([]);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: [], added: [] });
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });

    it("reads struct pairs", () => {
        const doc = new MapDocument(read(BOX));
        expect(doc.links(7759)).toEqual([
            { source: 7759, sink: 8943, sourcePort: "DoorStatus", sinkPort: "Close" },
            { source: 7759, sink: 8920, sourcePort: "DoorStatus", sinkPort: "Close" },
        ]);
        expect(doc.linksTo(13910)).toEqual([{ source: 2638, sink: 13910, sourcePort: "Pressed", sinkPort: "Toggle" }]);
    });

    it("links a new button to a door with the defaults", () => {
        const source = read(BOX);
        const doc = new MapDocument(source);
        const door = 13910;
        const t = doc.transform(door);
        const button = doc.addEntity("SignalButton", t.parent!, t.x + 1, t.y);
        expect(doc.linkDefaults(button, door, upstream!)).toBe(1);
        expect(doc.links(button)).toEqual([{ source: button, sink: door, sourcePort: "Pressed", sinkPort: "Toggle" }]);
        expect(doc.serialize(NOW)).toContain(
            [`  - uid: ${button}`, "    components:", "    - type: Transform", `      parent: ${t.parent}`, "      pos: -60.5,-21.5", "    - type: DeviceLinkSource", "      linkedPorts:", `        ${door}:`, "        - source: Pressed", "          sink: Toggle", ""].join("\n"),
        );
        // a second door: a new sink after the first
        const other = doc.uids().find((u) => u !== door && doc.signalPorts(u, upstream!).sink.includes("Open") && doc.canLink(2638, u, "Pressed", "Open", upstream!).ok)!;
        expect(other).toBeDefined();
        doc.link(2638, other, "Pressed", "Open", upstream!);
        expect(doc.links(2638).map((l) => `${l.sink} ${l.sourcePort}>${l.sinkPort}`)).toEqual([`${door} Pressed>Toggle`, `${other} Pressed>Open`]);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });

    it("upstream airlocks link nothing by default: DoorBoltStatus has no default links", () => {
        const doc = new MapDocument(read(BOX));
        expect(upstream!.prototypes.ports!.source.DoorBoltStatus!.defaultLinks).toBeUndefined();
        expect(doc.linkDefaults(7759, 8943, upstream!)).toBe(0);
        expect(doc.canUndo).toBe(false);
    });

    it("deleting a door removes the links into it", () => {
        const source = read(BOX);
        const doc = new MapDocument(source);
        doc.deleteEntity(8920);
        expect(doc.links(7759).map((l) => l.sink)).toEqual([8943]);
        expect(doc.referencesTo([8920]).size).toBe(0);
        doc.undo();
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe.skipIf(!upstream || !has(LAVA_BRIG))("upstream map with tuple pairs", () => {
    it("keeps the map's form", () => {
        const source = read(LAVA_BRIG);
        const doc = new MapDocument(source);
        expect(relinkLast(doc, upstream!)).toBeGreaterThan(0);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: [], added: [] });
    });
});

describe.skipIf(!upstream || !has(MEDIUM_DOCK))("legacy pairs", () => {
    it("are read and kept as they are until their source gets a new link", () => {
        const source = read(MEDIUM_DOCK);
        const doc = new MapDocument(source);
        expect(doc.links(99)).toEqual([96, 97, 98, 87].map((sink) => ({ source: 99, sink, sourcePort: "Pressed", sinkPort: "Toggle" })));
        doc.unlink(99, 98, "Pressed", "Toggle");
        expect(changed(source, doc.serialize(NOW)).removed).toEqual(["        98:", "        - Pressed: Toggle"]);
        doc.link(99, 98, "Pressed", "Toggle", upstream!);
        // the whole source is written again in the map's form (it has no struct or tuple pairs: the fork's)
        const { removed, added } = changed(source, doc.serialize(NOW));
        // (98 goes back into its slot, as the game's dictionary does)
        expect(removed).toEqual(["        - Pressed: Toggle", "        97:", "        - Pressed: Toggle", "        98:", "        - Pressed: Toggle", "        87:", "        - Pressed: Toggle"]);
        expect(added).toEqual([
            "        - source: Pressed", "          sink: Toggle",
            "        97:", "        - source: Pressed", "          sink: Toggle",
            "        98:", "        - source: Pressed", "          sink: Toggle",
            "        87:", "        - source: Pressed", "          sink: Toggle",
        ]);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe.skipIf(!frontier || !has(AMBER))("amber (Frontier, tuple pairs)", () => {
    it("relinks every source's last link to the same text", () => {
        const source = read(AMBER);
        const doc = new MapDocument(source);
        expect(doc.links(183)).toEqual([{ source: 183, sink: 9151, sourcePort: "DoorStatus", sinkPort: "DoorBolt" }]);
        expect(relinkLast(doc, frontier!)).toBeGreaterThan(100);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: [], added: [] });
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe.skipIf(!upstream || !has(SUSHI))("sushi (upstream device lists)", () => {
    it("removes and adds back a vent with its LinkedDeviceNetwork", () => {
        const source = read(SUSHI);
        const doc = new MapDocument(source);
        expect(doc.deviceList(122).at(-1)).toBe(25484);
        expect(doc.removeFromDeviceList(122, 25484, upstream!)).toBe(true);
        expect(doc.components(25484).some((c) => c.type === "LinkedDeviceNetwork")).toBe(false);
        expect(doc.addToDeviceList(122, 25484, upstream!)).toBe(true);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: [], added: [] });
        // a firelock in two lists keeps the other one
        expect(doc.removeFromDeviceList(11443, 14907, upstream!)).toBe(true);
        expect(doc.components(14907).find((c) => c.type === "LinkedDeviceNetwork")?.data).toEqual({ deviceLists: [31], configurators: [] });
        doc.addToDeviceList(11443, 14907, upstream!);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: [], added: [] });
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });

    it("deleting an alarm removes the back references to it", () => {
        const source = read(SUSHI);
        const doc = new MapDocument(source);
        doc.deleteEntity(11443);
        expect(doc.components(14907).find((c) => c.type === "LinkedDeviceNetwork")?.data).toEqual({ deviceLists: [31], configurators: [] });
        expect(doc.referencesTo([11443]).size).toBe(0);
        doc.deleteEntity(25484);
        expect(doc.deviceList(122)).not.toContain(25484);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe.skipIf(!upstream || !has(BAGEL))("upstream map with old DeviceNetwork.deviceLists", () => {
    it("leaves them alone and writes LinkedDeviceNetwork", () => {
        const source = read(BAGEL);
        const doc = new MapDocument(source);
        const device = doc.deviceList(232).at(-1)!;
        expect(doc.components(device).find((c) => c.type === "DeviceNetwork")?.data.deviceLists).toContain(232);
        doc.removeFromDeviceList(232, device, upstream!);
        expect(doc.components(device).find((c) => c.type === "DeviceNetwork")?.data.deviceLists).toContain(232);
        doc.addToDeviceList(232, device, upstream!);
        expect(changed(source, doc.serialize(NOW)).added).toEqual(["    - type: LinkedDeviceNetwork", "      deviceLists:", "      - 232", "      configurators: []"]);
        // deleting the list removes them, so no uid points at nothing
        doc.deleteEntity(232);
        expect(doc.referencesTo([232]).size).toBe(0);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});

describe.skipIf(!frontier || !has(BARNACLE))("barnacle (Frontier device lists)", () => {
    it("removes and adds back a firelock with its DeviceNetwork.deviceLists", () => {
        const source = read(BARNACLE);
        const doc = new MapDocument(source);
        expect(doc.deviceList(3).at(-1)).toBe(110);
        expect(doc.components(110).find((c) => c.type === "DeviceNetwork")?.data).toEqual({ deviceLists: [2, 3] });
        doc.removeFromDeviceList(3, 110, frontier!);
        expect(doc.components(110).find((c) => c.type === "DeviceNetwork")?.data).toEqual({ deviceLists: [2] });
        doc.addToDeviceList(3, 110, frontier!);
        expect(changed(source, doc.serialize(NOW))).toEqual({ removed: [], added: [] });
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });

    it("adds a vent to an alarm", () => {
        const source = read(BARNACLE);
        const doc = new MapDocument(source);
        const vent = doc.uids().find((u) => /^GasVent/.test(doc.proto(u) ?? "") && !doc.deviceList(2).includes(u) && doc.canAddToDeviceList(2, u, frontier!).ok);
        expect(vent).toBeDefined();
        doc.addToDeviceList(2, vent!, frontier!);
        expect(doc.deviceList(2).at(-1)).toBe(vent);
        expect(doc.components(vent!).find((c) => c.type === "DeviceNetwork")?.data.deviceLists).toContain(2);
        undoAll(doc);
        expect(doc.serialize(NOW)).toBe(source);
    });
});
