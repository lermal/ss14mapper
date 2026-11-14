// New, empty map files in the shape the game saves them: a shuttle (one grid) or a map with a grid.
// The component lists and field values of each fork's grid come from the recent maps of its corpus (see FORKS).
import type { Pack } from "../pack/loader";
import { MapDocument, formatSaveTime } from "./document";
import { formatScalar } from "./yaml";

export type NewMapKind = "shuttle" | "map";

export interface NewMapOptions {
    kind: NewMapKind;
    /** Name of the grid (shuttle) or of the map. */
    name: string;
    /** The build the map is made for: its engine and fork versions and prototypes. */
    pack: Pack;
    /** Tiles of a starting floor, if any (a w×h rectangle of this tile at the grid origin). */
    floor?: { tile: string; width: number; height: number };
    /** Engine version to write instead of the fork's usual one. */
    engineVersion?: string;
    /** Save time to write (the current time by default). */
    now?: Date;
}

/** Tiles offered as a starting floor, in this order, when the pack has them. */
export const STARTING_FLOORS = ["Plating", "FloorSteel", "FloorDark", "FloorWhite", "Lattice"];

/** The starting floor tiles of a pack: the usual ones that exist in it. */
export function startingFloors(pack: Pack): string[] {
    return STARTING_FLOORS.filter((t) => pack.tile(t) !== null);
}

/** Largest side of a starting floor, in tiles. */
export const MAX_FLOOR_SIDE = 256;

/** What the game writes for a fresh grid on a given fork: grid components after MapGrid, in the game's order. */
interface ForkShape {
    /** `meta.engineVersion` of the newest maps of the fork's corpus (older files load in a newer engine). */
    engineVersion: string;
    /** Components after MapGrid, as the game saves them, indented for the entity's component list. */
    components: string[][];
}

const component = (type: string, ...fields: string[]): string[] => [`- type: ${type}`, ...fields.map((f) => "  " + f)];

const gravity = component("Gravity", "gravityShakeSound: !type:SoundPathSpecifier", "  path: /Audio/Effects/alert.ogg");
const gridAtmosphere = component("GridAtmosphere", "version: 2", "data:", "  chunkSize: 4");
const decalGrid = component("DecalGrid", "chunkCollection:", "  version: 2", "  nodes: []");
const physicsUpstream = component("Physics", "linearDamping: 0.05", "fixedRotation: False", "bodyType: Dynamic", "bodyStatus: InAir", "angularDamping: 0.05");
const physicsFork = component("Physics", "bodyStatus: InAir", "angularDamping: 0.05", "linearDamping: 0.05", "fixedRotation: False", "bodyType: Dynamic");
const fixtures = component("Fixtures", "fixtures: {}");
const plain = (type: string) => component(type);

const FORKS: Record<string, ForkShape> = {
    // 91 grids of maps saved by engine 289+; grids without decals have no DecalGrid
    upstream: {
        engineVersion: "296.0.0",
        components: [
            plain("Broadphase"), physicsUpstream, fixtures, plain("OccluderTree"), plain("SpreaderGrid"),
            component("Shuttle", "dampingModifier: 0.25"), plain("GridPathfinding"), gravity, gridAtmosphere,
            plain("GasTileOverlay"), plain("RadiationGridResistance"), plain("ImplicitRoof"),
        ],
    },
    // 79 grids saved by engine 267; every grid has DecalGrid
    frontier: {
        engineVersion: "267.3.0",
        components: [
            plain("Broadphase"), physicsFork, fixtures, plain("OccluderTree"), plain("SpreaderGrid"),
            component("Shuttle", "dampingModifier: 0.25"), plain("GridPathfinding"), gravity, decalGrid, gridAtmosphere,
            plain("GasTileOverlay"), plain("RadiationGridResistance"), plain("ImplicitRoof"),
        ],
    },
    // 34 shuttle and 53 map grids saved by engine 264+; shuttles carry FTLDrive and the Shuttle damping table
    goob: {
        engineVersion: "292.0.0",
        components: [
            plain("Broadphase"), physicsFork, fixtures, plain("OccluderTree"), plain("SpreaderGrid"),
            component("Shuttle", "dampingModifiers:", "  Cruise: 0.0075", "  Dampen: 0.25", "  Anchor: 2", "  None: 0.25", "dampingModifier: 0.25"),
            plain("GridPathfinding"), gravity, decalGrid, gridAtmosphere, plain("GasTileOverlay"),
            plain("RadiationGridResistance"), plain("ImplicitRoof"), plain("FTLDrive"),
        ],
    },
};

/** The text of a new map file that the game loads and that the editor opens like any other map. */
export function newMapText(options: NewMapOptions): string {
    const { kind, name, pack, floor } = options;
    if (kind !== "shuttle" && kind !== "map") throw new Error(`Unknown kind of map: ${String(kind)}`);
    if (!name.trim() || /[\r\n]/.test(name)) throw new Error("The name must be one non-empty line");
    const forkId = pack.manifest.fork.id;
    // forks without a shape of their own are close to upstream
    const shape = FORKS[forkId] ?? FORKS.upstream!;
    const now = options.now ?? new Date();
    if (floor) {
        const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_FLOOR_SIDE;
        if (!ok(floor.width) || !ok(floor.height)) throw new Error(`The floor must be 1 to ${MAX_FLOOR_SIDE} tiles on each side`);
        if (floor.tile === "Space" || !pack.tile(floor.tile)) throw new Error(`Unknown floor tile: ${floor.tile}`);
    }

    const isMap = kind === "map";
    const gridUid = isMap ? 2 : 1;
    const out: string[] = [
        "meta:",
        "  format: 7",
        `  category: ${isMap ? "Map" : "Grid"}`,
        `  engineVersion: ${options.engineVersion ?? shape.engineVersion}`,
        '  forkId: ""',
        '  forkVersion: ""',
        `  time: ${formatSaveTime(now)}`,
        `  entityCount: ${isMap ? 2 : 1}`,
        isMap ? "maps:\n- 1" : "maps: []",
        "grids:",
        `- ${gridUid}`,
        isMap ? "orphans: []" : "orphans:\n- 1",
        "nullspace: []",
        "tilemap:",
        "  0: Space",
        "entities:",
        '- proto: ""',
        "  entities:",
    ];
    const entity = (uid: number, comps: string[][]) => {
        out.push(`  - uid: ${uid}`, "    components:");
        for (const c of comps) for (const line of c) out.push("    " + line);
    };
    if (isMap) {
        entity(1, [
            component("MetaData", `name: ${formatScalar(name)}`), plain("Transform"), component("Map", "mapPaused: True"),
            plain("GridTree"), plain("Broadphase"), plain("OccluderTree"),
        ]);
    }
    entity(gridUid, [
        component("MetaData", `name: ${formatScalar(isMap ? "grid" : name)}`),
        component("Transform", `parent: ${isMap ? 1 : "invalid"}`),
        component("MapGrid", "chunks: {}"),
        ...shape.components,
    ]);
    out.push("...", "");
    const text = out.join("\n");
    if (!floor) return text;

    // the floor goes in through the document so the chunks and the tilemap are written as for any painted tile
    const doc = new MapDocument(text);
    const cells = [];
    for (let y = 0; y < floor.height; y++) for (let x = 0; x < floor.width; x++) cells.push({ x, y, name: floor.tile });
    doc.setTiles(gridUid, cells);
    return doc.serialize(now);
}
