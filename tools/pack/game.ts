// Reads a checkout of any SS14 fork: prototypes (including the engine's), localisation, engine colours.
// Nothing in the checkout is executed or modified.
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

// Polymorphic data is tagged `!type:Name`; a tagged mapping keeps its type in `!type` (so do the container kinds
// written without fields), any other `!type:*` node is read as plain data. The default schema is YAML 1.2 like
// the engine's parser: `on`/`off`/`yes` stay strings.
// `!type:CreateVariants` is kept as a marker: one prototype definition stands for several prototypes.
const VARIANTS = "__createVariants";
/** Field holding the C# type of a tagged mapping (`!type:CornerSpriteSmoothing`), for polymorphic data drawing needs. */
export const TYPE_FIELD = "!type";
/** Container kinds a prototype's ContainerContainer lists, often written without fields (`entity_storage: !type:Container`). */
const FIELDLESS_KINDS = new Set(["!type:Container", "!type:ContainerSlot"]);
const SCHEMA = yaml.DEFAULT_SCHEMA.extend(
    (["scalar", "sequence", "mapping"] as const).map(
        (kind) =>
            new yaml.Type("!type:", {
                kind,
                multi: true,
                construct: (data: unknown, tag?: string) => {
                    if (tag === "!type:CreateVariants") return { [VARIANTS]: data };
                    if (kind === "mapping" && data && typeof data === "object" && tag) return { [TYPE_FIELD]: tag.slice("!type:".length), ...(data as object) };
                    // containers differ by their kind, which no field tells
                    if (kind === "scalar" && (data === "" || data === null) && tag && FIELDLESS_KINDS.has(tag)) return { [TYPE_FIELD]: tag.slice("!type:".length) };
                    return data === "" ? null : data;
                },
            }),
    ),
);

/** Variant values of a `!type:CreateVariants` node (`values: [...]` or `sequences: [[...], ...]`). */
function variantValues(node: unknown): unknown[] | null {
    if (!node || typeof node !== "object" || !(VARIANTS in node)) return null;
    const spec = (node as Record<string, unknown>)[VARIANTS] as Record<string, unknown> | null;
    const values = spec?.values ?? spec?.sequences;
    return Array.isArray(values) ? values : [];
}

function countVariants(node: unknown): number {
    const own = variantValues(node);
    if (own) return own.length;
    if (Array.isArray(node)) return Math.max(0, ...node.map(countVariants));
    if (node && typeof node === "object") return Math.max(0, ...Object.values(node).map(countVariants));
    return 0;
}

function pickVariant(node: unknown, i: number): unknown {
    const own = variantValues(node);
    if (own) return own[i] ?? null;
    if (Array.isArray(node)) return node.map((n) => pickVariant(n, i));
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, pickVariant(v, i)]));
    return node;
}

/** A prototype definition with `!type:CreateVariants` fields becomes one prototype per variant. */
export function expandVariants(doc: Record<string, unknown>): Record<string, unknown>[] {
    const n = countVariants(doc);
    if (n === 0) return [doc];
    return Array.from({ length: n }, (_, i) => pickVariant(doc, i) as Record<string, unknown>);
}

export type Raw = Record<string, unknown>;

export function readYaml(file: string): unknown {
    // json: duplicate keys override instead of throwing, as the engine does
    return yaml.load(fs.readFileSync(file, "utf8"), { schema: SCHEMA, json: true });
}

export function walk(dir: string, ext: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, ext, out);
        else if (entry.name.endsWith(ext)) out.push(full);
    }
    return out;
}

export const truthy = (v: unknown) => String(v).toLowerCase() === "true";
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export interface ResolvedEntity {
    id: string;
    abstract: boolean;
    name: string | null;
    suffix: string | null;
    description: string | null;
    placement: Raw | null;
    categories: Set<string>;
    components: Record<string, Raw>;
}

export class Checkout {
    readonly resources: string;
    readonly textures: string;
    private readonly protos = new Map<string, Map<string, Raw>>();
    /** Entity id → the ids of the `!type:CreateVariants` definition it came from, in order (a variant collection). */
    private readonly collections = new Map<string, string[]>();
    private readonly resolved = new Map<string, ResolvedEntity>();
    readonly loc = new Map<string, string>();
    readonly colors = new Map<string, [number, number, number, number]>();
    /** Component name → categories given to every entity with it (`[EntityCategory(...)]` on the C# class). */
    readonly componentCategories = new Map<string, string[]>();
    readonly problems: string[] = [];

