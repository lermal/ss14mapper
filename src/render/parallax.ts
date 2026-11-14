// The game's parallax background on its own canvas behind the map (the map canvas is transparent where it has
// nothing). Layers are placed as ParallaxOverlay places them (parallax-math.ts) for an eye at the centre of the view,
// with time stopped at 0 (layers that scroll stay put). The game draws parallax in world units, so at the editor's
// far zoom-outs the textures would shrink to a dense repeating pattern: the background is drawn at the zoom the
// game would use nearest to the editor's, from 1 (the game's default zoom, 32 px per tile) to 3.375 (its closest
// zoom), and only the offsets follow the eye. Redrawn when the view moves, never by edits.
import type { Pack } from "../pack/loader";
import type { ParallaxData, ParallaxLayer } from "../pack/format";
import { layerOrigin, layerSize, PIXELS_PER_METER, type Vec2 } from "./parallax-math";

/** The game's eye zoom range as editor scales (CSS px per texture px): ContentEye MaxZoom 1 to MinZoom 1.5^-3. */
export const PARALLAX_MIN_SCALE = 1;
export const PARALLAX_MAX_SCALE = 1.5 ** 3;

/**
 * The canvas point (CSS px from the top left) the parallax is centred on. A fixed point rather than the centre of
 * the canvas: the map keeps its place when a side panel opens and the canvas changes width, and so must the
 * background (a centre would move with the width).
 */
export const PARALLAX_ANCHOR: [number, number] = [640, 400];

/** What the map shows: the world point under PARALLAX_ANCHOR and the editor's scale. */
export interface BackgroundView {
    eye: Vec2;
    /** CSS px per texture px (the map's view scale). */
    scale: number;
}

const STORAGE_KEY = "ss14mapper.view.parallax";

/** The scale the background is drawn at for an editor scale. */
export function parallaxScale(scale: number): number {
    return Math.min(PARALLAX_MAX_SCALE, Math.max(PARALLAX_MIN_SCALE, scale));
}

/**
 * Where a layer's texture goes on a canvas of `width`×`height` px for `view`, with `ppx` canvas px per CSS px:
 * the top-left corner and the size of one copy, in canvas px.
 */
export function layerRect(layer: ParallaxLayer, view: BackgroundView, width: number, height: number, ppx = 1, centre: [number, number] = [width / 2, height / 2]): { x: number; y: number; w: number; h: number } {
    const k = PIXELS_PER_METER * parallaxScale(view.scale) * ppx;
    const [sw, sh] = layerSize(layer);
    const [ox, oy] = layerOrigin(layer, view.eye);
    return { x: centre[0] + (ox - view.eye[0]) * k, y: centre[1] - (oy + sh - view.eye[1]) * k, w: sw * k, h: sh * k };
}

interface Loaded {
    layer: ParallaxLayer;
    img: ImageBitmap | null;
    pattern: CanvasPattern | null;
}

export class ParallaxBackground {
    private readonly ctx: CanvasRenderingContext2D;
    private on: boolean;
    private pack: Pack | null = null;
    private id: string | null = null;
    private layers: Loaded[] = [];
    private view: BackgroundView | null = null;
    /** What the canvas shows now, so map repaints that do not move the view leave it alone. */
    private drawn = "";
    private token = 0;
    /** The pack and parallax whose layers were requested, and the request in progress. */
    private loadedFor: string | null = null;
    private loading: Promise<void> | null = null;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly storage: Pick<Storage, "getItem" | "setItem"> | null = globalThis.localStorage ?? null,
    ) {
        this.ctx = canvas.getContext("2d")!;
        let stored: string | null = null;
        try {
            stored = storage?.getItem(STORAGE_KEY) ?? null;
        } catch {
            // denied
        }
        this.on = stored !== "0";
    }

    get enabled(): boolean {
        return this.on;
    }

    /** Turns the background on or off (remembered across sessions); turned on, it loads what it shows. */
    setEnabled(on: boolean): void {
        if (on === this.on) return;
        this.on = on;
        try {
            this.storage?.setItem(STORAGE_KEY, on ? "1" : "0");
        } catch {
            // not remembered
        }
        if (on && this.pack && this.loadedFor !== this.key()) void this.load();
        this.repaint();
    }

    /** The parallax shown (null: none). */
    get current(): string | null {
        return this.id;
    }

    private key(): string {
        return `${this.pack?.manifest.files.parallax ?? ""}|${this.id ?? ""}`;
    }

    /**
     * Shows parallax `id` of `pack` (null: none); resolves once its layer images are loaded (or failed to load).
     * Nothing is loaded while the background is off.
     */
    async show(pack: Pack, id: string | null): Promise<void> {
        if (pack === this.pack && id === this.id) return this.loading ?? undefined;
        this.token++;
        this.pack = pack;
        this.id = id;
        this.layers = [];
        this.loadedFor = null;
        this.repaint();
        if (this.on) await this.load();
    }

    private load(): Promise<void> {
        const token = ++this.token;
        const pack = this.pack!, id = this.id;
        this.loadedFor = this.key();
        const run = async () => {
            if (id === null) return;
            let data: ParallaxData | null = null;
            try {
                data = await pack.parallax();
            } catch {
                data = null;
            }
            const proto = data?.parallaxes[id];
            if (token !== this.token || !proto) return;
            const loaded = await Promise.all(
                proto.layers.map(async (layer): Promise<Loaded> => ({ layer, img: layer.file ? await pack.image(layer.file).catch(() => null) : null, pattern: null })),
            );
            if (token !== this.token) return;
            this.layers = loaded;
            this.repaint();
        };
        const p = run().finally(() => {
            if (this.loading === p) this.loading = null;
        });
        this.loading = p;
        return p;
    }

    /** Draws for the map's view; does nothing when the view and the parallax are as drawn already. */
    paint(view: BackgroundView): void {
        this.view = view;
        const c = this.canvas;
        const dpr = window.devicePixelRatio || 1;
        const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
        const key = `${this.on}|${this.token}|${this.layers.length}|${W}|${H}|${view.eye[0]}|${view.eye[1]}|${parallaxScale(view.scale)}`;
        if (key === this.drawn) return;
        this.drawn = key;
        if (c.width !== W || c.height !== H) {
            c.width = W;
            c.height = H;
        }
        const g = this.ctx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.clearRect(0, 0, W, H);
        if (!this.on || this.id === null || !this.layers.length) return;
        // the game clears the viewport to black before the parallax
        g.fillStyle = "#000";
        g.fillRect(0, 0, W, H);
        for (const l of this.layers) {
            if (!l.img) continue;
            const r = layerRect(l.layer, view, W, H, dpr, [PARALLAX_ANCHOR[0] * dpr, PARALLAX_ANCHOR[1] * dpr]);
            g.imageSmoothingEnabled = !!l.layer.filter;
            if (l.layer.tiled) {
                l.pattern ??= g.createPattern(l.img, "repeat");
                if (!l.pattern) continue;
                l.pattern.setTransform(new DOMMatrix([r.w / l.img.width, 0, 0, r.h / l.img.height, r.x, r.y]));
                g.fillStyle = l.pattern;
                g.fillRect(0, 0, W, H);
            } else {
                g.drawImage(l.img, r.x, r.y, r.w, r.h);
            }
        }
    }

    /** Draws again for the last view (after the parallax or the switch changed). */
    repaint(): void {
        this.drawn = "";
        if (this.view) this.paint(this.view);
        else this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /** Clears the canvas (no map shown). */
    clear(): void {
        this.view = null;
        this.drawn = "";
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
}
