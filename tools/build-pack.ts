// Builds the asset pack of one SS14 fork from a checkout.
//
//   build-pack --checkout <dir> --out <dir> --id <fork id> [--repo <url>] [--branch <name>] [--commit <sha>]
//
// The checkout needs Resources/{Prototypes,Textures,Locale/en-US} and, from the RobustToolbox submodule,
// Resources/EnginePrototypes and Robust.Shared.Maths/Color.cs. Nothing in it is executed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PACK_FORMAT, type DecalDefinition, type EntityPrototype, type PackManifest, type PrototypeIndex, type TileDefinition } from "../src/pack/format";
import { Checkout, truthy, type Raw } from "./pack/game";
import { hashName, packTextures } from "./pack/textures";

/** Components whose data drawing and placing need; everything else stays out of the pack. */
const KEPT_COMPONENTS: Record<string, ((c: Raw) => Raw) | true> = {
    Sprite: true,
    Icon: true,
    IconSmooth: true,
    CableVisualizer: true,
    AtmosPipeLayers: true,
    PipeAppearance: true,
    AtmosPipeColor: true,
    GenericVisualizer: true,
    EntityStorageVisuals: true,
    Stack: true,
    StackLayerThreshold: true,
    ApcVisuals: true,
    SubFloorHide: true,
    Marker: () => ({}),
    DisposalTube: () => ({}),
    MapGrid: () => ({}),
    Transform: (c) => pick(c, ["anchored", "noRot"]),
    EntityStorage: (c) => pick(c, ["open"]),
    Foldable: (c) => pick(c, ["folded"]),
    Thruster: (c) => pick(c, ["enabled", "requireSpace"]),
    VendingMachine: (c) => pick(c, ["offState", "normalState", "screenState"]),
    Door: (c) => pick(c, ["state", "openSpriteState", "closedSpriteState", "openDrawDepth", "closedDrawDepth"]),
    Paper: (c) => ({ ...pick(c, ["stampState"]), ...(String(c.content ?? "").trim() ? { content: "…" } : {}) }),
    NodeContainer: (c) => {
        // only pipe nodes matter for drawing (pipe connectors)
        const nodes: Raw = {};
        for (const [name, node] of Object.entries((c.nodes as Raw) ?? {})) {
            if (node && typeof node === "object" && "pipeDirection" in node) {
                nodes[name] = pick(node as Raw, ["nodeGroupID", "pipeDirection", "pipeLayer", "connectionsEnabled", "rotationsEnabled"]);
            }
        }
        return Object.keys(nodes).length ? { nodes } : {};
    },
};

function pick(c: Raw, keys: string[]): Raw {
    const out: Raw = {};
    for (const k of keys) if (c[k] !== undefined) out[k] = c[k];
    return out;
}

function args(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i]!.startsWith("--")) out[argv[i]!.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
    }
    return out;
}

