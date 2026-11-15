// Draws a scene onto a canvas in cached 1:1 chunks; the view follows a pan/zoom transform.
// Ported from the Shipyard viewer (resources/js/map-canvas.js), with frames taken from asset pack pages.
// A chunk draws only what the scene's spatial index has in its area, and an edit re-renders only the
// chunks it touched.
import type { Pack } from "../pack/loader";
import { PPM, Scene, type Rect, type SpriteLayer } from "./scene";
import { PARALLAX_ANCHOR } from "./parallax";

const CHUNK = 32; // tiles per cached chunk, rendered at 1:1
const MAX_CHUNKS = 96;
const MARGIN = 4; // tiles drawn around the tile area for sprites sticking out of the hull
const WHOLE_CHUNK = 64; // changed areas in a chunk above which it is drawn again whole

export interface View {
    /** Screen position (CSS px) of the top-left corner of the map bounds. */
    x: number;
    y: number;
    /** CSS px per texture px. */
    scale: number;
}

export interface CanvasOptions {
    powered: boolean;
    subfloor: boolean;
    /** Spawn points, spawners and other markers. */
    markers: boolean;
    tiles: boolean;
    decals: boolean;
    objects: boolean;
}

/** Whether a sprite layer is drawn with these options (power state, under-floor layers). */
export function layerVisible(s: SpriteLayer, o: CanvasOptions): boolean {
    if (s.power && (s.power === 1) !== o.powered) return false;
    if (s.subfloor) return o.subfloor;
    if (s.kind === "marker") return o.markers;
    return o.objects;
}

/**
 * Draws on top of the map after every paint (selection, ghosts, hovered tile). It gets a context in CSS px
 * and the scale (CSS px per tile); `MapCanvas.screenAt` turns world points into its coordinates.
 */
export type Overlay = (g: CanvasRenderingContext2D, tilePx: number) => void;

type Source = { img: CanvasImageSource; fx: number; fy: number; fw: number; fh: number };

/** A rendered chunk and the world areas an edit changed in it since. */
type Chunk = { canvas: HTMLCanvasElement; dirty: Rect[] };

/** Merges overlapping or touching rectangles, so an edit repaints a few areas rather than one per layer. */
function mergeRects(rects: Rect[]): Rect[] {
    const out: Rect[] = [];
    for (const r of rects) {
        let cur: Rect = [...r];
        for (let i = 0; i < out.length; ) {
            const o = out[i]!;
            if (o[0] <= cur[2] && cur[0] <= o[2] && o[1] <= cur[3] && cur[1] <= o[3]) {
                cur = [Math.min(o[0], cur[0]), Math.min(o[1], cur[1]), Math.max(o[2], cur[2]), Math.max(o[3], cur[3])];
                out.splice(i, 1);
                i = 0;
            } else i++;
        }
        out.push(cur);
    }
    return out;
}

