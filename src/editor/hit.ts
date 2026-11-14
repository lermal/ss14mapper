// What the mapper points at: the topmost drawn entity under a world point, in drawing order, tested
// against the pixels of its sprite layers.
import { PPM, Scene, type SpriteLayer } from "../render/scene";

/** Whether a texture pixel of a frame is drawn (not transparent); [tx, ty] from the frame's top-left. */
export type OpaqueTest = (frame: number, tx: number, ty: number) => boolean;

/**
 * Texture pixel of a layer at world (x, y), or null outside its frame. Mirrors how the canvas draws a
 * layer: centred at (x, y), rotated by `rot`, then scaled.
 */
export function texelAt(s: SpriteLayer, fw: number, fh: number, x: number, y: number): [number, number] | null {
    // texture px from the layer centre, y down as on the canvas
    const dx = (x - s.x) * PPM, dy = (s.y - y) * PPM;
    const c = Math.cos(s.rot), n = Math.sin(s.rot);
    let u = c * dx - n * dy, v = n * dx + c * dy;
    if (s.scale) {
        if (!s.scale[0] || !s.scale[1]) return null;
        u /= s.scale[0];
        v /= s.scale[1];
    }
    const tx = Math.floor(u + fw / 2), ty = Math.floor(v + fh / 2);
    return tx >= 0 && ty >= 0 && tx < fw && ty < fh ? [tx, ty] : null;
}

/**
 * Uid of the entity drawn on top at world (x, y) among the layers `visible` accepts, or null. Without
 * `opaque`, a layer counts wherever its frame is; with it, only where the pixel is drawn. `accept` skips
 * entities (the multitool picks only devices).
 */
export function entityAt(scene: Scene, x: number, y: number, visible: (s: SpriteLayer) => boolean, opaque?: OpaqueTest, accept?: (uid: number) => boolean): number | null {
    const layers = Scene.sortSprites(scene.sprites.query(x, y, x, y).filter(visible));
    const verdict = new Map<number, boolean>();
    for (let i = layers.length - 1; i >= 0; i--) {
        const s = layers[i]!;
        if (accept) {
            let ok = verdict.get(s.uid);
            if (ok === undefined) verdict.set(s.uid, (ok = accept(s.uid)));
            if (!ok) continue;
        }
        if (s.color && (s.color[3] ?? 1) === 0) continue;
        const [, , , fw, fh] = scene.frames[s.frame]!;
        const t = texelAt(s, fw, fh, x, y);
        if (t && (!opaque || opaque(s.frame, t[0], t[1]))) return s.uid;
    }
    return null;
}
