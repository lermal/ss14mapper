import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
import { mapEntity, mapParallax, ownParallax, setMapParallax } from "../src/map/map-props";
import type { ParallaxData, ParallaxLayer } from "../src/pack/format";
import { firstTile, layerOrigin, layerSize } from "../src/render/parallax-math";
import { layerRect, parallaxScale } from "../src/render/parallax";
import { FastNoiseLite, generateParallax, GRADIENTS_2D, NetRandom, parseParallaxToml } from "../tools/pack/parallax-gen";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";
import { packFor, packsDir } from "./pack-files";

const corpus: string = corpusRoot();
const read = (rel: string) => {
    const file = path.join(corpus, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
};

function layer(over: Partial<ParallaxLayer>): ParallaxLayer {
    return {
        texture: { kind: "image", path: "/Textures/x.png" },
        file: null,
        size: [480, 480],
        scale: [1, 1],
        tiled: true,
        slowness: 0.5,
        scrolling: [0, 0],
        worldHomePosition: [0, 0],
        worldAdjustPosition: [0, 0],
        controlHomePosition: [0, 0],
        shader: "unshaded",
        ...over,
    };
}

describe("generator parts", () => {
    it("draws the same numbers as .NET's seeded System.Random", () => {
        const r = new NetRandom(0);
        expect([r.next(), r.next(), r.next()]).toEqual([1559595546, 1755192844, 1649316166]);
        expect(new NetRandom(42).next()).toBe(1434747710);
        // Next(min, max) scales the sample; NextFloat is Next() * 4.6566128752458E-10f in single precision
        expect(new NetRandom(0).nextRange(0, 1920)).toBe(Math.trunc((1559595546 / 2147483647) * 1920));
        expect(new NetRandom(0).nextFloat()).toBe(Math.fround(Math.fround(1559595546) * Math.fround(4.6566128752458e-10)));
    });

    // SS14MAPPER_ENGINE: a RobustToolbox checkout to compare the port with
    const engine = process.env.SS14MAPPER_ENGINE;
    it.runIf(!!engine)("uses FastNoiseLite's gradient table", () => {
        const text = fs.readFileSync(path.join(engine!, "Robust.Shared/Noise/FastNoiseLite.cs"), "utf8");
        const values = /Gradients2D =\s*\{([^}]*)\}/.exec(text)![1]!.split(",").map((v) => v.trim().replace(/f$/, "")).filter(Boolean).map(Number);
        expect(values.length).toBe(256);
        expect([...GRADIENTS_2D]).toEqual(values.map(Math.fround));
    });

    it("gives noise in -1..1 that depends on the seed only", () => {
        const a = new FastNoiseLite(7832), b = new FastNoiseLite(7832), c = new FastNoiseLite(1);
        for (const n of [a, b, c]) {
            n.fractal = "ridged";
            n.frequency = 4;
            n.setOctaves(8);
        }
        let differs = false;
        for (let i = 0; i < 200; i++) {
            const v = a.noise(i * 7, i * 3);
            expect(v).toBe(b.noise(i * 7, i * 3));
            // a ridged sum can pass 1 by a rounding step (the generator clamps)
            expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-6);
            expect(v).toBe(Math.fround(v));
            if (v !== c.noise(i * 7, i * 3)) differs = true;
        }
        expect(differs).toBe(true);
    });

    it("reads parallax TOML configs", () => {
        const t = parseParallaxToml('# x\n[[layers]]\ntype = "clear"\ncolor = "#000000"\n\n[[layers]]\ntype = "points"\ncount = 30\nmask = true\n');
        expect(t.layers).toEqual([{ type: "clear", color: "#000000" }, { type: "points", count: 30, mask: true }]);
    });
});

