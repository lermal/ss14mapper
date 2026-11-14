// Asset pack of one SS14 fork: everything the editor needs to draw maps and list placeable entities.
// Built by tools/build-pack.ts from a checkout of the fork; read by the editor in the browser.
// File names (except manifest.json) contain a hash of their content, so they can be cached forever.

export const PACK_FORMAT = 1;

export interface PackManifest {
    format: typeof PACK_FORMAT;
    fork: { id: string; repo: string; branch: string; commit: string; engineCommit: string | null };
    builtAt: string;
    /** File names relative to the pack directory. */
    files: {
        prototypes: string;
        textures: string;
        /** Data fields of components (`ComponentSchemas`), loaded on demand. Absent in older packs. */
        componentSchemas?: string;
        /** Every entity prototype's own components and parents (`PrototypeData`), loaded on demand. Absent in older packs. */
        prototypeData?: string;
        /** Parallax prototypes with their layer images (`ParallaxData`), loaded on demand. Absent in older packs. */
        parallax?: string;
        /** Item sizes, entity storage defaults and body sizes for checking container operations (`ContainerRules`), loaded on demand. Absent in older packs. */
        containerRules?: string;
    };
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
    /**
     * Signal ports once the entity has started: those of its DeviceLinkSource/DeviceLinkSink plus the ones game
     * systems add to entities with certain components (doors get Open/Close/Toggle). Absent without ports.
     */
    ports?: { source?: string[]; sink?: string[] };
    /**
     * Mass of the entity's physics body (fixture area × density, as the engine computes it) and its centre in
     * the entity's own coordinates when that is not the origin. Absent for entities without Physics.
     */
    mass?: number;
    massCentre?: [number, number];
    /** The game fills this entity's containers when its map starts (ContainerFill, EntityTableContainerFill, StorageFill...). */
    fills?: true;
    /** The nearest ancestor that is not abstract and does not fill: the same container without contents. Only with `fills`. */
    plainBase?: string;
}

export interface TileDefinition {
    name: string;
    /** Texture path of the variant strip, relative to Textures. */
    sprite: string | null;
    variants: number;
    isSubfloor: boolean;
    /** `isSpace` (ContentTileDefinition.MapAtmosphere): the game treats the tile as open space (space, lattice). */
    isSpace?: true;
    /** The tile's mass for grid impacts (ContentTileDefinition.Mass), also used for the mass "with entities". */
    mass?: number;
}

export interface DecalDefinition {
    /** Either an RSI state or a plain texture. */
    sprite: { rsi: string; state: string } | { texture: string } | null;
    /** Decals with `showMenu: false` are not offered in the decal palette. */
    hidden?: true;
    /** `DecalPrototype.DefaultSnap` when it is not the default `true`. */
    defaultSnap?: false;
    /** `DecalPrototype.DefaultCleanable` when `true`. */
    defaultCleanable?: true;
    /** `DecalPrototype.DefaultCustomColor` when `true`. */
    defaultCustomColor?: true;
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
    /** Signal port prototypes (`sourcePort`, `sinkPort`). */
    ports?: { source: Record<string, PortDefinition>; sink: Record<string, PortDefinition> };
    devices?: DeviceStorage;
    /**
     * Sorted names of all components entities of this fork can have: every component type used by an entity
     * prototype (before the pack drops the ones drawing does not need) plus the `[RegisterComponent]` classes of
     * the C# sources that were available to the builder. Absent in packs built before it was added.
     */
    componentNames?: string[];
    /** Density the game gives every grid fixture (SharedShuttleSystem.TileDensityMultiplier). */
    tileDensity?: number;
}

export interface PortDefinition {
    /** Localised name shown in the linking window. */
    name: string;
    description?: string;
    /** Sink ports this source port links to with "link defaults" (source ports only). */
    defaultLinks?: string[];
}

/** How the fork saves device links and device lists on maps. */
export interface DeviceStorage {
    /**
     * `linkedPorts` entries: "struct" is `- source: Pressed` / `  sink: Toggle` (DeviceLink record),
     * "tuple" is a two-item sequence `- - Pressed` / `  - Toggle`.
     */
    linkFormat: "struct" | "tuple";
    /** Component that holds a device's `deviceLists` (the lists it is in). */
    deviceListBackReference: "LinkedDeviceNetwork" | "DeviceNetwork";
}

/**
 * Editor kind of a component data field, from its C# type: `proto` is a prototype id (`ProtoId<T>`, `EntProtoId`),
 * `entity` an entity uid, `sound` a SoundSpecifier; `list`, `dict` and `other` are edited as YAML.
 */
export type FieldKind =
    | "bool" | "int" | "float" | "string" | "enum" | "color" | "vector2" | "vector2i" | "angle" | "entity" | "proto" | "sound" | "timespan" | "list" | "dict" | "other";