    /** RobustToolbox sources (`Robust.*` projects): the checkout's submodule, or another checkout of the engine. */
    readonly engine: string;

    constructor(
        readonly root: string,
        options: { engine?: string } = {},
    ) {
        this.engine = options.engine ?? path.join(root, "RobustToolbox");
        this.resources = path.join(root, "Resources");
        this.textures = path.join(this.resources, "Textures");
        if (!fs.existsSync(path.join(this.resources, "Prototypes"))) throw new Error(`${root} is not an SS14 checkout (no Resources/Prototypes)`);
        for (const dir of [path.join(root, "RobustToolbox", "Resources", "EnginePrototypes"), path.join(this.resources, "Prototypes")]) {
            this.loadPrototypes(dir);
        }
        this.loadLocale();
        this.loadColors();
        this.loadComponentCategories();
    }

    /**
     * Categories declared on component classes in the C# sources, read as text (nothing is compiled):
     * `[RegisterComponent, EntityCategory("Actions")] public sealed partial class ActionComponent`.
     */
    private loadComponentCategories(): void {
        const sources = this.csharp();
        if (!sources.length) {
            this.problems.push("no Content.* sources: categories declared on components are unknown (actions etc. stay visible)");
            return;
        }
        const attribute = /\[([^\[\]]*\bEntityCategory\(([^)]*)\)[^\[\]]*)\]((?:\s*\[[^\[\]]*\])*)\s*(?:(?:public|internal|sealed|abstract|partial|virtual)\s+)*class\s+(\w+)/g;
        for (const { text: src } of sources) {
            if (!src.includes("EntityCategory(")) continue;
            for (const m of src.matchAll(attribute)) {
                const component = m[4]!.replace(/Component$/, "");
                const categories = [...m[2]!.matchAll(/"([^"]+)"/g)].map((c) => c[1]!);
                if (categories.length) this.componentCategories.set(component, [...(this.componentCategories.get(component) ?? []), ...categories]);
            }
        }
    }

    private sources: Array<{ file: string; text: string }> | null = null;

    /**
     * Names of every component the game can put on an entity: component types used by any entity prototype
     * (abstract ones too, before filtering) plus classes marked `[RegisterComponent]` in `Content.*` and
     * `RobustToolbox/Robust.*` sources, read as text. As in the engine's ComponentFactory the name is the class
     * name without the `Component` suffix, unless `[ComponentProtoName("Name")]` overrides it. Sorted.
     */
    componentNames(): string[] {
        const names = new Set<string>();
        for (const proto of this.all("entity").values()) {
            for (const c of (proto.components as unknown[]) ?? []) {
                if (c && typeof c === "object" && (c as Raw).type) names.add(String((c as Raw).type));
            }
        }
        const files = [...this.csharp(), ...this.engineCsharp()];
        const klass = /((?:\[[^\]\n]*\]\s*)+)(?:(?:public|internal|sealed|abstract|partial|virtual|static)\s+)*class\s+(\w+)/g;
        for (const { text } of files) {
            if (!text.includes("RegisterComponent")) continue;
            for (const m of text.matchAll(klass)) {
                if (!/\bRegisterComponent\b/.test(m[1]!)) continue;
                const override = /\bComponentProtoName\(\s*"([^"]+)"/.exec(m[1]!);
                names.add(override ? override[1]! : m[2]!.replace(/Component$/, ""));
            }
        }
        return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    private engineSources: Array<{ file: string; text: string }> | null = null;

    /** Text of every C# file of the engine's `Robust.*` projects (none when the engine's sources are absent), read once. */
    engineCsharp(): Array<{ file: string; text: string }> {
        if (!this.engineSources) {
            const dir = this.engine;
            const projects = fs.existsSync(dir)
                ? fs.readdirSync(dir).filter((d) => d.startsWith("Robust.") && !/Test|Benchmark|Analyzer|Generator|Docfx|Packaging|Injectors|Roslyn/.test(d) && fs.statSync(path.join(dir, d)).isDirectory()).sort()
                : [];
            this.engineSources = projects.flatMap((p) => walk(path.join(dir, p), ".cs").map((file) => ({ file, text: fs.readFileSync(file, "utf8") })));
        }
        return this.engineSources;
    }

    /** Localised description of an entity prototype (MetaData's `desc`), if it has one. */
    displayDescription(id: string): string | undefined {
        return this.localize(`ent-${id}.desc`) ?? this.entity(id).description ?? undefined;
    }

    /** Text of every C# file of the content projects (`Content.*`, forks' own included), read once. */
    csharp(): Array<{ file: string; text: string }> {
        if (!this.sources) {
            const dirs = fs.readdirSync(this.root).filter((d) => d.startsWith("Content.") && fs.statSync(path.join(this.root, d)).isDirectory()).sort();
            this.sources = dirs.flatMap((dir) => walk(path.join(this.root, dir), ".cs").map((file) => ({ file, text: fs.readFileSync(file, "utf8") })));
        }
        return this.sources;
    }

    private loadPrototypes(dir: string): void {
        for (const file of walk(dir, ".yml")) {
            let docs: unknown;
            try {
                docs = readYaml(file);
            } catch (e) {
                this.problems.push(`${path.relative(this.root, file)}: ${(e as Error).message.split("\n")[0]}`);
                continue;
            }
            if (!Array.isArray(docs)) continue;
            for (const d of docs) {
                if (!d || typeof d !== "object") continue;
                const variants = expandVariants(d as Raw);
                for (const p of variants) {
                    if (p.id === undefined || p.id === null || !p.type) continue;
                    const type = String(p.type);
                    if (!this.protos.has(type)) this.protos.set(type, new Map());
                    this.protos.get(type)!.set(String(p.id), p);
                }
                if (variants.length > 1 && String((d as Raw).type) === "entity") {
                    const ids = variants.map((p) => String(p.id));
                    if (new Set(ids).size === ids.length) for (const id of ids) this.collections.set(id, ids);
                }
            }
        }
    }

    /** The variant collection an entity prototype belongs to (IPrototypeManager.TryGetVariantCollection), or null. */
    variantCollection(id: string): string[] | null {
        return this.collections.get(id) ?? null;
    }

    all(type: string): Map<string, Raw> {
        return this.protos.get(type) ?? new Map();
    }

    proto(type: string, id: string): Raw | undefined {
        return this.protos.get(type)?.get(id);
    }

    /**
     * Entity prototype with its parents applied. The engine pushes parents in order onto the child and keeps
     * values already set, so the first parent listed wins; component fields merge.
     */
    entity(id: string): ResolvedEntity {
        const done = this.resolved.get(id);
        if (done) return done;
        const p = this.proto("entity", id);
        const res: ResolvedEntity = {
            id,
            abstract: truthy(p?.abstract ?? false),
            name: null,
            suffix: null,
            description: null,
            placement: null,
            categories: new Set(),
            components: {},
        };
        this.resolved.set(id, res); // guards against inheritance cycles
        if (!p) return res;

        for (const parentId of list(p.parent)) {
            const parent = this.entity(parentId);
            for (const [type, data] of Object.entries(parent.components)) res.components[type] = { ...data, ...(res.components[type] ?? {}) };
            res.name ??= parent.name;
            res.suffix ??= parent.suffix;
            res.description ??= parent.description;
            if (parent.placement) res.placement = { ...parent.placement, ...(res.placement ?? {}) };
            // only categories marked inheritable pass to children (HideSpawnMenu is not)
            for (const c of parent.categories) if (this.categoryInheritable(c)) res.categories.add(c);
        }
        for (const c of (p.components as unknown[]) ?? []) {
            if (c && typeof c === "object" && (c as Raw).type) {
                const type = String((c as Raw).type);
                res.components[type] = { ...(res.components[type] ?? {}), ...(c as Raw) };
            }
        }
        if (p.name !== undefined) res.name = String(p.name);
        if (p.suffix !== undefined) res.suffix = String(p.suffix);
        if (p.description !== undefined && p.description !== null) res.description = String(p.description);
        if (p.placement && typeof p.placement === "object") res.placement = { ...(res.placement ?? {}), ...(p.placement as Raw) };
        for (const c of list(p.categories)) res.categories.add(c);
        // categories that apply automatically to entities with certain components (YAML list or C# attribute)
        for (const [catId, cat] of this.all("entityCategory")) {
            if (list(cat.components).some((comp) => comp in res.components)) res.categories.add(catId);
        }
        for (const comp of Object.keys(res.components)) for (const c of this.componentCategories.get(comp) ?? []) res.categories.add(c);
        return res;
    }

    private categoryInheritable(id: string): boolean {
        const cat = this.proto("entityCategory", id);
        return cat ? String(cat.inheritable ?? true).toLowerCase() !== "false" : true;
    }

    /** Hidden from spawn menus: abstract, legacy `noSpawn`, or any category with `hideSpawnMenu`. */
    hidden(id: string): boolean {
        const e = this.entity(id);
        if (e.abstract || truthy(this.proto("entity", id)?.noSpawn ?? false)) return true;
        return [...e.categories].some((c) => truthy(this.proto("entityCategory", c)?.hideSpawnMenu ?? false));
    }

    private loadLocale(): void {
        const dir = path.join(this.resources, "Locale", "en-US");
        for (const file of walk(dir, ".ftl")) {
            let current: string | null = null;
            for (const line of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split("\n")) {
                const msg = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(line);
                if (msg) {
                    current = msg[1]!;
                    this.loc.set(current, msg[2]!);
                    continue;
                }
                const attr = /^\s+\.([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*?)\s*$/.exec(line);
                if (attr && current) this.loc.set(`${current}.${attr[1]}`, attr[2]!);
                else if (line.trim() && !line.startsWith(" ")) current = null;
            }
        }
    }

    /** A localised string, following "{ ent-Other }" references. */
    localize(key: string): string | undefined {
        let v = this.loc.get(key);
        const seen = new Set<string>();
        let m: RegExpExecArray | null;
        while (v && (m = /^\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}$/.exec(v)) && !seen.has(m[1]!)) {
            seen.add(m[1]!);
            v = this.loc.get(m[1]!);
        }
        return v || undefined;
    }

    displayName(id: string): string {
        return this.localize(`ent-${id}`) ?? this.entity(id).name ?? id;
    }

    /** Suffix shown in spawn menus: the entity's own and those of its categories. */
    displaySuffix(id: string): string | undefined {
        const parts: string[] = [];
        const own = this.localize(`ent-${id}.suffix`) ?? this.entity(id).suffix;
        if (own) parts.push(own);
        for (const c of [...this.entity(id).categories].sort()) {
            const key = this.proto("entityCategory", c)?.suffix;
            if (key) parts.push(this.localize(String(key)) ?? String(key));
        }
        return parts.length ? parts.join(", ") : undefined;
    }

    /** Named colours exactly as the engine defines them: "Green" is #008000, "Lime" is #00FF00. */
    private loadColors(): void {
        const file = path.join(this.root, "RobustToolbox", "Robust.Shared.Maths", "Color.cs");
        if (!fs.existsSync(file)) {
            this.problems.push("RobustToolbox/Robust.Shared.Maths/Color.cs not found: named colours unavailable");
            return;
        }
        const src = fs.readFileSync(file, "utf8");
        for (const m of src.matchAll(/public static Color (\w+) => new\((\d+), (\d+), (\d+), (\d+)\)/g)) {
            this.colors.set(m[1]!.toLowerCase(), [m[2], m[3], m[4], m[5]].map((v) => Number(v) / 255) as [number, number, number, number]);
        }
    }

    /**
     * Entity renames applied when maps load: every `Resources/*migration*.yml` (forks add their own, e.g.
     * `nf_migration.yml`). An empty or null target means the entity is deleted.
     */
    migrations(): Record<string, string | null> {
        const out: Record<string, string | null> = {};
        for (const name of fs.readdirSync(this.resources).filter((n) => /migration.*\.ya?ml$/.test(n)).sort()) {
            let data: unknown;
            try {
                data = readYaml(path.join(this.resources, name));
            } catch (e) {
                this.problems.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
                continue;
            }
            if (!data || typeof data !== "object" || Array.isArray(data)) continue;
            for (const [from, to] of Object.entries(data as Raw)) out[from] = to === null || to === undefined || to === "" || to === "null" ? null : String(to);
        }
        return out;
    }

    /** Path relative to Textures for a sprite or texture reference ("/Textures/Tiles/steel.png" → "Tiles/steel.png"). */
    texturePath(ref: string): string {
        let r = ref.replace(/^\/+/, "");
        if (r.startsWith("Textures/")) r = r.slice("Textures/".length);
        return r;
    }
}
