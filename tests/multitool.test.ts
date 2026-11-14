// Multitool rules: what can be held, which end is the source, when a click toggles a device list and when it
// links, the linking panel's model, refusals with their reasons, and the lines drawn for one entity.
import { describe, expect, it } from "vitest";
import type { DevicePack } from "../src/map/devices";
import { MapDocument } from "../src/map/document";
import type { EntityPrototype } from "../src/pack/format";
import { canHold, entityLabel, isConfigurator, linkable, linkDirection, linkLines, linkPanel, relations, secondClick, toggleDevice, togglePair } from "../src/editor/multitool";

const proto = (name: string, components: EntityPrototype["components"], ports?: EntityPrototype["ports"]): EntityPrototype => ({ name, components, ...(ports ? { ports } : {}) });
const NET = { deviceNetId: "AtmosDevices" };

const pack: DevicePack = {
    prototypes: {
        migrations: {},
        devices: { linkFormat: "struct", deviceListBackReference: "LinkedDeviceNetwork" },
        ports: {
            source: {
                Pressed: { name: "Pressed", description: "Sent when pressed", defaultLinks: ["Toggle", "Trigger"] },
                DoorStatus: { name: "Door status", defaultLinks: ["DoorBolt"] },
                AirDanger: { name: "Danger", defaultLinks: ["Close"] },
                Timer: { name: "Timer" },
            },
            sink: Object.fromEntries(["Toggle", "Open", "Close", "DoorBolt", "Trigger"].map((p) => [p, { name: p }])),
        },
        entities: {
            SignalButton: proto("signal button", { DeviceNetwork: { deviceNetId: "Wireless" }, DeviceLinkSource: {} }, { source: ["Pressed"] }),
            Airlock: proto("airlock", { DeviceNetwork: { deviceNetId: "Wireless" }, DeviceLinkSink: {}, DeviceLinkSource: {} }, { source: ["DoorStatus"], sink: ["Open", "Close", "Toggle", "DoorBolt"] }),
            DoorOnly: proto("door", { DeviceLinkSink: {} }, { sink: ["Open", "Close", "Toggle"] }),
            AirAlarm: proto("air alarm", { DeviceNetwork: NET, DeviceList: {}, DeviceLinkSource: {} }, { source: ["AirDanger"] }),
            Firelock: proto("firelock", { DeviceNetwork: NET, DeviceLinkSink: {} }, { sink: ["Open", "Close", "Toggle"] }),
            GasVentPump: proto("vent", { DeviceNetwork: NET }),
            TimerOnly: proto("timer", { DeviceLinkSource: {} }, { source: ["Timer"] }),
            Lamp: proto("lamp", {}),
        },
    },
};

function smallMap(groups: Array<[string, Array<[number, number, number]>]>): string {
    const lines = ["meta:", "  format: 7", "  entityCount: 0", "tilemap:", "  0: Space", "entities:", '- proto: ""', "  entities:", "  - uid: 1", "    components:", "    - type: MetaData", "      name: grid", "    - type: Transform", "      parent: invalid", "    - type: MapGrid", "      chunks: {}"];
    for (const [p, list] of groups) {
        lines.push(`- proto: ${p}`, "  entities:");
        for (const [uid, x, y] of list) lines.push(`  - uid: ${uid}`, "    components:", "    - type: Transform", `      pos: ${x},${y}`, "      parent: 1");
    }
    return lines.join("\n") + "\n...\n";
}

const BASE = smallMap([
    ["AirAlarm", [[2, 0.5, 0.5]]],
    ["Airlock", [[3, 2.5, 0.5], [4, 60.5, 0.5]]],
    ["DoorOnly", [[5, 3.5, 0.5]]],
    ["Firelock", [[6, 4.5, 0.5]]],
    ["GasVentPump", [[7, 1.5, 1.5], [8, 2.5, 1.5]]],
    ["Lamp", [[9, 0.5, 2.5]]],
    ["SignalButton", [[11, 1.5, 0.5]]],
    ["TimerOnly", [[12, 5.5, 0.5]]],
]);

