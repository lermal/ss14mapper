// Parallax prototypes of a fork and their layer images: image layers are copied (as lossless WebP), generated
// layers are made by the port of the client's generator (parallax-gen.ts), once per config. The editor loads them
// only when it shows a parallax. Each prototype also gets a small thumbnail for the picker.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import yaml from "js-yaml";
import type { ParallaxData, ParallaxLayer, ParallaxPrototype, ParallaxTexture } from "../../src/pack/format";
import { layerOrigin, layerSize, PIXELS_PER_METER } from "../../src/render/parallax-math";
import { TYPE_FIELD, truthy, type Checkout, type Raw } from "./game";
import { generateParallax } from "./parallax-gen";
import { hashName } from "./textures";

/** Size the client generates layers at (GeneratedParallaxCache: `new Size(1920, 1080)`). */
const GENERATED_SIZE: [number, number] = [1920, 1080];
/** Viewport of the thumbnails before they are scaled down (a 1920×1080 game window at zoom 1). */
const VIEW: [number, number] = [1920, 1080];
const THUMB_WIDTH = 240;

interface Image {
    width: number;
    height: number;
    data: Uint8Array;
    file: string;
}

function vec(v: unknown, def: [number, number]): [number, number] {
    if (v === undefined || v === null || v === "") return def;
    if (typeof v === "number") return [v, v];
    const parts = String(v).split(",").map((s) => Number(s.trim()));
    if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return def;
    return [parts[0]!, parts[1]!];
}

/** The id of the parallax maps without a `Parallax` component get (`ParallaxSystem.Fallback`). */
function fallbackId(game: Checkout): string {
    for (const { file, text } of game.csharp()) {
        if (!file.endsWith(`${path.sep}ParallaxSystem.cs`)) continue;
        const m = /ProtoId<ParallaxPrototype>\s+Fallback\s*=\s*"([^"]+)"/.exec(text) ?? /\bFallback\s*=\s*"([^"]+)"/.exec(text);
        if (m) return m[1]!;
    }
    return "Default";
}

/** Whether a texture is sampled with filtering (`sample: { filter: true }` in `<texture>.yml`). */
function filtered(file: string): boolean {
    try {
        const meta = yaml.load(fs.readFileSync(`${file}.yml`, "utf8")) as Raw | null;
        return truthy((meta?.sample as Raw | undefined)?.filter ?? false);
    } catch {
        return false;
    }
}

export class ParallaxPacker {
    /** Images by source (texture path or config text), so each is written once. */
    private readonly images = new Map<string, Promise<Image | null>>();
    readonly files = new Set<string>();
    bytes = 0;
    generated = 0;
    generateMs = 0;

    constructor(
        private readonly game: Checkout,
        private readonly outDir: string,
        private readonly problems: string[],
    ) {}

    private async write(raw: Uint8Array, width: number, height: number): Promise<string> {
        const webp = await sharp(raw, { raw: { width, height, channels: 4 } }).webp({ lossless: true, effort: 4 }).toBuffer();
        const name = hashName("parallax", "webp", webp);
        if (!this.files.has(name)) {
            fs.writeFileSync(path.join(this.outDir, name), webp);
            this.files.add(name);
            this.bytes += webp.length;
        }
        return name;
    }

    private image(texture: ParallaxTexture): Promise<Image | null> {
        const res = this.game.resources;
        if (texture.kind === "image") {
            const file = path.join(res, texture.path.replace(/^\/+/, ""));
            const key = `image:${file}`;
            let p = this.images.get(key);
            if (!p) {
                p = (async () => {
                    try {
                        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
                        return { width: info.width, height: info.height, data, file: await this.write(data, info.width, info.height) };
                    } catch {
                        this.problems.push(`parallax texture ${texture.path}: missing or unreadable`);
                        return null;
                    }
                })();
                this.images.set(key, p);
            }
            return p;
        }
        const configFile = path.join(res, texture.configPath.replace(/^\/+/, ""));
        let config: string;
        try {
            config = fs.readFileSync(configFile, "utf8").replace(/\r\n/g, "\n");
        } catch {
            this.problems.push(`parallax config ${texture.configPath}: missing`);
            return Promise.resolve(null);
        }
        const key = `config:${config}`;
        let p = this.images.get(key);
        if (!p) {
            p = (async () => {
                try {
                    const t0 = Date.now();
                    const img = generateParallax(config, ...GENERATED_SIZE);
                    this.generateMs += Date.now() - t0;
                    this.generated++;
                    return { width: img.width, height: img.height, data: img.data, file: await this.write(img.data, img.width, img.height) };
                } catch (e) {
                    this.problems.push(`parallax config ${texture.configPath}: ${(e as Error).message}`);
                    return null;
                }
            })();
            this.images.set(key, p);
        }
        return p;
    }

