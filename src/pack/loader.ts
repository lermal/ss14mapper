// Loads an asset pack in the browser: manifest, prototypes and texture index first, texture pages on demand.
import type { BuildIndex, ComponentSchemas, ContainerRules, PackManifest, ParallaxData, PrototypeData, PrototypeIndex, TextureIndex } from "./format";
import { type Components, resolveComponents } from "./prototype-data";

/** A frame of a texture page: [page, x, y, width, height]. */
export type Frame = [number, number, number, number, number];

export class Pack {
    private readonly pages = new Map<number, Promise<ImageBitmap>>();
    private schemas: Promise<ComponentSchemas | null> | null = null;
    private full: Promise<PrototypeData | null> | null = null;
    private parallaxes: Promise<ParallaxData | null> | null = null;
    private rules: Promise<ContainerRules | null> | null = null;
    private readonly images = new Map<string, Promise<ImageBitmap>>();
    private readonly resolved = new Map<string, Components>();

    private constructor(
        readonly base: string,
        readonly manifest: PackManifest,
        readonly prototypes: PrototypeIndex,
        readonly textures: TextureIndex,
        private readonly read: (name: string) => Promise<unknown>,
    ) {}

    /**
     * A pack whose files were read elsewhere (tests, tools); texture pages cannot be loaded from it. `read` gives the
     * files loaded on demand (component schemas, full prototype data); without it they are unavailable.
     */
    static fromData(manifest: PackManifest, prototypes: PrototypeIndex, textures: TextureIndex, read?: (name: string) => Promise<unknown>): Pack {
        return new Pack("", manifest, prototypes, textures, read ?? (() => Promise.reject(new Error("not available"))));
    }

    static async load(base: string): Promise<Pack> {
        const root = base.endsWith("/") ? base : base + "/";
        const json = async <T>(name: string): Promise<T> => {
            const r = await fetch(root + name);
            if (!r.ok) throw new Error(`${root}${name}: ${r.status}`);
            return (await r.json()) as T;
        };
        const manifest = await json<PackManifest>("manifest.json");
        const [prototypes, textures] = await Promise.all([
            json<PrototypeIndex>(manifest.files.prototypes),
            json<TextureIndex>(manifest.files.textures),
        ]);
        return new Pack(root, manifest, prototypes, textures, json);
    }

    /** Data fields of components, loaded on first use; null when the pack has none (built before they were added). */
    componentSchemas(): Promise<ComponentSchemas | null> {
        const name = this.manifest.files.componentSchemas;
        // a failed load is tried again next time
        this.schemas ??= name ? (this.read(name) as Promise<ComponentSchemas>).catch((e: unknown) => ((this.schemas = null), Promise.reject(e))) : Promise.resolve(null);
        return this.schemas;
    }

    /** Full component data of every prototype, loaded on first use; null when the pack has none. */
    prototypeData(): Promise<PrototypeData | null> {
        const name = this.manifest.files.prototypeData;
        this.full ??= name ? (this.read(name) as Promise<PrototypeData>).catch((e: unknown) => ((this.full = null), Promise.reject(e))) : Promise.resolve(null);
        return this.full;
    }

    /** Parallax prototypes and their layer images' file names, loaded on first use; null when the pack has none. */
    parallax(): Promise<ParallaxData | null> {
        const name = this.manifest.files.parallax;
        this.parallaxes ??= name ? (this.read(name) as Promise<ParallaxData>).catch((e: unknown) => ((this.parallaxes = null), Promise.reject(e))) : Promise.resolve(null);
        return this.parallaxes;
    }

    /** Item sizes, entity storage defaults and body sizes for container checks, loaded on first use; null when the pack has none. */
    containerRules(): Promise<ContainerRules | null> {
        const name = this.manifest.files.containerRules;
        this.rules ??= name ? (this.read(name) as Promise<ContainerRules>).catch((e: unknown) => ((this.rules = null), Promise.reject(e))) : Promise.resolve(null);
        return this.rules;
    }

    /** URL of a file of the pack (parallax images and thumbnails). */
    url(name: string): string {
        return this.base + name;
    }

    /** An image file of the pack (a parallax layer), loaded once. */
    image(name: string): Promise<ImageBitmap> {
        let p = this.images.get(name);
        if (!p) {
            p = fetch(this.url(name))
                .then((r) => {
                    if (!r.ok) throw new Error(`${name}: ${r.status}`);
                    return r.blob();
                })
                .then((b) => createImageBitmap(b));
            p.catch(() => this.images.delete(name));
            this.images.set(name, p);
        }
        return p;
    }

    /** All components of a prototype with inheritance applied (needs `prototypeData` loaded: pass its result). */
    fullComponents(data: PrototypeData, id: string): Components {
        return resolveComponents(data, id, this.resolved);
    }

    page(index: number): Promise<ImageBitmap> {
        let p = this.pages.get(index);
        if (!p) {
            const name = this.textures.pages[index];
            p = fetch(this.base + name)
                .then((r) => {
                    if (!r.ok) throw new Error(`${name}: ${r.status}`);
                    return r.blob();
                })
                .then((b) => createImageBitmap(b));
            this.pages.set(index, p);
        }
        return p;
    }

    /** First frame of an RSI state in a direction (falls back to the first direction), or null. */
    rsiFrame(rsi: string, state: string, direction: number): Frame | null {
        const entry = this.textures.rsi[rsi];
        const refs = entry?.states[state];
        if (!entry || !refs?.length) return null;
        const [page, x, y] = refs[direction < refs.length ? direction : 0]!;
        return [page, x, y, entry.size[0], entry.size[1]];
    }

    stateDirections(rsi: string, state: string): number {
        return this.textures.rsi[rsi]?.states[state]?.length ?? 0;
    }

    texture(path: string, variant = 0): Frame | null {
        const frames = this.textures.textures[path];
        if (!frames?.length) return null;
        return frames[variant < frames.length ? variant : 0] ?? null;
    }

    /** Current prototype id of an entity on a map (renamed ones followed), or null when the game deletes it. */
    migrate(id: string): string | null {
        let current: string | null = id;
        for (let i = 0; i < 16 && current !== null && current in this.prototypes.migrations; i++) current = this.prototypes.migrations[current] ?? null;
        return current;
    }

    tile(id: string) {
        const t = this.prototypes.tiles[id] ?? this.prototypes.tiles[this.prototypes.tileAliases[id] ?? ""];
        return t ?? null;
    }
}

/** The small index of a pack (manifest and index file only), or null for a pack built without one. */
export async function loadBuildIndex(base: string): Promise<BuildIndex | null> {
    const root = base.endsWith("/") ? base : base + "/";
    const get = async <T>(name: string): Promise<T> => {
        const r = await fetch(root + name);
        if (!r.ok) throw new Error(`${root}${name}: ${r.status}`);
        return (await r.json()) as T;
    };
    const manifest = await get<PackManifest>("manifest.json");
    return manifest.files.index ? get<BuildIndex>(manifest.files.index) : null;
}

/** The index of a pack that is already loaded in full. */
export function indexOf(pack: Pack): BuildIndex {
    const { entities, tiles, migrations } = pack.prototypes;
    return { entities: Object.keys(entities), tiles: Object.keys(tiles), migrations };
}
