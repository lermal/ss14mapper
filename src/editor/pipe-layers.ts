// Pipe layers as the game's placement picks them (Content.Client/Atmos/AlignAtmosPipeLayers.cs). An entity placed in
// the AlignAtmosPipeLayers mode is swapped for its prototype of the layer the cursor points at within the tile: the
// primary near the centre, the secondary towards the top or right, the tertiary towards the bottom or left. Each layer
// has its own prototype, listed in AtmosPipeLayers.alternativePrototypes (Frontier, Goob) or defined together with
// `!type:CreateVariants` (upstream).
import type { Pack } from "../pack/loader";

export const PIPE_LAYER_NAMES = ["Primary", "Secondary", "Tertiary"] as const;

/** Cursor distance from the tile centre (tiles) within which the game keeps the primary layer. */
const DEADZONE = 0.25;
/** How far the game's guide circles of the other layers sit from the tile centre along each axis (tiles). */
const GUIDE_OFFSET = 0.21875;

/**
 * The prototype of each pipe layer (primary, secondary, tertiary) for an entity placed in the AlignAtmosPipeLayers
 * mode, or null when its layer is not chosen on placing. A layer without a prototype of its own keeps `proto`.
 */
export function layerPrototypes(pack: Pack, proto: string): string[] | null {
    const def = pack.prototypes.entities[proto];
    if (!def || def.placement?.mode !== "AlignAtmosPipeLayers") return null;
    const alt = (def.components.AtmosPipeLayers as { alternativePrototypes?: unknown } | undefined)?.alternativePrototypes;
    let ids: unknown[];
    if (def.variants) ids = def.variants;
    else if (alt && typeof alt === "object") ids = PIPE_LAYER_NAMES.map((name, i) => (alt as Record<string, unknown>)[name] ?? (alt as Record<string, unknown>)[i]);
    else return null;
    const out = PIPE_LAYER_NAMES.map((_, i) => {
        const id = ids[i];
        return typeof id === "string" && pack.prototypes.entities[id] ? id : proto;
    });
    return out.some((id) => id !== proto) ? out : null;
}

/**
 * The layer the game picks for a cursor offset from the tile centre (a world vector in tiles; the editor's view is
 * never turned): `(Angle(offset) + π/2).GetCardinalDir()`, north or east giving the secondary layer.
 */
export function layerForOffset(dx: number, dy: number): number {
    if (Math.hypot(dx, dy) <= DEADZONE) return 0;
    const dir = cardinalDir(Math.atan2(dy, dx) + Math.PI / 2);
    return dir === EAST || dir === NORTH ? 1 : 2;
}

/**
 * Where the game draws its guide circles around the tile centre (world offsets in tiles) on a grid turned by
 * `gridRot`, each with the layer the cursor picks there.
 */
export function layerGuides(gridRot: number): Array<{ dx: number; dy: number; layer: number }> {
    // AlignAtmosPipeLayers.Render: (a, a) mirrored to (-a, a) when the grid faces north or south, turned with the grid
    const facing = cardinalDir(gridRot + Math.PI / 2);
    const vx = (facing === NORTH || facing === SOUTH ? -1 : 1) * GUIDE_OFFSET, vy = GUIDE_OFFSET;
    const c = Math.cos(gridRot), s = Math.sin(gridRot);
    const dx = c * vx - s * vy, dy = s * vx + c * vy;
    return [
        { dx: 0, dy: 0, layer: 0 },
        { dx, dy, layer: layerForOffset(dx, dy) },
        { dx: -dx, dy: -dy, layer: layerForOffset(-dx, -dy) },
    ];
}

// Robust's Direction values
const SOUTH = 0, EAST = 2, NORTH = 4;

/** Angle.GetCardinalDir: the Direction nearest an angle (0 is south, counter-clockwise). */
function cardinalDir(theta: number): number {
    let ang = theta % (2 * Math.PI);
    if (ang < 0) ang += 2 * Math.PI;
    return (Math.floor((ang + Math.PI / 4) / (Math.PI / 2)) * 2) % 8;
}