describe("holding", () => {
    const doc = new MapDocument(BASE);
    it("holds entities with ports or a device list", () => {
        expect(canHold(doc, 11, pack).ok).toBe(true);
        expect(canHold(doc, 5, pack).ok).toBe(true); // sink ports only: the other end becomes the source
        expect(canHold(doc, 2, pack).ok).toBe(true);
        expect(canHold(doc, 7, pack)).toEqual({ ok: false, reason: "vent (GasVentPump #7) has no signal ports and no device list" });
        expect(canHold(doc, 99, pack)).toEqual({ ok: false, reason: "No entity 99" });
    });
    it("picks only devices", () => {
        expect([2, 3, 7, 11].every((u) => linkable(doc, u, pack))).toBe(true);
        expect(linkable(doc, 9, pack)).toBe(false);
        expect(isConfigurator(doc, 2, pack)).toBe(true);
        expect(isConfigurator(doc, 3, pack)).toBe(false);
    });
    it("labels entities", () => {
        expect(entityLabel(doc, 11, pack)).toBe("signal button (SignalButton #11)");
    });
});

describe("which end is the source", () => {
    const doc = new MapDocument(BASE);
    it("keeps the first clicked as the source when it can be", () => {
        expect(linkDirection(doc, 11, 3, pack)).toEqual({ source: 11, sink: 3, reversible: false });
        expect(secondClick(doc, 11, 3, pack)).toEqual({ kind: "link", source: 11, sink: 3, reversible: false });
    });
    it("swaps when only the second has source ports", () => {
        expect(secondClick(doc, 5, 11, pack)).toEqual({ kind: "link", source: 11, sink: 5, reversible: false });
    });
    it("lets the direction be swapped when both have source and sink ports", () => {
        const two = new MapDocument(smallMap([["Airlock", [[3, 2.5, 0.5], [13, 3.5, 0.5]]]]));
        expect(secondClick(two, 3, 13, pack)).toEqual({ kind: "link", source: 3, sink: 13, reversible: true });
        expect(linkPanel(two, 3, 13, pack).reversible).toBe(true);
    });
    it("refuses ends that cannot be linked, with the reason", () => {
        expect(secondClick(doc, 11, 12, pack)).toEqual({ kind: "refuse", reason: "TimerOnly #12 has no sink ports" });
        expect(secondClick(doc, 11, 11, pack)).toEqual({ kind: "release" });
    });
});

describe("device lists", () => {
    it("toggles a device in the held configurator's list", () => {
        const doc = new MapDocument(BASE);
        expect(secondClick(doc, 2, 7, pack)).toEqual({ kind: "list", config: 2, device: 7, member: false });
        expect(toggleDevice(doc, 2, 7, pack)).toEqual({ done: "added" });
        expect(toggleDevice(doc, 2, 8, pack)).toEqual({ done: "added" });
        expect(doc.deviceList(2)).toEqual([7, 8]);
        expect(secondClick(doc, 2, 7, pack)).toEqual({ kind: "list", config: 2, device: 7, member: true });
        expect(toggleDevice(doc, 2, 7, pack)).toEqual({ done: "removed" });
        expect(doc.deviceList(2)).toEqual([8]);
        expect(relations(doc, 8).lists).toEqual([2]);
    });
    it("toggles the held device in a clicked configurator's list when they cannot be linked", () => {
        const doc = new MapDocument(BASE);
        expect(secondClick(doc, 6, 2, pack)).toEqual({ kind: "link", source: 2, sink: 6, reversible: false }); // linking first
        expect(secondClick(doc, 2, 6, pack)).toEqual({ kind: "list", config: 2, device: 6, member: false }); // the configurator held: its list
        expect(secondClick(doc, 2, 6, pack, true)).toEqual({ kind: "link", source: 2, sink: 6, reversible: false }); // Shift: link
    });
    it("links instead when the device cannot join the list but can be linked", () => {
        const doc = new MapDocument(BASE);
        // the button is on another network; the alarm has no sink ports, but the door does
        expect(secondClick(doc, 2, 3, pack)).toEqual({ kind: "link", source: 2, sink: 3, reversible: false });
    });
    it("surfaces the list's refusal when nothing else applies", () => {
        const doc = new MapDocument(BASE);
        expect(secondClick(doc, 2, 11, pack)).toEqual({ kind: "refuse", reason: "SignalButton #11 is on the Wireless network, not AtmosDevices" });
        expect(toggleDevice(doc, 2, 11, pack)).toEqual({ reason: "SignalButton #11 is on the Wireless network, not AtmosDevices" });
        expect(secondClick(doc, 2, 9, pack)).toEqual({ kind: "refuse", reason: "Lamp #9 is not on a device network" });
    });
});

