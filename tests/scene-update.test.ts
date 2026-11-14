// Scenes kept up to date with edits: after every edit, undo and redo the scene must equal one built anew
// from the edited map, and every layer that changed must lie in the areas `apply` reports for redrawing.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
import type { Pack } from "../src/pack/loader";
import { Scene, type Rect } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const root: string = corpusRoot();
/** [fork, map, entities edited per kind, compare with a scene built anew after every step (else only at the end)] */
const MAPS = ([
    ["frontier", "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml", 3, true], // shuttle, format 7
    ["upstream", "upstream/Resources/Maps/box.yml", 1, true], // station, reworked IconSmooth rules
    ["goob", "goob/Resources/Maps/_Goobstation/chloris.yml", 1, false], // largest station of the corpus
] as Array<[string, string, number, boolean]>).filter(([fork, f]) => fs.existsSync(path.join(root, f)) && packFor(fork));

interface Drawn {
    key: string;
    x: number;
    y: number;
    ext: number;
}

/** Everything a scene draws, keyed by what it looks like (frame contents rather than indexes, no draw order). */
function snapshot(scene: Scene): Map<string, Drawn> {
    const frame = (i: number) => scene.frames[i]!.join(":");
    const out = new Map<string, Drawn>();
    const put = (key: string, d: { x: number; y: number; ext: number }) => {
        let k = key;
        for (let n = 1; out.has(k); n++) k = `${key}#${n}`;
        out.set(k, { key: k, x: d.x, y: d.y, ext: d.ext });
    };
    for (const s of scene.sprites) {
        put(`sprite ${s.uid}/${s.layer}/${s.power} ${s.x},${s.y} r${s.rot} ${frame(s.frame)} ${s.color} d${s.depth} ${s.subfloor} ${s.kind} ${s.scale}`, s);
    }
    for (const t of scene.tiles) put(`tile ${t.grid} ${t.x},${t.y} r${t.gridRot} m${t.rotMirror} ${frame(t.frame)} ${t.subfloor}`, t);
    for (const d of scene.decals) put(`decal ${d.x},${d.y} r${d.rot} ${frame(d.frame)} ${d.color} z${d.z}`, d);
    for (const [uid, [proto, name]] of scene.entities) out.set(`entity ${uid} ${proto} ${name}`, { key: "", x: 0, y: 0, ext: -1 });
    return out;
}

function difference(a: Map<string, Drawn>, b: Map<string, Drawn>): Drawn[] {
    const out: Drawn[] = [];
    for (const [k, v] of a) if (!b.has(k)) out.push(v);
    for (const [k, v] of b) if (!a.has(k)) out.push(v);
    return out;
}

const covered = (d: Drawn, rects: Rect[]) =>
    d.ext < 0 || rects.some(([x0, y0, x1, y1]) => d.x + d.ext >= x0 && d.x - d.ext <= x1 && d.y + d.ext >= y0 && d.y - d.ext <= y1);

/** Entities of the map worth editing: one kind per neighbour rule the scene emulates. */
function candidates(doc: MapDocument, pack: Pack, perKind: number): Record<string, number[]> {
    const grids = new Set(doc.listedGrids());
    const kinds: Record<string, number[]> = { smooth: [], pipe: [], cable: [], thruster: [], subfloor: [], container: [] };
    for (const uid of doc.uids()) {
        const t = doc.transform(uid);
        if (t.parent === null || !grids.has(t.parent)) continue;
        const proto = pack.migrate(doc.proto(uid) ?? "");
        const c = (proto && pack.prototypes.entities[proto]?.components) || {};
        const data = doc.entityData(uid)!.components as any[];
        if (c.IconSmooth) kinds.smooth!.push(uid);
        if (c.PipeAppearance) kinds.pipe!.push(uid);
        if (c.CableVisualizer) kinds.cable!.push(uid);
        if (c.Thruster) kinds.thruster!.push(uid);
        if (c.SubFloorHide) kinds.subfloor!.push(uid);
        if (data.some((d) => d?.type === "ContainerContainer" && JSON.stringify(d.containers ?? {}).includes("ents"))) kinds.container!.push(uid);
    }
    // spread over the map
    for (const k of Object.keys(kinds)) {
        const all = kinds[k]!;
        kinds[k] = all.length <= perKind ? all : [all[Math.floor(all.length / 2)]!, all[0]!, all[all.length - 1]!].slice(0, perKind);
    }
    return kinds;
}

