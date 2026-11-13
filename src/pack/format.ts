// Asset pack of one SS14 fork: everything the editor needs to draw maps and list placeable entities.
// Built by tools/build-pack.ts from a checkout of the fork; read by the editor in the browser.
// File names (except manifest.json) contain a hash of their content, so they can be cached forever.

export const PACK_FORMAT = 1;

export interface PackManifest {
    format: typeof PACK_FORMAT;
    fork: { id: string; repo: string; branch: string; commit: string; engineCommit: string | null };
    builtAt: string;
    /** File names relative to the pack directory. */
    files: { prototypes: string; textures: string };
    stats: { entities: number; placeable: number; tiles: number; decals: number; rsi: number; frames: number; pages: number };
}

/** Components of an entity after inheritance, limited to what drawing and placing need. */
export type ComponentData = Record<string, unknown>;

export interface EntityPrototype {
    name: string;
    /** Shown after the name in the palette, e.g. "Filled". */
    suffix?: string;
    /** Hidden from the palette as in the game's spawn menu (abstract, HideSpawnMenu-like categories). */
    hidden?: true;
    /** Top-level `placement` of the prototype (snapping mode and the like). */
    placement?: Record<string, unknown>;
    components: Record<string, ComponentData>;
}

export interface TileDefinition {
    name: string;
    /** Texture path of the variant strip, relative to Textures. */
    sprite: string | null;
    variants: number;
    isSubfloor: boolean;
}

export interface DecalDefinition {
    /** Either an RSI state or a plain texture. */
    sprite: { rsi: string; state: string } | { texture: string } | null;
    /** Decals with `showMenu: false` are not offered in the decal palette. */
    hidden?: true;
}

export interface PrototypeIndex {
    entities: Record<string, EntityPrototype>;
    tiles: Record<string, TileDefinition>;
    decals: Record<string, DecalDefinition>;
    /** Stack type → maximum count (stack sprites depend on it). */
    stacks: Record<string, number>;
    /** Named colours of the engine (`Color.cs`), lower-case name → [r, g, b, a] in 0..1. */
    colors: Record<string, [number, number, number, number]>;
    /** Old entity prototype id → new id, or null when the game deletes such entities on load (`*migration*.yml`). */
    migrations: Record<string, string | null>;
    /** Old tile id → current tile id (`tileAlias` prototypes). */
    tileAliases: Record<string, string>;
}

/** Frame position in a texture page: [page index, x, y]. Width and height come from the RSI or texture. */
export type FrameRef = [number, number, number];

export interface RsiEntry {
    size: [number, number];
    license?: string;
    copyright?: string;
    /** State → first frame of each direction (1, 4 or 8 entries). */
    states: Record<string, FrameRef[]>;
}

export interface TextureIndex {
    /** Page file names, WebP. */
    pages: string[];
    /** RSI path relative to Textures (e.g. "Structures/Walls/solid.rsi") → states. */
    rsi: Record<string, RsiEntry>;
    /**
     * Plain textures (tiles, some decals and sprites), path relative to Textures → frames [page, x, y, width, height].
     * Tile textures are strips of variants: one frame per variant, in order.
     */
    textures: Record<string, Array<[number, number, number, number, number]>>;
}