describe("linking panel", () => {
    it("lists ports with their names and the links between the two", () => {
        const doc = new MapDocument(BASE);
        const m = linkPanel(doc, 11, 3, pack);
        expect(m.sourcePorts).toEqual([{ id: "Pressed", name: "Pressed", description: "Sent when pressed" }]);
        expect(m.sinkPorts.map((p) => p.id)).toEqual(["Open", "Close", "Toggle", "DoorBolt"]);
        expect(m.links).toEqual([]);
        expect(m.blocked).toBeNull();
        expect(togglePair(doc, 11, 3, "Pressed", "Toggle", pack)).toEqual({ done: "linked" });
        expect(linkPanel(doc, 11, 3, pack).links).toEqual([{ sourcePort: "Pressed", sinkPort: "Toggle" }]);
        expect(togglePair(doc, 11, 3, "Pressed", "Toggle", pack)).toEqual({ done: "unlinked" });
        expect(doc.links(11)).toEqual([]);
        expect(togglePair(doc, 11, 3, "Pressed", "Trigger", pack)).toEqual({ reason: 'Airlock #3 has no sink port "Trigger" (it has Open, Close, Toggle, DoorBolt)' });
    });
    it("says why nothing links when out of range", () => {
        const doc = new MapDocument(BASE);
        const m = linkPanel(doc, 11, 4, pack);
        expect(m.blocked).toBe("Airlock #4 is out of range (59.0 m, at most 30 m)");
        expect(togglePair(doc, 11, 4, "Pressed", "Toggle", pack)).toEqual({ reason: m.blocked });
    });
});

describe("lines of one entity", () => {
    it("groups pairs by entity and adds device list lines", () => {
        const doc = new MapDocument(BASE);
        doc.link(11, 3, "Pressed", "Toggle", pack);
        doc.link(11, 3, "Pressed", "Open", pack);
        doc.link(11, 5, "Pressed", "Close", pack);
        doc.link(2, 3, "AirDanger", "Close", pack);
        doc.addToDeviceList(2, 7, pack);
        expect(linkLines(relations(doc, 11), 11)).toEqual([
            { kind: "signal", from: 11, to: 3, pairs: [["Pressed", "Toggle"], ["Pressed", "Open"]] },
            { kind: "signal", from: 11, to: 5, pairs: [["Pressed", "Close"]] },
        ]);
        expect(linkLines(relations(doc, 3), 3).map((l) => `${l.from}>${l.to}`).sort()).toEqual(["11>3", "2>3"]);
        expect(linkLines(relations(doc, 2), 2)).toEqual([
            { kind: "signal", from: 2, to: 3, pairs: [["AirDanger", "Close"]] },
            { kind: "device", from: 2, to: 7, pairs: [] },
        ]);
        expect(linkLines(relations(doc, 7), 7)).toEqual([{ kind: "device", from: 2, to: 7, pairs: [] }]);
    });
});
