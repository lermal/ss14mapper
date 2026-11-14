// Writes a new, empty shuttle or map file in the shape the game saves, to check in a fork's CI that the game loads it.
// Usage: new-map --pack <pack dir> --kind shuttle|map --name <name> [--floor Plating:5x3] --out <file.yml>
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { newMapText } from "../src/map/new-map";
import { Pack } from "../src/pack/loader";

const usage = "usage: new-map --pack <pack dir> --kind shuttle|map --name <name> [--floor <Tile>:<W>x<H>] --out <file.yml>";
const { values } = parseArgs({
    options: { pack: { type: "string" }, kind: { type: "string" }, name: { type: "string" }, floor: { type: "string" }, out: { type: "string" } },
});
if (!values.pack || !values.name || !values.out || (values.kind !== "shuttle" && values.kind !== "map")) throw new Error(usage);

const read = (name: string) => JSON.parse(fs.readFileSync(path.join(values.pack!, name), "utf8"));
const manifest = read("manifest.json");
const pack = Pack.fromData(manifest, read(manifest.files.prototypes), read(manifest.files.textures));

let floor: { tile: string; width: number; height: number } | undefined;
if (values.floor) {
    const m = /^(\w+):(\d+)x(\d+)$/.exec(values.floor);
    if (!m) throw new Error(`bad --floor "${values.floor}", expected <Tile>:<W>x<H>, e.g. Plating:5x3`);
    floor = { tile: m[1]!, width: Number(m[2]), height: Number(m[3]) };
}

const text = newMapText({ kind: values.kind, name: values.name, pack, floor });
fs.writeFileSync(values.out, text);
console.log(`wrote ${values.out}: ${values.kind} "${values.name}" for ${manifest.fork.id}${floor ? `, floor ${floor.tile} ${floor.width}x${floor.height}` : ""}`);
