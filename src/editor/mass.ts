// Mass and centre of mass of a grid, in the grid's own coordinates. Pure computation, no DOM.
//
// "game": what the game's physics gives the grid body. The engine covers each 16×16 chunk with rectangles of
// tiles (GridChunkPartition.PartitionChunk), makes one fixture per rectangle shrunk by the polygon radius on
// every side (SharedGridFixtureSystem, physics.grid_fixture_enlargement = -PhysicsConstants.PolygonRadius) and
// gives all of them the same density (SharedShuttleSystem.TileDensityMultiplier). Entities on the grid have
// bodies of their own and add nothing, anchored or not.
//
// "entities": tiles weighing their ContentTileDefinition.Mass plus the fixture mass of every entity body on the
// grid, as ShuttleSystem.GetRegionMass sums a region for impacts. The game has no such centre; it shows where
// the weight of the contents is.

/** PhysicsConstants.PolygonRadius (2 × LinearSlop). */
export const POLYGON_RADIUS = 0.01;
export const CHUNK_SIZE = 16;

/** Tile rectangle [x0, y0, x1, y1), x1 and y1 exclusive. */
export type Rect = [number, number, number, number];

/** Mass and first moments: adding them up combines parts, dividing gives the centre. */
export interface Moments {
    mass: number;
    mx: number;
    my: number;
}

export interface MassResult {
    mass: number;
    /** Null when there is no mass. */
    centre: [number, number] | null;
}

/** An entity body on the grid: position and rotation (radians, counter-clockwise) in grid coordinates. */
export interface MassEntity {
    x: number;
    y: number;
    rot?: number;
    /** Body mass from the pack (`EntityPrototype.mass`). */
    mass: number;
    /** Centre of the body in the entity's coordinates (`EntityPrototype.massCentre`). */
    centre?: [number, number];
}

export const ZERO: Moments = { mass: 0, mx: 0, my: 0 };

export function add(a: Moments, b: Moments): Moments {
    return { mass: a.mass + b.mass, mx: a.mx + b.mx, my: a.my + b.my };
}

export function result(m: Moments): MassResult {
    return { mass: m.mass, centre: m.mass > 0 ? [m.mx / m.mass, m.my / m.mass] : null };
}

/**
 * Rectangles the engine builds for one chunk, in chunk-local tile coordinates: runs of tiles along each row,
 * then runs of the same width stacked on the rows below joined (GridChunkPartition.PartitionChunk).
 */
export function partitionChunk(has: (x: number, y: number) => boolean, size = CHUNK_SIZE): Rect[] {
    const rects: Rect[] = [];
    for (let y = 0; y < size; y++) {
        let origin = 0;
        let running = false;
        for (let x = 0; x < size; x++) {
            if (has(x, y)) {
                running = true;
                continue;
            }
            if (running) rects.push([origin, y, x, y + 1]);
            origin = x + 1;
            running = false;
        }
        if (running) rects.push([origin, y, size, y + 1]);
    }
    for (let i = rects.length - 1; i >= 0; i--) {
        let box = rects[i]!;
        for (let j = i - 1; j >= 0; j--) {
            const other = rects[j]!;
            if (other[3] < box[1]) break;
            if (box[0] === other[0] && box[2] === other[2]) {
                box = [box[0], other[1], box[2], box[3]];
                rects[i] = box;
                rects.splice(j, 1);
                i--;
            }
        }
    }
    return rects;
}

/** Body moments of one chunk's tiles; `has` takes chunk-local coordinates. */
export function chunkBody(cx: number, cy: number, has: (x: number, y: number) => boolean, density: number, size = CHUNK_SIZE): Moments {
    let mass = 0, mx = 0, my = 0;
    for (const [x0, y0, x1, y1] of partitionChunk(has, size)) {
        const m = density * Math.max(0, x1 - x0 - 2 * POLYGON_RADIUS) * Math.max(0, y1 - y0 - 2 * POLYGON_RADIUS);
        mass += m;
        mx += m * (cx * size + (x0 + x1) / 2);
        my += m * (cy * size + (y0 + y1) / 2);
    }
    return { mass, mx, my };
}

/** Groups tiles by chunk: chunk key → [cx, cy, set of local x + y * size]. */
function chunks(tiles: Iterable<readonly [number, number, ...unknown[]]>, size: number): Map<string, [number, number, Set<number>]> {
    const out = new Map<string, [number, number, Set<number>]>();
    for (const [x, y] of tiles) {
        const cx = Math.floor(x / size), cy = Math.floor(y / size);
        const key = `${cx},${cy}`;
        let c = out.get(key);
        if (!c) out.set(key, (c = [cx, cy, new Set()]));
        c[2].add(x - cx * size + (y - cy * size) * size);
    }
    return out;
}

/** The grid body as the game computes it, from the non-space tiles [x, y]. */
export function gridBody(tiles: Iterable<readonly [number, number, ...unknown[]]>, density: number, size = CHUNK_SIZE): Moments {
    let sum = ZERO;
    for (const [cx, cy, cells] of chunks(tiles, size).values()) {
        sum = add(sum, chunkBody(cx, cy, (x, y) => cells.has(x + y * size), density, size));
    }
    return sum;
}

/** Tiles [x, y, mass] each weighing its mass at its centre. */
export function tileMoments(tiles: Iterable<readonly [number, number, number]>): Moments {
    let mass = 0, mx = 0, my = 0;
    for (const [x, y, m] of tiles) {
        mass += m;
        mx += m * (x + 0.5);
        my += m * (y + 0.5);
    }
    return { mass, mx, my };
}

export function entityMoments(entities: Iterable<MassEntity>): Moments {
    let mass = 0, mx = 0, my = 0;
    for (const e of entities) {
        if (!(e.mass > 0)) continue;
        let x = e.x, y = e.y;
        if (e.centre) {
            const c = Math.cos(e.rot ?? 0), s = Math.sin(e.rot ?? 0);
            x += c * e.centre[0] - s * e.centre[1];
            y += s * e.centre[0] + c * e.centre[1];
        }
        mass += e.mass;
        mx += e.mass * x;
        my += e.mass * y;
    }
    return { mass, mx, my };
}

export interface GridMassInput {
    /** Non-space tiles: [x, y, tile mass (`TileDefinition.mass`)]. */
    tiles: ReadonlyArray<readonly [number, number, number]>;
    /** Bodies of the entities on the grid (not those inside containers). */
    entities?: Iterable<MassEntity>;
    /** `PrototypeIndex.tileDensity`. */
    tileDensity: number;
    /** `MapGrid.chunkSize`, 16 by default. */
    chunkSize?: number;
}

/** Both modes for one grid. */
export function gridMass(input: GridMassInput): { game: MassResult; entities: MassResult } {
    const game = gridBody(input.tiles, input.tileDensity, input.chunkSize ?? CHUNK_SIZE);
    const withEntities = add(tileMoments(input.tiles), entityMoments(input.entities ?? []));
    return { game: result(game), entities: result(withEntities) };
}
