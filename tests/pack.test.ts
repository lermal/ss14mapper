import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Checkout, expandVariants } from "../tools/pack/game";
import { packTextures } from "../tools/pack/textures";

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
