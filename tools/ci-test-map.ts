// Applies one edit of every kind to a map and writes the result, to check in a fork's CI that the
// game loads maps saved by the editor. Usage: node ci-test-map.mjs <input.yml> <output.yml> [<pack dir>]
// (signal links and device lists are edited only with the fork's pack, e.g. ../ss14mapper-corpus/packs/upstream).
import fs from "node:fs";
import path from "node:path";
import type { DevicePack } from "../src/map/devices";
import { MapDocument } from "../src/map/document";
import { copyParts, pasteClip, remapReferences, type ClipDecal, type ClipTile, type CopyRoot } from "../src/editor/clipboard";

const [input, output, packDir] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: ci-test-map <input.yml> <output.yml> [<pack dir>]");
const source = fs.readFileSync(input, "utf8");
const doc = new MapDocument(source);
const log: string[] = [];

const onGrid = (grid: number) => doc.uids().filter((u) => doc.transform(u).parent === grid);
const grid = doc.grids().reduce((a, b) => (onGrid(b).length > onGrid(a).length ? b : a));
const names = doc.tilemap();
// cables and pipes run under the floor and do not block a wall or a table
const occupied = new Set(
    onGrid(grid)
        .filter((u) => !/^(Cable|GasPipe|Disposal)/.test(doc.proto(u) ?? ""))
        .map((u) => `${Math.floor(doc.transform(u).x)},${Math.floor(doc.transform(u).y)}`),
);
const freeFloors = doc.tiles(grid).filter(({ x, y, tile }) => !occupied.has(`${x},${y}`) && !/Lattice/.test(names.get(tile.id) ?? ""));
if (freeFloors.length < 3) throw new Error("not enough free floor tiles");
const [wallAt, tableAt, paintAt, plateAt] = freeFloors;

// steps that need entities the map does not have (a new, empty shuttle) are skipped with a log line
const pick = (pattern: RegExp, extra: (u: number) => boolean = () => true) =>
    onGrid(grid).find((u) => pattern.test(doc.proto(u) ?? "") && extra(u));

const chair = pick(/^Chair/);
if (chair !== undefined) {
    doc.rotateEntity(chair, doc.transform(chair).rotation + Math.PI);
    log.push(`rotate ${doc.proto(chair)} #${chair} by 180°`);
} else log.push("rotate skipped (no chair)");

// any small item will do; shuttles do not always carry a hand labeler or a configurator
const item = onGrid(grid).find((u) => /HandLabeler|NetworkConfigurator/.test(doc.proto(u) ?? ""));
if (item !== undefined) {
    const t = doc.transform(item);
    doc.moveEntity(item, t.x + 0.25, t.y);
    log.push(`move ${doc.proto(item)} #${item} from ${t.x},${t.y} to ${t.x + 0.25},${t.y}`);
} else log.push("move item skipped (no HandLabeler or NetworkConfigurator on the grid)");

// prefer something with saved contents; "Filled" lockers get theirs when the map starts
const unreferenced = (u: number) => doc.referencesTo([u, ...doc.descendants(u)]).size === 0;
const holder =
    onGrid(grid).find((u) => doc.descendants(u).length > 0 && unreferenced(u)) ?? pick(/Locker|Crate/, unreferenced);
if (holder !== undefined) {
    const contents = doc.descendants(holder);
    doc.deleteEntity(holder);
    log.push(`delete ${doc.proto(holder) ?? "holder"} #${holder} with ${contents.length} entities inside`);
} else log.push("delete skipped (no locker or crate)");

const wall = doc.addEntity("WallSolid", grid, wallAt!.x + 0.5, wallAt!.y + 0.5);
log.push(`place WallSolid #${wall} at tile ${wallAt!.x},${wallAt!.y}`);
const table = doc.addEntity("TableReinforced", grid, tableAt!.x + 0.5, tableAt!.y + 0.5);
log.push(`place TableReinforced #${table} at tile ${tableAt!.x},${tableAt!.y}`);

doc.setTile(grid, paintAt!.x, paintAt!.y, "FloorWhite");
log.push(`paint tile ${paintAt!.x},${paintAt!.y} ${names.get(paintAt!.tile.id)} -> FloorWhite (new in this map)`);
if (plateAt) {
    doc.setTile(grid, plateAt.x, plateAt.y, "Plating");
    log.push(`paint tile ${plateAt.x},${plateAt.y} ${names.get(plateAt.tile.id)} -> Plating`);
}

