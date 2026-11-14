// Where the game draws a parallax layer (Content.Client/Parallax/ParallaxOverlay.cs), without drawing: shared by the
// editor's background and the pack builder's thumbnails. World units are tiles, y up.
import type { ParallaxLayer } from "../pack/format";

/** `EyeManager.PixelsPerMeter`: texture px per world unit at zoom 1. */
export const PIXELS_PER_METER = 32;

export type Vec2 = [number, number];

/** Size of the layer's texture in world units: `tex.Size / PixelsPerMeter * Scale`. */
export function layerSize(layer: Pick<ParallaxLayer, "size" | "scale">): Vec2 {
    return [(layer.size[0] / PIXELS_PER_METER) * layer.scale[0], (layer.size[1] / PIXELS_PER_METER) * layer.scale[1]];
}

/**
 * Bottom-left corner (world) of the layer's texture for an eye at `eye`, `time` seconds into the game: the
 * home is the layer's `worldHomePosition` plus the parallax anchor (always zero in the game); the layer shifts from
 * its home towards the eye by `slowness` (0 stays with the world, 1 with the camera), moves by `scrolling` per
 * second, then by `worldAdjustPosition`, and is centred. A tiled layer repeats from this corner in steps of its size.
 */
export function layerOrigin(layer: ParallaxLayer, eye: Vec2, time = 0, anchor: Vec2 = [0, 0]): Vec2 {
    const [w, h] = layerSize(layer);
    const out: Vec2 = [0, 0];
    for (const k of [0, 1] as const) {
        const home = layer.worldHomePosition[k] + anchor[k];
        out[k] = (eye[k] - home) * layer.slowness + layer.scrolling[k] * time + home + layer.worldAdjustPosition[k] - (k === 0 ? w : h) / 2;
    }
    return out;
}

/**
 * The first tile of a tiled layer at or left/below the bottom-left of the visible world area, as the game's loop
 * starts: `floor((aabbBL - origin) / size) * size + origin`.
 */
export function firstTile(origin: Vec2, size: Vec2, aabbBL: Vec2): Vec2 {
    return [Math.floor((aabbBL[0] - origin[0]) / size[0]) * size[0] + origin[0], Math.floor((aabbBL[1] - origin[1]) / size[1]) * size[1] + origin[1]];
}