    /** A layer as written, with the client's defaults; its image is made when `withImage`. */
    private async layer(raw: Raw, withImage: boolean, where: string): Promise<{ layer: ParallaxLayer; image: Image | null } | null> {
        const t = raw.texture as Raw | undefined;
        let texture: ParallaxTexture;
        if (t && t[TYPE_FIELD] === "ImageParallaxTextureSource" && typeof t.path === "string") texture = { kind: "image", path: t.path };
        else if (t && t[TYPE_FIELD] === "GeneratedParallaxTextureSource") {
            texture = { kind: "generated", id: t.id === undefined || t.id === null ? "other" : String(t.id), configPath: String(t.configPath ?? "/parallax_config.toml") };
        } else {
            this.problems.push(`${where}: unknown parallax texture source`);
            return null;
        }
        // low-quality generated layers are not made: the editor draws the high-quality ones, as the game by default
        const image = withImage || texture.kind === "image" ? await this.image(texture) : null;
        const shader = raw.shader === undefined ? "unshaded" : raw.shader === null ? null : String(raw.shader);
        const layer: ParallaxLayer = {
            texture,
            file: image?.file ?? null,
            size: image ? [image.width, image.height] : texture.kind === "generated" ? [...GENERATED_SIZE] : [0, 0],
            scale: vec(raw.scale, [1, 1]),
            tiled: raw.tiled === undefined ? true : truthy(raw.tiled),
            slowness: raw.slowness === undefined ? 0.5 : Number(raw.slowness),
            scrolling: vec(raw.scrolling, [0, 0]),
            worldHomePosition: vec(raw.worldHomePosition, [0, 0]),
            worldAdjustPosition: vec(raw.worldAdjustPosition, [0, 0]),
            controlHomePosition: vec(raw.controlHomePosition, [0, 0]),
            shader: shader === "" ? null : shader,
        };
        if (texture.kind === "image" && filtered(path.join(this.game.resources, texture.path.replace(/^\/+/, "")))) layer.filter = true;
        return { layer, image };
    }

    /** Thumbnail: the layers drawn as the game draws them for an eye at the origin, at time 0, scaled down. */
    private async thumbnail(layers: Array<{ layer: ParallaxLayer; image: Image | null }>): Promise<string | null> {
        if (!layers.length) return null;
        const [W, H] = VIEW;
        const out = new Float32Array(W * H * 3);
        for (const { layer, image } of layers) {
            if (!image) continue;
            const [sw, sh] = layerSize(layer);
            const [ox, oy] = layerOrigin(layer, [0, 0]);
            const { width: tw, height: th, data } = image;
            for (let py = 0; py < H; py++) {
                const wy = (H / 2 - py - 0.5) / PIXELS_PER_METER;
                let v = ((oy + sh - wy) / sh) * th;
                if (layer.tiled) v = ((v % th) + th) % th;
                else if (v < 0 || v >= th) continue;
                const row = Math.floor(v) * tw;
                for (let px = 0; px < W; px++) {
                    const wx = (px + 0.5 - W / 2) / PIXELS_PER_METER;
                    let u = ((wx - ox) / sw) * tw;
                    if (layer.tiled) u = ((u % tw) + tw) % tw;
                    else if (u < 0 || u >= tw) continue;
                    const s = (row + Math.floor(u)) * 4;
                    const a = data[s + 3]! / 255;
                    if (!a) continue;
                    const d = (py * W + px) * 3;
                    for (let k = 0; k < 3; k++) out[d + k] = data[s + k]! * a + out[d + k]! * (1 - a);
                }
            }
        }
        const rgb = Buffer.alloc(W * H * 3);
        for (let i = 0; i < out.length; i++) rgb[i] = Math.round(out[i]!);
        const webp = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
            .resize(THUMB_WIDTH, Math.round((THUMB_WIDTH * H) / W), { kernel: "lanczos3" })
            .webp({ quality: 82 })
            .toBuffer();
        const name = hashName("parallax-thumb", "webp", webp);
        if (!this.files.has(name)) {
            fs.writeFileSync(path.join(this.outDir, name), webp);
            this.files.add(name);
            this.bytes += webp.length;
        }
        return name;
    }

    async build(): Promise<ParallaxData> {
        const parallaxes: Record<string, ParallaxPrototype> = {};
        for (const [id, p] of [...this.game.all("parallax")].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
            const list = async (v: unknown, hq: boolean) => {
                const out: Array<{ layer: ParallaxLayer; image: Image | null }> = [];
                for (const [i, raw] of (Array.isArray(v) ? v : []).entries()) {
                    if (!raw || typeof raw !== "object") continue;
                    const l = await this.layer(raw as Raw, hq, `parallax ${id} layer ${i}`);
                    if (l) out.push(l);
                }
                return out;
            };
            const layers = await list(p.layers, true);
            const lq = await list(p.layersLQ, false);
            parallaxes[id] = {
                layers: layers.map((l) => l.layer),
                layersLQ: lq.map((l) => l.layer),
                layersLQUseHQ: p.layersLQUseHQ === undefined ? true : truthy(p.layersLQUseHQ),
                thumbnail: await this.thumbnail(layers),
            };
        }
        const def = fallbackId(this.game);
        if (!parallaxes[def]) this.problems.push(`default parallax ${def} not found`);
        return { default: def, parallaxes };
    }
}