// a yellow warning line on a free floor, and an existing decal moved and recoloured
const decalAt = freeFloors[4] ?? paintAt!;
const decal = doc.addDecal(grid, "WarnLineN", decalAt.x, decalAt.y, { color: "#FFFF00FF" });
log.push(`place decal WarnLineN #${decal} (yellow) at tile ${decalAt.x},${decalAt.y}`);
const existing = doc.decals(grid)[0];
if (existing && existing.id !== decal) {
    const moved = doc.moveDecal(grid, existing.id, existing.x + 0.25, existing.y);
    doc.setDecalProperties(grid, moved, { color: "#FF0000FF", angle: Math.PI / 2 });
    log.push(`move decal ${existing.proto} #${existing.id} by 0.25 and make it red, turned 90°${moved !== existing.id ? ` (now #${moved})` : ""}`);
}

// component overrides: a name for the chair (added), a pipe colour (replaced)
if (chair !== undefined) {
    doc.setComponent(chair, "MetaData", "name: CI test chair");
    log.push(`rename ${doc.proto(chair)} #${chair} to "CI test chair" (MetaData override)`);
} else log.push("rename skipped (no chair)");
const piped = onGrid(grid).find((u) => doc.components(u).some((c) => c.type === "AtmosPipeColor" && /^color: /.test(c.text)));
if (piped !== undefined) {
    doc.setComponent(piped, "AtmosPipeColor", "color: '#FF00FFFF'");
    log.push(`recolour the pipe ${doc.proto(piped)} #${piped} (AtmosPipeColor override replaced)`);
}

let pasted: number[] = [];
// copy and paste: a signal button with the door it opens, and a locker with things inside, pasted next to the
// grid with new uids (the copies link to each other, the contents stay in the locker)
{
    const near = (a: number, b: number, d: number) => Math.abs(doc.transform(a).x - doc.transform(b).x) <= d && Math.abs(doc.transform(a).y - doc.transform(b).y) <= d;
    let pair: [number, number] | null = null;
    // a button or switch first, else any linked pair
    const sources = onGrid(grid).sort((a, b) => Number(!/Button|Switch|Lever/.test(doc.proto(a) ?? "")) - Number(!/Button|Switch|Lever/.test(doc.proto(b) ?? "")));
    for (const u of sources) {
        const ports = doc.components(u).find((c) => c.type === "DeviceLinkSource")?.data.linkedPorts;
        for (const key of Object.keys((ports as Record<string, unknown>) ?? {})) {
            const target = Number(key);
            if (doc.proto(target) && doc.transform(target).parent === grid && near(u, target, 6)) pair = [u, target];
        }
        if (pair) break;
    }
    // a locker, crate or safe with things saved inside
    const locker = onGrid(grid).find((u) => doc.descendants(u).length >= 2 && doc.components(u).some((c) => c.type === "ContainerContainer"));
    const picked = [...(pair ?? []), ...(locker !== undefined ? [locker] : [])];
    if (picked.length) {
        // the tile boxes round them
        const boxes = picked.map((u) => {
            const t = doc.transform(u);
            return [Math.floor(t.x) - 1, Math.floor(t.y) - 1, Math.floor(t.x) + 1, Math.floor(t.y) + 1] as const;
        });
        const inBox = (x: number, y: number) => boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
        const all = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
        const anchor = [Math.round((all[0]! + all[2]! + 1) / 2), Math.round((all[1]! + all[3]! + 1) / 2)] as const;
        const roots: CopyRoot[] = onGrid(grid)
            .filter((u) => !/^(ChunkEntity)$/.test(doc.proto(u) ?? "") && inBox(Math.floor(doc.transform(u).x), Math.floor(doc.transform(u).y)))
            .map((u) => {
                const t = doc.transform(u);
                return { uid: u, x: t.x - anchor[0], y: t.y - anchor[1], rot: t.rotation };
            });
        const tiles: ClipTile[] = doc
            .tiles(grid)
            .filter((t) => inBox(t.x, t.y))
            .map((t) => ({ x: t.x + 0.5 - anchor[0], y: t.y + 0.5 - anchor[1], name: names.get(t.tile.id) ?? "Space", variant: t.tile.variant, rot: t.tile.rotationMirroring }));
        const decals: ClipDecal[] = doc
            .decals(grid)
            .filter((d) => inBox(Math.floor(d.x + 0.5), Math.floor(d.y + 0.5)))
            .map((d) => ({ proto: d.proto, color: d.color, angle: d.angle, zIndex: d.zIndex, cleanable: d.cleanable, x: d.x + 0.5 - anchor[0], y: d.y + 0.5 - anchor[1], w: 1, h: 1 }));
        const clip = copyParts(doc, { roots, tiles, decals, lattice: "whole" });
        // right of the grid, touching its easternmost column
        const east = Math.max(...doc.tiles(grid).map((t) => t.x));
        const row = doc.tiles(grid).find((t) => t.x === east)!.y;
        const width = all[2]! - all[0]! + 1;
        const r = pasteClip(doc, clip, { grid, anchor: [east + 1 + Math.ceil(width / 2), row], turns: 0 });
        pasted = r.entities;
        log.push(
            `paste ${r.entities.length} entities (${picked.map((u) => `${doc.proto(u)} #${u}`).join(", ")} and what is round them), ${r.tiles.length} tiles, ${r.decals.length} decals ` +
                `east of the grid at ${east + 1},${row}; new uids ${Math.min(...r.entities)}..${Math.max(...r.entities)}, ${r.dropped} links to entities outside the copy dropped`,
        );
    }
}

// signal links and device lists
const devices: { button?: number; alarm?: number; vents?: number[]; links?: string[] } = {};
if (packDir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
    const pack: DevicePack = { prototypes: JSON.parse(fs.readFileSync(path.join(packDir, manifest.files.prototypes), "utf8")) };
    const at = (u: number) => doc.transform(u);
    const distance = (u: number, x: number, y: number) => Math.hypot(at(u).x - x, at(u).y - y);
    const taken = new Set(onGrid(grid).map((u) => `${Math.floor(at(u).x)},${Math.floor(at(u).y)}`));
    const spots = freeFloors.slice(5).filter((f) => !taken.has(`${f.x},${f.y}`));
    const fresh = new Set(pasted);
    const doors = onGrid(grid).filter((u) => !fresh.has(u) && /Airlock/.test(doc.proto(u) ?? "") && doc.signalPorts(u, pack).sink.includes("Toggle"));
    /** Doors within `d` of an entity, nearest first. */
    const doorsNear = (u: number, d: number) => doors.filter((x) => distance(x, at(u).x, at(u).y) < d).sort((a, b) => distance(a, at(u).x, at(u).y) - distance(b, at(u).x, at(u).y));
    // a new signal button on the free floor nearest to an airlock, linked to it by the default links (Pressed -> Toggle)
    let best: { spot: (typeof spots)[number]; door: number; d: number } | null = null;
    for (const spot of spots.slice(0, 400)) {
        for (const door of doors) {
            const d = distance(door, spot.x + 0.5, spot.y + 0.5);
            if (!best || d < best.d) best = { spot, door, d };
        }
    }
    // steps that the map has no room or no devices for are skipped with a log line, so small shuttles still get a test map
    let second: number | undefined;
    if (!best) log.push("signal button skipped (no free floor or no airlock)");
    else {
        const button = doc.addEntity("SignalButton", grid, best.spot.x + 0.5, best.spot.y + 0.5);
        const made = doc.linkDefaults(button, best.door, pack);
        if (made === 0 && doc.canLink(button, best.door, "Pressed", "Toggle", pack).ok) doc.link(button, best.door, "Pressed", "Toggle", pack);
        log.push(`place SignalButton #${button} at tile ${best.spot.x},${best.spot.y} and link ${made ? "defaults" : "Pressed -> Toggle"} to ${doc.proto(best.door)} #${best.door}: ${doc.links(button).map((l) => `${l.sourcePort} -> ${l.sinkPort}`).join(", ")}`);
        // the same button also opens a second airlock (explicit ports)
        second = doorsNear(button, 20).find((d) => d !== best.door && doc.canLink(button, d, "Pressed", "Open", pack).ok);
        if (second !== undefined) {
            doc.link(button, second, "Pressed", "Open", pack);
            log.push(`link SignalButton #${button} Pressed -> Open of ${doc.proto(second)} #${second}`);
        }
        devices.button = button;
        devices.links = doc.links(button).map((l) => `${l.sink}:${l.sourcePort}:${l.sinkPort}`);
    }
    const button = devices.button;
    // an existing source gets one more link, written in the map's own form
    const target = (u: number) => doorsNear(u, 20).find((d) => d !== u && !doc.links(u).some((l) => l.sink === d) && doc.canLink(u, d, doc.links(u)[0]!.sourcePort, "Close", pack).ok);
    const existing = onGrid(grid).find((u) => u !== button && !fresh.has(u) && doc.links(u).length > 0 && target(u) !== undefined);
    if (existing !== undefined) {
        const port = doc.links(existing)[0]!.sourcePort;
        const door = target(existing)!;
        doc.link(existing, door, port, "Close", pack);
        log.push(`link ${doc.proto(existing)} #${existing} ${port} -> Close of ${doc.proto(door)} #${door} (next to its saved links)`);
    }
    // a new air alarm on the next free floor with the two nearest vents in its device list
    // (on a small shuttle the free floor may be used up: the alarm then stands on any floor tile without an anchored entity)
    const alarmAt = spots.find((s) => s !== best?.spot) ?? freeFloors.find((f) => !taken.has(`${f.x},${f.y}`) && f !== best?.spot);
    if (!alarmAt) log.push("air alarm skipped (no free floor)");
    else {
        const alarm = doc.addEntity("AirAlarm", grid, alarmAt.x + 0.5, alarmAt.y + 0.5);
        const vents = onGrid(grid)
            .filter((u) => !fresh.has(u) && /^GasVent(Pump|Scrubber)/.test(doc.proto(u) ?? "") && doc.canAddToDeviceList(alarm, u, pack).ok)
            .sort((a, b) => distance(a, alarmAt.x, alarmAt.y) - distance(b, alarmAt.x, alarmAt.y))
            .slice(0, 2);
        for (const v of vents) doc.addToDeviceList(alarm, v, pack);
        log.push(`place AirAlarm #${alarm} at tile ${alarmAt.x},${alarmAt.y} with ${vents.length ? vents.map((v) => `${doc.proto(v)} #${v}`).join(" and ") : "no vents (none compatible)"} in its device list (back references: ${pack.prototypes.devices?.deviceListBackReference})`);
        devices.alarm = alarm;
        devices.vents = vents;
    }
    // a linked airlock deleted: the links into it go too
    const linkedDoor = doors.find((d) => d !== best?.door && d !== second && doc.linksTo(d).some((l) => l.source !== button && !fresh.has(l.source)) && doc.descendants(d).length === 0);
    if (linkedDoor !== undefined) {
        const from = [...new Set(doc.linksTo(linkedDoor).map((l) => l.source))];
        const name = doc.proto(linkedDoor);
        doc.deleteEntity(linkedDoor);
        if (from.some((u) => doc.links(u).some((l) => l.sink === linkedDoor))) throw new Error("links into a deleted airlock were kept");
        log.push(`delete ${name} #${linkedDoor}; the links into it are removed from ${from.map((u) => `${doc.proto(u)} #${u}`).join(", ")}`);
    }
} else log.push("signal links and device lists skipped (no pack directory given)");

const written = doc.serialize();
// the file reads back, and every entity reference of the pasted copies names an entity in it
const reread = new MapDocument(written);
const allUids = new Map(reread.uids().map((u) => [u, u]));
for (const u of pasted) {
    if (reread.proto(u) !== doc.proto(u)) throw new Error(`pasted entity ${u} did not read back`);
    for (const c of reread.components(u)) {
        if (remapReferences(c.text, allUids).dropped) throw new Error(`pasted entity ${u}: ${c.type} names a missing entity`);
    }
}
if (devices.button !== undefined && reread.links(devices.button).map((l) => `${l.sink}:${l.sourcePort}:${l.sinkPort}`).join() !== devices.links!.join()) throw new Error("the button's links did not read back");
if (devices.alarm !== undefined && reread.deviceList(devices.alarm).join() !== devices.vents!.join()) throw new Error("the air alarm's device list did not read back");
fs.writeFileSync(output, written);
console.log(log.join("\n"));