export class MapCanvas {
    private readonly ctx: CanvasRenderingContext2D;
    private readonly chunks = new Map<string, Chunk>();
    private readonly tints = new Map<string, HTMLCanvasElement>();
    private pages: ImageBitmap[] = [];
    private pack: Pack | null = null;
    private scene: Scene | null = null;
    /** World position of the view's origin (top-left of the map when it was opened); edits do not move it. */
    private origin: [number, number] = [0, 0];
    /** Frames whose pages have been requested. */
    private framesSeen = 0;
    private pending = false;
    private overlayPending = false;
    private readonly overlayCtx: CanvasRenderingContext2D | null;
    /** 1×1 canvas for reading texture pixels (hit testing). */
    private probe: CanvasRenderingContext2D | null = null;
    /** Time of the last paint and the chunks it had to render. */
    readonly stats = { paintMs: 0, chunksRendered: 0, areasRepainted: 0 };
    options: CanvasOptions = { powered: true, subfloor: false, markers: true, tiles: true, decals: true, objects: true };
    view: View = { x: 0, y: 0, scale: 1 };
    /** Drawn on the overlay canvas, which lies over the map; redrawing it never touches the cached chunks. */
    overlay: Overlay | null = null;
    /** Drawn behind the map (the parallax) on every paint; it skips the work itself when the view has not moved. */
    background: { paint(view: { eye: [number, number]; scale: number }): void } | null = null;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly overlayCanvas: HTMLCanvasElement | null = null,
    ) {
        this.ctx = canvas.getContext("2d")!;
        this.overlayCtx = overlayCanvas?.getContext("2d") ?? null;
    }

    /** Shows a scene; resolves once the texture pages it uses are loaded. */
    async show(scene: Scene, pack: Pack): Promise<void> {
        this.pages = [];
        this.pack = pack;
        this.framesSeen = 0;
        await this.loadPages(scene);
        this.scene = scene;
        this.origin = [scene.bounds[0], scene.bounds[3]];
        this.chunks.clear();
        this.tints.clear();
        this.draw();
    }

    /**
     * Redraws what an edit changed: the chunks touching `rects`, or everything for null (see `Scene.apply`).
     * Texture pages the edit needs for the first time are loaded, and the area is drawn again once they are.
     */
    update(rects: Rect[] | null): void {
        if (!this.scene) return;
        this.invalidate(rects);
        this.draw();
        if (this.scene.frames.length > this.framesSeen) {
            const scene = this.scene;
            void this.loadPages(scene).then((added) => {
                if (!added || scene !== this.scene) return;
                this.invalidate(rects);
                this.draw();
            });
        }
    }

    private invalidate(rects: Rect[] | null): void {
        if (!rects) {
            this.chunks.clear();
            return;
        }
        // cached chunks repaint the changed areas when next drawn; the scene reports an area once per layer, so a
        // wall with its neighbours brings the same few areas many times
        const seen = new Set<string>();
        for (const r of rects) {
            const key = r.join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            const [x0, y0, x1, y1] = r;
            for (let i = Math.floor(x0 / CHUNK); i <= Math.floor(x1 / CHUNK); i++) {
                for (let j = Math.floor(y0 / CHUNK); j <= Math.floor(y1 / CHUNK); j++) {
                    const c = this.chunks.get(`${i},${j}`);
                    if (!c) continue;
                    const cx0 = i * CHUNK, cy0 = j * CHUNK;
                    c.dirty.push([Math.max(x0, cx0), Math.max(y0, cy0), Math.min(x1, cx0 + CHUNK), Math.min(y1, cy0 + CHUNK)]);
                }
            }
        }
    }

    /** Loads the pages of frames not seen yet; resolves to whether any page was added. */
    private async loadPages(scene: Scene): Promise<boolean> {
        const frames = scene.frames;
        const from = this.framesSeen;
        this.framesSeen = frames.length;
        const wanted = [...new Set(frames.slice(from).map((f) => f[0]))].filter((p) => !this.pages[p]);
        if (!wanted.length) return false;
        const loaded = await Promise.all(wanted.map((p) => this.pack!.page(p)));
        wanted.forEach((p, i) => (this.pages[p] = loaded[i]!));
        return true;
    }

    /** Map size in CSS px at scale 1. */
    get size(): { width: number; height: number } {
        const [x0, y0, x1, y1] = this.scene?.bounds ?? [0, 0, 1, 1];
        return { width: (x1 - x0) * PPM, height: (y1 - y0) * PPM };
    }

    setView(view: View): void {
        this.view = view;
        this.draw();
    }

    setOptions(options: Partial<CanvasOptions>): void {
        Object.assign(this.options, options);
        this.chunks.clear();
        this.draw();
    }

    /** World coordinates under a point given in CSS px relative to the canvas. */
    worldAt(px: number, py: number): [number, number] | null {
        if (!this.scene) return null;
        const [x0, y1] = this.origin;
        return [x0 + (px - this.view.x) / (PPM * this.view.scale), y1 - (py - this.view.y) / (PPM * this.view.scale)];
    }

    /** Point in CSS px relative to the canvas where world (wx, wy) is shown. */
    screenAt(wx: number, wy: number): [number, number] {
        const [x0, y1] = this.origin;
        const k = PPM * this.view.scale;
        return [this.view.x + (wx - x0) * k, this.view.y + (y1 - wy) * k];
    }

    /** A loaded texture page, or null (it is requested, and the overlay is drawn again once it loads). */
    pageImage(index: number): ImageBitmap | null {
        const img = this.pages[index];
        if (img || !this.pack) return img ?? null;
        const pack = this.pack;
        void pack.page(index).then((b) => {
            if (pack !== this.pack) return;
            this.pages[index] ??= b;
            this.drawOverlay();
        });
        return null;
    }

    /** Alpha (0..255) of a scene frame's texture pixel, or null while its page is loading. */
    frameAlpha(frame: number, tx: number, ty: number): number | null {
        const [page, fx, fy] = this.scene!.frames[frame]!;
        const img = this.pages[page];
        if (!img) return null;
        if (!this.probe) {
            const c = document.createElement("canvas");
            c.width = c.height = 1;
            this.probe = c.getContext("2d", { willReadFrequently: true })!;
        }
        this.probe.clearRect(0, 0, 1, 1);
        this.probe.drawImage(img, fx + tx, fy + ty, 1, 1, 0, 0, 1, 1);
        return this.probe.getImageData(0, 0, 1, 1).data[3]!;
    }

    draw(): void {
        if (this.pending || !this.scene) return;
        this.pending = true;
        requestAnimationFrame(() => {
            this.pending = false;
            this.paint();
        });
    }

    /**
     * Paints at once. For layout changes (a side panel opening or closing): called from a ResizeObserver,
     * which runs after layout and before the frame is shown, so the resized canvas never shows its old
     * bitmap stretched to the new size for a frame.
     */
    paintNow(): void {
        if (!this.scene) return;
        this.paint();
    }

    /** Redraws only the overlay (the map stays as it is). */
    drawOverlay(): void {
        if (this.overlayPending || this.pending || !this.overlayCtx) return;
        this.overlayPending = true;
        requestAnimationFrame(() => {
            this.overlayPending = false;
            this.paintOverlay();
        });
    }

    private paintOverlay(): void {
        const g = this.overlayCtx, c = this.overlayCanvas;
        if (!g || !c) return;
        const dpr = window.devicePixelRatio || 1;
        const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
        if (c.width !== W || c.height !== H) {
            c.width = W;
            c.height = H;
        }
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.clearRect(0, 0, W, H);
        if (!this.scene || !this.overlay) return;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.save();
        this.overlay(g, PPM * this.view.scale);
        g.restore();
    }

    private paint(): void {
        const started = performance.now();
        this.stats.chunksRendered = 0;
        this.stats.areasRepainted = 0;
        const { canvas, ctx } = this;
        const scene = this.scene!;
        const dpr = window.devicePixelRatio || 1;
        const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
        }
        const { x, y, scale } = this.view;
        const tilePx = PPM * scale * dpr;
        const [ox, oy] = this.origin;
        // shared rounded edges: neighbouring chunks meet exactly, so there are no seams at any zoom
        const toX = (wx: number) => Math.round(x * dpr + (wx - ox) * tilePx);
        const toY = (wy: number) => Math.round(y * dpr + (oy - wy) * tilePx);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, W, H);
        ctx.imageSmoothingEnabled = tilePx < PPM / 2; // smooth only when strongly zoomed out

        const [bx0, by0, bx1, by1] = scene.bounds.map((v, k) => v + (k < 2 ? -MARGIN : MARGIN)) as [number, number, number, number];
        const wx0 = Math.max(bx0, ox - (x * dpr) / tilePx), wx1 = Math.min(bx1, ox + (W - x * dpr) / tilePx);
        const wy1 = Math.min(by1, oy + (y * dpr) / tilePx), wy0 = Math.max(by0, oy - (H - y * dpr) / tilePx);
        for (let i = Math.floor(wx0 / CHUNK); i <= Math.floor(wx1 / CHUNK); i++) {
            for (let j = Math.floor(wy0 / CHUNK); j <= Math.floor(wy1 / CHUNK); j++) {
                const x0 = toX(i * CHUNK), x1 = toX((i + 1) * CHUNK), y0 = toY((j + 1) * CHUNK), y1 = toY(j * CHUNK);
                if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
                ctx.drawImage(this.chunk(i, j), x0, y0, x1 - x0, y1 - y0);
            }
        }
        if (this.background) this.background.paint({ eye: this.worldAt(PARALLAX_ANCHOR[0], PARALLAX_ANCHOR[1])!, scale });
        this.paintOverlay();
        this.stats.paintMs = performance.now() - started;
    }

    private chunk(i: number, j: number): HTMLCanvasElement {
        const key = `${i},${j}`;
        const ox = i * CHUNK, oy = (j + 1) * CHUNK, size = CHUNK * PPM;
        let c = this.chunks.get(key);
        if (!c) {
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = size;
            this.renderAt(canvas.getContext("2d")!, ox, oy, size, size);
            this.stats.chunksRendered++;
            if (this.chunks.size >= MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
            this.chunks.set(key, (c = { canvas, dirty: [] }));
        } else if (c.dirty.length > WHOLE_CHUNK) {
            // a big edit: drawing the chunk again is cheaper than merging its many areas
            this.renderAt(c.canvas.getContext("2d")!, ox, oy, size, size);
            this.stats.chunksRendered++;
            c.dirty = [];
        } else if (c.dirty.length) {
            const g = c.canvas.getContext("2d")!;
            for (const [x0, y0, x1, y1] of mergeRects(c.dirty)) {
                // whole pixels, so the cleared area is exactly the one drawn again (+1 for sprites snapped to pixels)
                const px0 = Math.max(0, Math.floor((x0 - ox) * PPM) - 1), px1 = Math.min(size, Math.ceil((x1 - ox) * PPM) + 1);
                const py0 = Math.max(0, Math.floor((oy - y1) * PPM) - 1), py1 = Math.min(size, Math.ceil((oy - y0) * PPM) + 1);
                if (px1 <= px0 || py1 <= py0) continue;
                this.renderAt(g, ox, oy, size, size, [px0, py0, px1, py1]);
                this.stats.areasRepainted++;
            }
            c.dirty = [];
        }
        return c.canvas;
    }

    visible(s: SpriteLayer): boolean {
        return layerVisible(s, this.options);
    }

    /**
     * Sprite layers drawn on the overlay context (CSS px), tinted as on the map, moved by a world vector and at an
     * opacity: placement ghosts. Layers whose page is still loading are left out until it loads.
     */
    drawSprites(g: CanvasRenderingContext2D, layers: readonly SpriteLayer[], [dx, dy]: readonly [number, number], alpha: number): void {
        const frames = this.scene?.frames;
        if (!frames) return;
        const k = this.view.scale;
        g.save();
        const base = g.getTransform();
        g.imageSmoothingEnabled = false;
        for (const s of layers) {
            const f = frames[s.frame];
            if (!f || !this.pageImage(f[0])) continue;
            const src = this.frame(s.frame, s.color);
            if (!src) continue;
            const [sx, sy] = this.screenAt(s.x + dx, s.y + dy);
            g.setTransform(base);
            g.translate(sx, sy);
            if (s.rot) g.rotate(-s.rot);
            if (s.scale) g.scale(s.scale[0], s.scale[1]);
            g.globalAlpha = alpha * (s.color ? (s.color[3] ?? 1) : 1);
            g.drawImage(src.img, src.fx, src.fy, src.fw, src.fh, (-src.fw / 2) * k, (-src.fh / 2) * k, src.fw * k, src.fh * k);
        }
        g.restore();
    }

    /** A frame, tinted when coloured; null while its page is loading. */
    private frame(fi: number, color: number[] | null): Source | null {
        const [page, fx, fy, fw, fh] = this.scene!.frames[fi]!;
        const img = this.pages[page];
        if (!img) return null;
        if (!color || (color[0] === 1 && color[1] === 1 && color[2] === 1)) return { img, fx, fy, fw, fh };
        const key = `${fi}:${color[0]},${color[1]},${color[2]}`;
        let c = this.tints.get(key);
        if (!c) {
            c = document.createElement("canvas");
            c.width = fw;
            c.height = fh;
            const g = c.getContext("2d")!;
            g.drawImage(img, fx, fy, fw, fh, 0, 0, fw, fh);
            g.globalCompositeOperation = "multiply";
            g.fillStyle = `rgb(${color[0]! * 255},${color[1]! * 255},${color[2]! * 255})`;
            g.fillRect(0, 0, fw, fh);
            g.globalCompositeOperation = "destination-in";
            g.drawImage(img, fx, fy, fw, fh, 0, 0, fw, fh);
            this.tints.set(key, c);
        }
        return { img: c, fx: 0, fy: 0, fw, fh };
    }

    // One quad centred at world (x, y) into a 1:1 canvas whose top-left is world (ox, oy).
    private blit(g: CanvasRenderingContext2D, ox: number, oy: number, W: number, H: number, x: number, y: number, fi: number, color: number[] | null, pre: ((c: CanvasRenderingContext2D) => void) | null): void {
        const src = this.frame(fi, color);
        if (!src) return;
        const sx = (x - ox) * PPM, sy = (oy - y) * PPM;
        const half = Math.max(src.fw, src.fh);
        if (sx < -half || sy < -half || sx > W + half || sy > H + half) return;
        g.globalAlpha = color ? (color[3] ?? 1) : 1;
        if (!pre) {
            // whole texture pixels: an exact 1:1 copy never samples outside the frame
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.drawImage(src.img, src.fx, src.fy, src.fw, src.fh, Math.round(sx - src.fw / 2), Math.round(sy - src.fh / 2), src.fw, src.fh);
            return;
        }
        g.setTransform(1, 0, 0, 1, Math.round(sx - src.fw / 2) + src.fw / 2, Math.round(sy - src.fh / 2) + src.fh / 2);
        pre(g);
        g.drawImage(src.img, src.fx, src.fy, src.fw, src.fh, -src.fw / 2, -src.fh / 2, src.fw, src.fh);
    }

    /**
     * Renders the scene into a 1:1 canvas whose top-left is world (ox, oy): all of it, or only the pixel
     * area `clip` ([x0, y0, x1, y1]), redrawing everything that touches it in the usual order.
     */
    private renderAt(g: CanvasRenderingContext2D, ox: number, oy: number, W: number, H: number, clip?: [number, number, number, number]): void {
        const scene = this.scene!;
        const options = this.options;
        const [px0, py0, px1, py1] = clip ?? [0, 0, W, H];
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.imageSmoothingEnabled = false;
        if (clip) {
            g.beginPath();
            g.rect(px0, py0, px1 - px0, py1 - py0);
            g.clip();
        }
        g.clearRect(px0, py0, px1 - px0, py1 - py0);
        // world area being drawn, with a pixel for sprites snapped to whole pixels
        const x0 = ox + (px0 - 1) / PPM, x1 = ox + (px1 + 1) / PPM, y0 = oy - (py1 + 1) / PPM, y1 = oy - (py0 - 1) / PPM;
        if (options.tiles) {
            const tiles = scene.tiles.query(x0, y0, x1, y1).sort((a, b) => a.grid - b.grid);
            for (const { x, y, gridRot: gr, rotMirror: rm, frame } of tiles) {
                this.blit(g, ox, oy, W, H, x, y, frame, null, (c) => {
                    if (gr) c.rotate(-gr);
                    if (rm > 3) c.scale(-1, 1);
                    if (rm % 4) c.rotate((-(rm % 4) * Math.PI) / 2);
                });
            }
        }
        if (options.decals) {
            const decals = scene.decals.query(x0, y0, x1, y1).sort((a, b) => a.z - b.z || a.seq - b.seq);
            for (const { x, y, rot: r, frame, color } of decals) this.blit(g, ox, oy, W, H, x, y, frame, color, r ? (c) => c.rotate(-r) : null);
        }
        for (const s of Scene.sortSprites(scene.sprites.query(x0, y0, x1, y1))) {
            if (!this.visible(s)) continue;
            this.blit(g, ox, oy, W, H, s.x, s.y, s.frame, s.color, spritePre(s));
        }
        g.restore();
    }
}

// rotation, then per-layer scale
function spritePre(s: SpriteLayer): ((c: CanvasRenderingContext2D) => void) | null {
    if (!s.rot && !s.scale) return null;
    return (c) => {
        if (s.rot) c.rotate(-s.rot);
        if (s.scale) c.scale(s.scale[0], s.scale[1]);
    };
}
