// Where edits put entities: tile centres for prototypes the game places on the grid, whole texture
// pixels otherwise (so free positions stay short in the file).
import type { EntityPrototype } from "../pack/format";
import { PPM } from "../render/scene";

/** Placement modes of the game's spawn menu that put an entity anywhere rather than on a tile. */
const FREE_MODES = new Set(["PlaceFree", "PlaceNearby"]);

/** Whether placing a prototype snaps it to a tile centre (`placement.mode`; the game's default is PlaceFree). */
export function snapsToTile(proto: EntityPrototype | undefined): boolean {
    const mode = proto?.placement?.mode;
    return typeof mode === "string" && !FREE_MODES.has(mode);
}

/** Centre of the tile a grid coordinate lies in. */
export const tileCenter = (v: number): number => Math.floor(v) + 0.5;

/** Rounded to whole texture pixels (1/32 tile). */
export const toPixel = (v: number): number => Math.round(v * PPM) / PPM;

/** A rotation turned by quarter turns (positive: counter-clockwise, as the game counts angles). */
export const quarterTurn = (rot: number, turns: number): number => rot + (turns * Math.PI) / 2;
