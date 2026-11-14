// Builds the asset pack of one SS14 fork from a checkout.
//
//   build-pack --checkout <dir> --out <dir> --id <fork id> [--repo <url>] [--branch <name>] [--commit <sha>] [--engine <dir>]
//
// The checkout needs Resources/{Prototypes,Textures,Locale/en-US} and, from the RobustToolbox submodule,
// Resources/EnginePrototypes and Robust.Shared.Maths/Color.cs. Engine components' fields come from the submodule's
// `Robust.*` sources, or from another engine checkout given with --engine. Nothing in either is executed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PACK_FORMAT, type ContainerRules, type DecalDefinition, type EntityPrototype, type BuildIndex, type PackManifest, type PrototypeData, type PrototypeDefinition, type PrototypeIndex, type TileDefinition } from "../src/pack/format";
import { ContainerData } from "./pack/containers";
import { DeviceData } from "./pack/devices";
import { Checkout, truthy, type Raw } from "./pack/game";
import { ParallaxPacker } from "./pack/parallax";
import { bodyMass, gridPhysics } from "./pack/physics";
import { componentSchemas } from "./pack/schemas";
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
    // placing an entity deletes the anchored entities on its tile with the same key (PlacementManager)
    PlacementReplacement: (c) => pick(c, ["key"]),
    Door: (c) => pick(c, ["state", "openSpriteState", "closedSpriteState", "openDrawDepth", "closedDrawDepth"]),
    // device linking: which entities are sources, sinks, configurators (device lists) and networked devices
    DeviceLinkSource: (c) => pick(c, ["ports", "range"]),
    DeviceLinkSink: (c) => pick(c, ["ports"]),
    DeviceList: (c) => pick(c, ["deviceLimit", "isAllowList"]),
    DeviceNetwork: (c) => pick(c, ["deviceNetId", "savableAddress", "receiveFrequencyId", "transmitFrequencyId"]),
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

