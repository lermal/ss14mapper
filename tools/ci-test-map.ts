// Applies one edit of every kind to a map and writes the result, to check in a fork's CI that the
// game loads maps saved by the editor. Usage: node ci-test-map.mjs <input.yml> <output.yml>
import fs from "node:fs";
import { MapDocument } from "../src/map/document";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: ci-test-map <input.yml> <output.yml>");
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

const pick = (pattern: RegExp, extra: (u: number) => boolean = () => true) => {
    const uid = onGrid(grid).find((u) => pattern.test(doc.proto(u) ?? "") && extra(u));
    if (uid === undefined) throw new Error(`no entity matching ${pattern}`);
    return uid;
};

const chair = pick(/^Chair/);
doc.rotateEntity(chair, doc.transform(chair).rotation + Math.PI);
log.push(`rotate ${doc.proto(chair)} #${chair} by 180°`);

const item = pick(/HandLabeler|NetworkConfigurator/);
const t = doc.transform(item);
doc.moveEntity(item, t.x + 0.25, t.y);
log.push(`move ${doc.proto(item)} #${item} from ${t.x},${t.y} to ${t.x + 0.25},${t.y}`);

// prefer something with saved contents; "Filled" lockers get theirs when the map starts
const unreferenced = (u: number) => doc.referencesTo([u, ...doc.descendants(u)]).size === 0;
const holder =
    onGrid(grid).find((u) => doc.descendants(u).length > 0 && unreferenced(u)) ?? pick(/Locker|Crate/, unreferenced);
const contents = doc.descendants(holder);
doc.deleteEntity(holder);
log.push(`delete ${doc.proto(holder) ?? "holder"} #${holder} with ${contents.length} entities inside`);

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

fs.writeFileSync(output, doc.serialize());
console.log(log.join("\n"));