/** A `[DataField]` of a component. */
export interface FieldSchema {
    /** YAML key. */
    name: string;
    /** C# type, namespaces dropped (`float`, `List<EntProtoId>`, `SoundSpecifier?`). */
    type: string;
    kind: FieldKind;
    /** YAML prototype type of a `proto` field (`entity`, `tag`). */
    proto?: string;
    /** Enum type of an `enum` field (members in `ComponentSchemas.enums`). */
    enum?: string;
    /** The default as YAML text, when the C# initializer is a simple literal or the type is a value type. */
    default?: string;
    required?: true;
    /** `[ViewVariables]` access: read-write or read-only. */
    vv?: "rw" | "r";
}

export interface EnumSchema {
    members: string[];
    flags?: true;
}

/** Data fields of the components of a fork, read from its C# sources (and the engine's, when available). */
export interface ComponentSchemas {
    /** Component name → its data fields, base classes' first. */
    components: Record<string, FieldSchema[]>;
    enums: Record<string, EnumSchema>;
    /** YAML prototype type → ids, for prototype id fields other than entities (entities are in the prototype index). */
    prototypeIds: Record<string, string[]>;
}

/** An entity prototype as written: its own components (fields as plain data, `type` dropped) and parents. */
export interface PrototypeDefinition {
    parents?: string[];
    abstract?: true;
    /** Localised description, when the prototype has one (MetaData's `desc`). */
    description?: string;
    components: Record<string, Record<string, unknown>>;
}

/** Full component data of every entity prototype (abstract ones included); inheritance is applied on load. */
export interface PrototypeData {
    entities: Record<string, PrototypeDefinition>;
}

/** An `EntityWhitelist` as written in prototypes (YAML keys): matches entities by components, item sizes or tags. */
export interface WhitelistData {
    components?: string[];
    sizes?: string[];
    tags?: string[];
    requireAll?: boolean;
}

/** What the game's container checks need besides the prototypes' own data (read from the fork's C# and prototypes). */
export interface ContainerRules {
    /** `itemSize` prototypes by id: weight and default shape (boxes "left,bottom,right,top"). */
    itemSizes: Record<string, { weight: number; shape: string[] }>;
    /** `ItemComponent.Size` when a prototype's Item sets none. */
    defaultItemSize: string;
    /** Storage max item size when the storage sets none and is not an item itself (`DefaultStorageMaxItemSize`). */
    defaultStorageMaxItemSize: string;
    entityStorage: {
        capacity: number;
        maxSize: number;
        /** What an entity storage admits when its prototype sets no whitelist. */
        whitelist: WhitelistData;
        /** Whether the fork's EntityStorage has a `blacklist` (older forks ignore one). */
        blacklist: boolean;
    };
    /**
     * Width and height of the entity's bounds as `GetAABBNoContainer` gives them (fixtures and the origin), for the
     * entities wider or taller than `boundsFloor`; the rest are at most that big.
     */
    boundsFloor: number;
    bounds: Record<string, [number, number]>;
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

/** Where a parallax layer's texture comes from (`IParallaxTextureSource`). */
export type ParallaxTexture =
    | { kind: "image"; path: string }
    /** Made by the client from a TOML config (`ParallaxGenerator`); the pack holds the image the generator makes. */
    | { kind: "generated"; id: string; configPath: string };

/** A layer of a parallax (`ParallaxLayerConfig`), with the client's defaults filled in. */
export interface ParallaxLayer {
    texture: ParallaxTexture;
    /** Image file in the pack (WebP), or null when there is none (missing texture, or a low-quality layer). */
    file: string | null;
    /** Texture size in px. */
    size: [number, number];
    /** The texture is sampled with filtering (`sample: filter: true` in its .png.yml); otherwise nearest. */
    filter?: true;
    scale: [number, number];
    tiled: boolean;
    slowness: number;
    /** World units per second. */
    scrolling: [number, number];
    worldHomePosition: [number, number];
    worldAdjustPosition: [number, number];
    /** Position in a ParallaxControl (menus); unused on maps. */
    controlHomePosition: [number, number];
    /** Shader prototype id; null for none ("" in the prototype). */
    shader: string | null;
}

/** A `parallax` prototype. The game draws `layers` unless low quality is chosen in its options. */
export interface ParallaxPrototype {
    layers: ParallaxLayer[];
    layersLQ: ParallaxLayer[];
    layersLQUseHQ: boolean;
    /** Small WebP of the layers as the game shows them around the origin at zoom 1, or null without layers. */
    thumbnail: string | null;
}

export interface ParallaxData {
    /** The parallax of maps without a `Parallax` component (`ParallaxSystem.Fallback`). */
    default: string;
    parallaxes: Record<string, ParallaxPrototype>;
}