/** Rounds a mass to 6 significant digits, so float noise does not change the pack between builds. */
const round = (v: number) => Number(v.toPrecision(6));

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
        throw new Error("usage: build-pack --checkout <dir> --out <dir> --id <fork id> [--repo <url>] [--branch <name>] [--commit <sha>] [--engine <dir>]");
    }
    const t0 = Date.now();
    const game = new Checkout(path.resolve(opt.checkout), opt.engine ? { engine: path.resolve(opt.engine) } : {});
    const outDir = path.resolve(opt.out);
    fs.mkdirSync(outDir, { recursive: true });
    const problems = game.problems;

    // ---- prototypes
    const devices = new DeviceData(game);
    const physics = gridPhysics(game);
    const containers = new ContainerData(game);
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
        const ports = devices.ports(e);
        if (ports.source.length || ports.sink.length) {
            proto.ports = {};
            if (ports.source.length) proto.ports.source = ports.source;
            if (ports.sink.length) proto.ports.sink = ports.sink;
        }
        const body = bodyMass(game, id);
        if (body) {
            proto.mass = round(body.mass);
            const centre = body.centre.map((v) => Math.round(v * 1e6) / 1e6 || 0) as [number, number];
            if (centre[0] || centre[1]) proto.massCentre = centre;
        }
        const fill = containers.fills(id);
        if (fill.fills) {
            proto.fills = true;
            if (fill.plainBase) proto.plainBase = fill.plainBase;
        }
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
        // ContentTileDefinition.MapAtmosphere: the game treats such tiles (space, lattice) as open space
        if (truthy(t.isSpace ?? false)) tiles[id].isSpace = true;
        const mass = t.mass !== undefined ? Number(t.mass) : physics.tileMass;
        if (mass !== null && !Number.isNaN(mass)) tiles[id].mass = mass;
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
        decals[id] = {
            sprite,
            ...(String(d.showMenu ?? true).toLowerCase() === "false" ? { hidden: true as const } : {}),
            ...(String(d.defaultSnap ?? true).toLowerCase() === "false" ? { defaultSnap: false as const } : {}),
            ...(truthy(d.defaultCleanable ?? false) ? { defaultCleanable: true as const } : {}),
            ...(truthy(d.defaultCustomColor ?? false) ? { defaultCustomColor: true as const } : {}),
        };
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
        ports: { source: devices.portPrototypes("sourcePort"), sink: devices.portPrototypes("sinkPort") },
        devices: devices.storage,
        componentNames: game.componentNames(),
        ...(physics.tileDensity !== null ? { tileDensity: physics.tileDensity } : {}),
    };
    const prototypesJson = JSON.stringify(prototypes);
    const prototypesName = hashName("prototypes", "json", prototypesJson);
    fs.writeFileSync(path.join(outDir, prototypesName), prototypesJson);

    // ---- small index for choosing a build without loading the prototypes
    const sorted = (ids: string[]) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const buildIndex: BuildIndex = { entities: sorted(Object.keys(entities)), tiles: sorted(Object.keys(tiles)), migrations: prototypes.migrations };
    const indexJson = JSON.stringify(buildIndex);
    const indexName = hashName("index", "json", indexJson);
    fs.writeFileSync(path.join(outDir, indexName), indexJson);

    // ---- full prototype data and component fields, loaded by the editor on demand
    const full: PrototypeData = { entities: {} };
    for (const [id, p] of [...game.all("entity")].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const def: PrototypeDefinition = { components: {} };
        const parents = p.parent === undefined || p.parent === null ? [] : Array.isArray(p.parent) ? p.parent.map(String) : [String(p.parent)];
        if (parents.length) def.parents = parents;
        if (truthy(p.abstract ?? false)) def.abstract = true;
        else {
            const description = game.displayDescription(id);
            if (description) def.description = description;
        }
        for (const c of (p.components as unknown[]) ?? []) {
            if (!c || typeof c !== "object" || !(c as Raw).type) continue;
            const { type, ...fields } = c as Raw;
            def.components[String(type)] = { ...(def.components[String(type)] ?? {}), ...fields };
        }
        full.entities[id] = def;
    }
    const fullJson = JSON.stringify(full);
    const fullName = hashName("prototype-data", "json", fullJson);
    fs.writeFileSync(path.join(outDir, fullName), fullJson);

    const { schemas, stats: schemaStats } = componentSchemas([...game.csharp(), ...game.engineCsharp()], game.colors);
    for (const type of schemaStats.protoTypes) {
        const ids = [...game.all(type).keys()].sort();
        if (ids.length) schemas.prototypeIds[type] = ids;
    }
    const schemasJson = JSON.stringify(schemas);
    const schemasName = hashName("components", "json", schemasJson);
    fs.writeFileSync(path.join(outDir, schemasName), schemasJson);
    if (!game.engineCsharp().length) problems.push("no engine sources: fields of engine components (MetaData, Transform, PointLight...) are unknown");
    const rules: ContainerRules = containers.rules();
    const rulesJson = JSON.stringify(rules);
    const rulesName = hashName("container-rules", "json", rulesJson);
    fs.writeFileSync(path.join(outDir, rulesName), rulesJson);
    const tProtos = Date.now();

    // ---- textures
    const { index, frames } = await packTextures(game.textures, plain, outDir, problems);
    const texturesJson = JSON.stringify(index);
    const texturesName = hashName("textures", "json", texturesJson);
    fs.writeFileSync(path.join(outDir, texturesName), texturesJson);

    // ---- parallax backgrounds, loaded by the editor when shown
    const tParallax = Date.now();
    const parallax = new ParallaxPacker(game, outDir, problems);
    const parallaxData = await parallax.build();
    const parallaxJson = JSON.stringify(parallaxData);
    const parallaxName = hashName("parallax", "json", parallaxJson);
    fs.writeFileSync(path.join(outDir, parallaxName), parallaxJson);

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
        files: { prototypes: prototypesName, textures: texturesName, componentSchemas: schemasName, prototypeData: fullName, parallax: parallaxName, containerRules: rulesName, index: indexName },
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
    const keep = new Set(["manifest.json", prototypesName, texturesName, schemasName, fullName, parallaxName, rulesName, indexName, ...index.pages, ...parallax.files]);
    for (const f of fs.readdirSync(outDir)) if (!keep.has(f) && /^(page|prototypes|textures|components|prototype-data|container-rules|index|parallax|parallax-thumb)\.[0-9a-f]{12}\./.test(f)) fs.unlinkSync(path.join(outDir, f));
    const tmp = path.join(outDir, `.manifest.${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, path.join(outDir, "manifest.json"));

    const size = fs.readdirSync(outDir).reduce((sum, f) => sum + fs.statSync(path.join(outDir, f)).size, 0);
    console.log(
        `${opt.id}: ${manifest.stats.entities} entities (${placeable} placeable), ${manifest.stats.tiles} tiles, ` +
            `${manifest.stats.decals} decals, ${manifest.stats.rsi} RSI, ${frames} frames in ${index.pages.length} pages, ` +
            `${(size / 1048576).toFixed(1)} MB; prototypes ${((tProtos - t0) / 1000).toFixed(1)} s, total ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    const kb = (s: string) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
    console.log(
        `prototypes ${kb(prototypesJson)}, full prototype data ${kb(fullJson)}, container rules ${kb(rulesJson)} (${Object.keys(rules.bounds).length} bounds, ${Object.values(entities).filter((e) => e.fills).length} filling, ${Object.values(entities).filter((e) => e.plainBase).length} with a plain base), component fields ${kb(schemasJson)}: ` +
            `${schemaStats.components} components (${schemaStats.withFields} with fields), ${schemaStats.fields} fields, ` +
            `kinds ${JSON.stringify(schemaStats.kinds)}; base classes not found: ${schemaStats.unresolvedBases.length ? schemaStats.unresolvedBases.join(", ") : "none"}`,
    );
    console.log(
        `parallax: ${Object.keys(parallaxData.parallaxes).length} prototypes (default ${parallaxData.default}), ${parallax.files.size} images ` +
            `(${parallax.generated} generated in ${(parallax.generateMs / 1000).toFixed(1)} s), ${(parallax.bytes / 1048576).toFixed(2)} MB; ${((Date.now() - tParallax) / 1000).toFixed(1)} s`,
    );
    if (problems.length) console.log(`${problems.length} problem(s), first: ${problems.slice(0, 5).join("; ")}`);
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});