describe.skipIf(MAPS.length === 0)("scenes follow edits", () => {
    for (const [fork, file, perKind, everyStep] of MAPS) {
        it(`${file}`, () => {
            const pack = packFor(fork)!;
            const doc = new MapDocument(fs.readFileSync(path.join(root, file), "utf8"));
            const scene = new Scene(doc, pack);
            const timings: Array<[string, number]> = [];
            let rects: Rect[] | null = [];
            doc.onChange((change, label) => {
                const t0 = performance.now();
                const r = scene.apply(change);
                rects = rects === null || r === null ? null : [...rects, ...r];
                timings.push([label, performance.now() - t0]);
            });

            const steps: string[] = [];
            const compare = (what: string, current = snapshot(scene)) => {
                const wrong = difference(current, snapshot(new Scene(doc, pack))).map((d) => d.key);
                expect(wrong.slice(0, 10), `${what}: differs from a scene built anew`).toEqual([]);
            };
            let before = snapshot(scene);
            const check = (what: string, op: () => unknown) => {
                rects = [];
                op();
                const after = snapshot(scene);
                if (everyStep) compare(what, after);
                const outside = rects === null ? [] : difference(before, after).filter((d) => !covered(d, rects!));
                expect(outside.slice(0, 10).map((d) => d.key), `${what}: changed outside the redrawn areas`).toEqual([]);
                before = after;
                steps.push(what);
            };

            const kinds = candidates(doc, pack, perKind);
            const tilemap = [...doc.tilemap().values()].filter((n) => n !== "Space" && pack.tile(n));
            const subfloorTile = tilemap.find((n) => pack.tile(n)!.isSubfloor) ?? "Plating";
            const floorTile = tilemap.find((n) => !pack.tile(n)!.isSubfloor) ?? subfloorTile;

            for (const [kind, uids] of Object.entries(kinds)) {
                for (const uid of uids) {
                    if (doc.proto(uid) === undefined) continue; // deleted with an entity edited before
                    const t = doc.transform(uid);
                    const proto = doc.proto(uid)!;
                    check(`move ${kind} ${uid}`, () => doc.moveEntity(uid, t.x + 1, t.y));
                    check(`rotate ${kind} ${uid}`, () => doc.rotateEntity(uid, t.rotation + Math.PI / 2));
                    check(`place ${proto} by ${uid}`, () => doc.addEntity(proto, t.parent!, Math.floor(t.x) + 0.5, Math.floor(t.y) + 1.5));
                    const tx = Math.floor(t.x), ty = Math.floor(t.y);
                    check(`floor under ${kind} ${uid}`, () => doc.setTile(t.parent!, tx, ty, floorTile));
                    check(`plating under ${kind} ${uid}`, () => doc.setTile(t.parent!, tx, ty, subfloorTile));
                    check(`space by ${kind} ${uid}`, () => doc.setTile(t.parent!, tx, ty - 1, "Space"));
                    check(`delete ${kind} ${uid}`, () => doc.deleteEntity(uid));
                }
                if (uids.length) {
                    check(`undo after ${kind}`, () => doc.undo());
                    check(`undo again after ${kind}`, () => doc.undo());
                    check(`redo after ${kind}`, () => doc.redo());
                }
            }
            compare("after all edits");
            check("everything undone", () => {
                while (doc.journal.canUndo) doc.undo();
            });
            compare("everything undone");
            expect(doc.serialize()).toBe(fs.readFileSync(path.join(root, file), "utf8"));

            const worst = timings.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0] as [string, number]);
            const total = timings.reduce((a, b) => a + b[1], 0);
            console.log(`${file}: ${steps.length} checks, ${timings.length} updates, mean ${(total / timings.length).toFixed(2)} ms, worst ${worst[1].toFixed(2)} ms (${worst[0]})`);
            expect(steps.length).toBeGreaterThan(10);
        }, 900_000);
    }
});