function git(dir: string, ...a: string[]): string | null {
    try {
        return execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const opt = args(process.argv.slice(2));
    if (!opt.checkout || !opt.out || !opt.id) {
        throw new Error("usage: build-pack --checkout <dir> --out <dir> --id <fork id> [--repo <url>] [--branch <name>] [--commit <sha>]");
    }
    const t0 = Date.now();
    const game = new Checkout(path.resolve(opt.checkout));
    const outDir = path.resolve(opt.out);
    fs.mkdirSync(outDir, { recursive: true });
    const problems = game.problems;

    // ---- prototypes
    const entities: Record<string, EntityPrototype> = {};
    const plain = new Map<string, number>();
    let placeable = 0;
    for (const id of [...game.all("entity").keys()].sort()) {
        const e = game.entity(id);
        if (e.abstract) continue;
        const components: Record<string, Raw> = {};
        for (const [type, data] of Object.entries(e.components)) {
            const keep = KEPT_COMPONENTS[type];
            if (!keep) continue;
            const { type: _type, ...fields } = data;
            components[type] = keep === true ? fields : keep(fields);
        }
        const proto: EntityPrototype = { name: game.displayName(id), components };
        const suffix = game.displaySuffix(id);
        if (suffix) proto.suffix = suffix;
        if (game.hidden(id)) proto.hidden = true;
        else placeable++;
        if (e.placement) proto.placement = e.placement;
        entities[id] = proto;

        // sprite layers may use plain textures instead of RSI states
        const sprite = components.Sprite as Raw | undefined;
        for (const layer of [sprite, ...(((sprite?.layers as Raw[]) ?? []).filter((l) => l && typeof l === "object"))]) {
            if (layer && typeof layer.texture === "string" && !layer.state) plain.set(game.texturePath(layer.texture), 1);
        }
    }

    const tiles: Record<string, TileDefinition> = {};
    for (const [id, t] of [...game.all("tile")].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const sprite = typeof t.sprite === "string" ? game.texturePath(t.sprite) : null;
        const variants = Math.max(1, Number(t.variants ?? 1) || 1);
        if (sprite) plain.set(sprite, variants);
        const name = t.name === undefined ? undefined : game.localize(String(t.name));
        tiles[id] = { name: name ?? id, sprite, variants, isSubfloor: truthy(t.isSubfloor ?? false) };
    }

    const decals: Record<string, DecalDefinition> = {};
    for (const [id, d] of [...game.all("decal")].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const s = d.sprite as Raw | string | undefined;
        let sprite: DecalDefinition["sprite"] = null;
        if (s && typeof s === "object" && s.sprite) sprite = { rsi: game.texturePath(String(s.sprite)), state: String(s.state ?? "") };
        else if (typeof s === "string") {
            sprite = { texture: game.texturePath(s) };
            plain.set(sprite.texture, 1);
        }
        decals[id] = { sprite, ...(String(d.showMenu ?? true).toLowerCase() === "false" ? { hidden: true as const } : {}) };
    }

    const stacks: Record<string, number> = {};
    for (const [id, s] of game.all("stack")) if (s.maxCount !== undefined) stacks[id] = Number(s.maxCount);

    const prototypes: PrototypeIndex = {
        entities,
        tiles,
        decals,
        stacks,
        colors: Object.fromEntries([...game.colors].sort()),
        migrations: game.migrations(),
        tileAliases: Object.fromEntries(
            [...game.all("tileAlias")].filter(([, a]) => a.target !== undefined).map(([id, a]) => [id, String(a.target)]).sort(),
        ),
    };
    const prototypesJson = JSON.stringify(prototypes);
    const prototypesName = hashName("prototypes", "json", prototypesJson);
    fs.writeFileSync(path.join(outDir, prototypesName), prototypesJson);
    const tProtos = Date.now();

    // ---- textures
    const { index, frames } = await packTextures(game.textures, plain, outDir, problems);
    const texturesJson = JSON.stringify(index);
    const texturesName = hashName("textures", "json", texturesJson);
    fs.writeFileSync(path.join(outDir, texturesName), texturesJson);

    const checkoutDir = path.resolve(opt.checkout);
    const manifest: PackManifest = {
        format: PACK_FORMAT,
        fork: {
            id: opt.id,
            repo: opt.repo ?? "",
            branch: String(opt.branch ?? git(checkoutDir, "rev-parse", "--abbrev-ref", "HEAD") ?? ""),
            commit: opt.commit ?? git(checkoutDir, "rev-parse", "HEAD") ?? "",
            engineCommit: git(checkoutDir, "ls-tree", "HEAD", "RobustToolbox")?.split(/\s+/)[2] ?? null,
        },
        builtAt: new Date().toISOString(),
        files: { prototypes: prototypesName, textures: texturesName },
        stats: {
            entities: Object.keys(entities).length,
            placeable,
            tiles: Object.keys(tiles).length,
            decals: Object.keys(decals).length,
            rsi: Object.keys(index.rsi).length,
            frames,
            pages: index.pages.length,
        },
    };

    // remove files of earlier builds that this pack no longer references
    const keep = new Set(["manifest.json", prototypesName, texturesName, ...index.pages]);
    for (const f of fs.readdirSync(outDir)) if (!keep.has(f) && /^(page|prototypes|textures)\.[0-9a-f]{12}\./.test(f)) fs.unlinkSync(path.join(outDir, f));
    const tmp = path.join(outDir, `.manifest.${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, path.join(outDir, "manifest.json"));

    const size = fs.readdirSync(outDir).reduce((sum, f) => sum + fs.statSync(path.join(outDir, f)).size, 0);
    console.log(
        `${opt.id}: ${manifest.stats.entities} entities (${placeable} placeable), ${manifest.stats.tiles} tiles, ` +
            `${manifest.stats.decals} decals, ${manifest.stats.rsi} RSI, ${frames} frames in ${index.pages.length} pages, ` +
            `${(size / 1048576).toFixed(1)} MB; prototypes ${((tProtos - t0) / 1000).toFixed(1)} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    if (problems.length) console.log(`${problems.length} problem(s), first: ${problems.slice(0, 5).join("; ")}`);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