describe("generated layers", () => {
    const stars = read("upstream/Resources/Prototypes/Parallaxes/parallax_config_stars.toml");
    const nebula = read("upstream/Resources/Prototypes/Parallaxes/parallax_config.toml");

    it.skipIf(!nebula)("are deterministic, noise layers too", () => {
        const a = generateParallax(nebula!, 160, 90), b = generateParallax(nebula!, 160, 90);
        expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
        // clear to black: opaque everywhere; the nebula and stars light some pixels
        for (let i = 3; i < a.data.length; i += 4) expect(a.data[i]).toBe(255);
        expect(a.data.some((v, i) => i % 4 !== 3 && v > 0)).toBe(true);
    });

    it.skipIf(!stars)("make stars with colour turned to alpha", () => {
        const img = generateParallax(stars!);
        expect([img.width, img.height]).toEqual([1920, 1080]);
        let lit = 0;
        for (let i = 0; i < img.data.length; i += 4) {
            const [r, g, b, a] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!];
            expect(a).toBe(Math.min(255, Math.trunc(Math.fround(Math.fround(Math.fround(Math.fround(r / 255) + Math.fround(g / 255)) + Math.fround(b / 255)) * 255) + 0.5)));
            if (a) lit++;
        }
        // 1000 masked stars with 3×3 edges, 30 bright ones with edges: a few thousand pixels of 2 million
        expect(lit).toBeGreaterThan(3000);
        expect(lit).toBeLessThan(40000);
    });

    it.skipIf(!stars || !packFor("upstream"))("match the pack's images", async () => {
        const pack = packFor("upstream")!;
        const data = (await pack.parallax()) as ParallaxData;
        const file = data.parallaxes.Default!.layers.find((l) => l.texture.kind === "generated" && l.texture.id === "hq_wizard_stars")!.file!;
        const { data: raw } = await sharp(path.join(packsDir, "upstream", file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        expect(Buffer.from(generateParallax(stars!).data).equals(raw)).toBe(true);
    });
});

describe("layer placement (ParallaxOverlay)", () => {
    // AmberStation's first asteroid layer: Asteroids.png (480 px), scale 0.4, slowness 0.99, home (20, 100), scrolling (0.01, 0)
    const asteroids = layer({ scale: [0.4, 0.4], slowness: 0.99, worldHomePosition: [20, 100], scrolling: [0.01, 0] });

    it("sizes textures in world units at 32 px per unit", () => {
        expect(layerSize(asteroids)).toEqual([6, 6]);
        expect(layerSize(layer({ size: [1920, 1080] }))).toEqual([60, 33.75]);
    });

    it("shifts from the home towards the eye by the slowness", () => {
        // originBL = (eye - home) * slowness + scrolling * t + home + adjust - size / 2
        const [x, y] = layerOrigin(asteroids, [100, 50]);
        expect(x).toBeCloseTo(80 * 0.99 + 20 - 3, 10); // 96.2
        expect(y).toBeCloseTo(-50 * 0.99 + 100 - 3, 10); // 47.5
        expect(layerOrigin(asteroids, [100, 50], 10)[0]).toBeCloseTo(96.3, 10);
        // the test prototype's adjusted layer: 32 px × 8, slowness 0.995, adjust (4, 4)
        const adjusted = layer({ size: [32, 32], scale: [8, 8], slowness: 0.995, worldAdjustPosition: [4, 4] });
        const [ax, ay] = layerOrigin(adjusted, [10, -20]);
        expect(ax).toBeCloseTo(9.95, 10);
        expect(ay).toBeCloseTo(-19.9, 10);
        // slowness 0 keeps the layer on the world, 1 on the camera
        expect(layerOrigin(layer({ slowness: 0 }), [500, 500])).toEqual([-7.5, -7.5]);
        expect(layerOrigin(layer({ slowness: 1 }), [500, 500])).toEqual([492.5, 492.5]);
    });

    it("starts tiling at the floored offset of the view's corner", () => {
        const t = firstTile([96.2, 47.5], [6, 6], [90, 40]);
        expect(t[0]).toBeCloseTo(84.2, 10);
        expect(t[1]).toBeCloseTo(35.5, 10);
    });

    it("draws at the game's zoom nearest to the editor's", () => {
        expect(parallaxScale(0.05)).toBe(1);
        expect(parallaxScale(2)).toBe(2);
        expect(parallaxScale(8)).toBe(3.375);
        // eye at (100, 50) on a 1000×600 canvas at scale 1: 32 px per unit, y down
        const r = layerRect(asteroids, { eye: [100, 50], scale: 0.1 }, 1000, 600);
        expect(r.w).toBeCloseTo(192, 10);
        expect(r.x).toBeCloseTo(500 + (96.2 - 100) * 32, 8);
        expect(r.y).toBeCloseTo(300 - (47.5 + 6 - 50) * 32, 8);
        // the background moves (1 - slowness) as far as the eye, in the other direction
        const moved = layerRect(asteroids, { eye: [110, 50], scale: 0.1 }, 1000, 600);
        expect(moved.x - r.x).toBeCloseTo(-10 * 0.01 * 32, 8);
    });
});

describe.each(["upstream", "frontier", "goob"])("parallax data of %s", (fork) => {
    const pack = packFor(fork);
    it.skipIf(!pack?.manifest.files.parallax)("has every prototype with images for its layers", async () => {
        const data = (await pack!.parallax())!;
        expect(data.default).toBe("Default");
        const ids = Object.keys(data.parallaxes);
        expect(ids).toEqual(expect.arrayContaining(["Default", "KettleStation", "AspidParallax", "BagelStation", "Blank", "TrainStation"]));
        if (fork === "frontier") expect(ids).toContain("FrontierStation");
        if (fork === "goob") expect(ids).toContain("CosmicFinaleParallax");
        expect(data.parallaxes.Blank!.layers).toEqual([]);
        const kettle = data.parallaxes.KettleStation!;
        expect(kettle.layers.map((l) => (l.texture.kind === "image" ? l.texture.path : l.texture.id))).toEqual([
            "/Textures/Parallaxes/KettleParallaxBG.png",
            "hq_wizard_stars",
            "hq_wizard_stars_dim",
            "/Textures/Parallaxes/KettleParallaxNeb.png",
            "hq_wizard_stars_faster",
            "hq_wizard_stars_dim_faster",
        ]);
        expect(kettle.layers[0]).toMatchObject({ size: [1024, 1024], scale: [1, 1], tiled: true, slowness: 0.998046875, shader: "unshaded" });
        expect(kettle.layers[1]).toMatchObject({ size: [1920, 1080], slowness: 0.986625 });
        expect(kettle.layersLQ[0]).toMatchObject({ texture: { kind: "generated", id: "" }, file: null, slowness: 0.875 });
        expect(kettle.layersLQUseHQ).toBe(false);
        // defaults of ParallaxLayerConfig and parsed vectors
        const amber = data.parallaxes.AmberStation!.layers[3]!;
        expect(amber).toMatchObject({ scale: [0.4, 0.4], worldHomePosition: [20, 100], scrolling: [0.01, 0], slowness: 0.99 });
        expect(data.parallaxes.BagelStation!.layers[5]!.tiled).toBe(false);
        expect(data.parallaxes.Grass!.layers[0]!.shader).toBeNull();
        for (const [id, p] of Object.entries(data.parallaxes)) {
            for (const l of p.layers) {
                expect(l.file, `${id}: ${JSON.stringify(l.texture)}`).toMatch(/^parallax\.[0-9a-f]{12}\.webp$/);
                expect(fs.existsSync(path.join(packsDir, fork, l.file!))).toBe(true);
            }
            if (p.layers.length) expect(fs.existsSync(path.join(packsDir, fork, p.thumbnail!))).toBe(true);
            else expect(p.thumbnail).toBeNull();
        }
        const meta = await sharp(path.join(packsDir, fork, kettle.layers[1]!.file!)).metadata();
        expect([meta.width, meta.height, meta.format]).toEqual([1920, 1080, "webp"]);
    });
});

describe("map parallax", () => {
    const kettle = read("goob/Resources/Maps/_Goobstation/kettle.yml");
    const box = read("upstream/Resources/Maps/box.yml");
    const shuttle = read("upstream/Resources/Maps/Shuttles/arrivals_micro.yml");

    it.skipIf(!kettle)("changes the map's Parallax and undoes to the same bytes", () => {
        const doc = new MapDocument(kettle!);
        const uid = mapEntity(doc)!;
        expect(uid).toBe(1);
        expect(ownParallax(doc, uid)).toBe("KettleStation");
        expect(mapParallax(doc, uid, "Default")).toBe("KettleStation");
        expect(setMapParallax(doc, uid, "AspidParallax", "Default")).toBe(true);
        const out = doc.serialize();
        expect(out).toContain("    - type: OccluderTree\n    - type: Parallax\n      parallax: AspidParallax\n  - uid: 2\n");
        // only the value and the save time change
        const untimed = (t: string) => t.replace(/^  time: .*$/m, "");
        expect(untimed(out.replace("parallax: AspidParallax", "parallax: KettleStation"))).toBe(untimed(kettle!));
        expect(doc.undo()).not.toBeNull();
        expect(doc.serialize()).toBe(kettle);
        // the default removes the component (maps that use it have none), as one step
        expect(setMapParallax(doc, uid, "Default", "Default")).toBe(true);
        expect(ownParallax(doc, uid)).toBeNull();
        expect(doc.serialize()).not.toContain("type: Parallax");
        doc.undo();
        expect(doc.serialize()).toBe(kettle);
        expect(setMapParallax(doc, uid, "KettleStation", "Default")).toBe(false);
    });

    it.skipIf(!box)("adds Parallax after the map's own components", () => {
        const doc = new MapDocument(box!);
        const uid = mapEntity(doc)!;
        expect(ownParallax(doc, uid)).toBeNull();
        expect(mapParallax(doc, uid, "Default")).toBe("Default");
        expect(setMapParallax(doc, uid, "Default", "Default")).toBe(false);
        expect(setMapParallax(doc, uid, "KettleStation", "Default")).toBe(true);
        const types = doc.components(uid).map((c) => c.type);
        const at = types.indexOf("Parallax");
        expect(types[at - 1]).toBe(types.includes("MapLight") ? "MapLight" : "OccluderTree");
        expect(doc.serialize()).toContain("- type: Parallax\n      parallax: KettleStation\n");
        expect(doc.canUndo).toBe(true);
        doc.undo();
        expect(doc.serialize()).toBe(box);
    });

    it.skipIf(!shuttle)("finds no map entity in shuttle files", () => {
        expect(mapEntity(new MapDocument(shuttle!))).toBeNull();
    });

    it("draws nothing on maps with a biome", () => {
        const text = "meta:\n  format: 7\n  category: Map\n  engineVersion: 1\n  forkId: \"\"\n  forkVersion: \"\"\n  time: 01/01/2025 00:00:00\n  entityCount: 1\nmaps:\n- 1\ngrids: []\norphans: []\nnullspace: []\ntilemap: {}\nentities:\n- proto: \"\"\n  entities:\n  - uid: 1\n    components:\n    - type: MetaData\n    - type: Transform\n    - type: Map\n    - type: Biome\n    - type: Parallax\n      parallax: Sky\n";
        const doc = new MapDocument(text);
        expect(mapParallax(doc, 1, "Default")).toBeNull();
        expect(ownParallax(doc, 1)).toBe("Sky");
    });
});
