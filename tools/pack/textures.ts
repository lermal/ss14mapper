// Packs the first frame of every direction of every RSI state, plus plain textures, into WebP pages.
// Order is deterministic, so the same checkout produces the same page files (and names).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { FrameRef, RsiEntry, TextureIndex } from "../../src/pack/format";
import { walk } from "./game";

const PAGE_WIDTH = 2048;
const MAX_PAGE_HEIGHT = 2048;
/** Transparent-free border around every frame, filled with the frame's edge pixels (no seams when scaled). */
const PAD = 2;

interface Image {
    data: Buffer;
    width: number;
    height: number;
}

async function decode(file: string): Promise<Image | null> {
    try {
        const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        return { data, width: info.width, height: info.height };
    } catch {
        return null;
    }
}

export const hashName = (prefix: string, ext: string, content: Buffer | string) =>
    `${prefix}.${crypto.createHash("sha256").update(content).digest("hex").slice(0, 12)}.${ext}`;

class Pages {
    readonly names: string[] = [];
    private page: Buffer = Buffer.alloc(PAGE_WIDTH * MAX_PAGE_HEIGHT * 4);
    private x = 0;
    private y = 0;
    private shelf = 0;
    frames = 0;

    constructor(private readonly outDir: string) {}

    /** Copies a w×h rectangle of `img` at (sx, sy) into the current page; returns where it went. */
    async place(img: Image, sx: number, sy: number, w: number, h: number): Promise<FrameRef> {
        const cw = w + PAD * 2;
        const ch = h + PAD * 2;
        if (cw > PAGE_WIDTH || ch > MAX_PAGE_HEIGHT) throw new Error(`frame ${w}×${h} does not fit a page`);
        if (this.x + cw > PAGE_WIDTH) {
            this.x = 0;
            this.y += this.shelf;
            this.shelf = 0;
        }
        if (this.y + ch > MAX_PAGE_HEIGHT) await this.flush();
        const px = this.x + PAD;
        const py = this.y + PAD;
        for (let row = -PAD; row < h + PAD; row++) {
            const srcRow = sy + Math.min(h - 1, Math.max(0, row));
            for (let col = -PAD; col < w + PAD; col++) {
                const srcCol = sx + Math.min(w - 1, Math.max(0, col));
                const s = (srcRow * img.width + srcCol) * 4;
                const d = ((py + row) * PAGE_WIDTH + (px + col)) * 4;
                this.page[d] = img.data[s]!;
                this.page[d + 1] = img.data[s + 1]!;
                this.page[d + 2] = img.data[s + 2]!;
                this.page[d + 3] = img.data[s + 3]!;
            }
        }
        this.x += cw;
        this.shelf = Math.max(this.shelf, ch);
        this.frames++;
        return [this.names.length, px, py];
    }

    /** Encodes the current page (cropped to its used height) and starts a new one. */
    async flush(): Promise<void> {
        const height = this.y + this.shelf;
        if (height === 0) return;
        const webp = await sharp(this.page.subarray(0, PAGE_WIDTH * height * 4), { raw: { width: PAGE_WIDTH, height, channels: 4 } })
            .webp({ lossless: true, effort: 4 })
            .toBuffer();
        const name = hashName("page", "webp", webp);
        fs.writeFileSync(path.join(this.outDir, name), webp);
        this.names.push(name);
        this.page.fill(0);
        this.x = 0;
        this.y = 0;
        this.shelf = 0;
    }
}

interface RsiState {
    name: string;
    directions?: number;
    delays?: number[][];
}

interface RsiMeta {
    size: { x: number; y: number };
    license?: string;
    copyright?: string;
    states?: RsiState[];
}

/**
 * Builds texture pages for every RSI under Textures and for the given plain textures.
 * `plain` maps a texture path (relative to Textures) to its number of variants (strip frames).
 */
export async function packTextures(
    texturesDir: string,
    plain: Map<string, number>,
    outDir: string,
    problems: string[],
): Promise<{ index: TextureIndex; frames: number }> {
    const pages = new Pages(outDir);
    const rsi: Record<string, RsiEntry> = {};

    const metas = walk(texturesDir, "meta.json")
        .map((f) => path.relative(texturesDir, path.dirname(f)).split(path.sep).join("/"))
        .filter((key) => key.endsWith(".rsi"))
        .sort();

    for (const key of metas) {
        const dir = path.join(texturesDir, key);
        let meta: RsiMeta;
        try {
            meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8").replace(/^﻿/, ""));
        } catch (e) {
            problems.push(`${key}: unreadable meta.json`);
            continue;
        }
        const [sx, sy] = [Number(meta.size?.x ?? 32), Number(meta.size?.y ?? 32)];
        const states = meta.states ?? [];
        const images = await Promise.all(states.map((s) => decode(path.join(dir, `${s.name}.png`))));
        const entry: RsiEntry = { size: [sx, sy], states: {} };
        if (meta.license) entry.license = meta.license;
        if (meta.copyright) entry.copyright = meta.copyright;

        for (let i = 0; i < states.length; i++) {
            const state = states[i]!;
            const img = images[i];
            if (!img) {
                problems.push(`${key}: missing or unreadable ${state.name}.png`);
                continue;
            }
            const cols = Math.max(1, Math.floor(img.width / sx));
            const directions = Number(state.directions ?? 1);
            const refs: FrameRef[] = [];
            let index = 0;
            for (let d = 0; d < directions; d++) {
                const fx = (index % cols) * sx;
                const fy = Math.floor(index / cols) * sy;
                if (fx + sx > img.width || fy + sy > img.height) {
                    problems.push(`${key}: ${state.name}.png is smaller than its frames`);
                    break;
                }
                refs.push(await pages.place(img, fx, fy, sx, sy));
                index += state.delays?.[d]?.length ?? 1;
            }
            if (refs.length) entry.states[state.name] = refs;
        }
        rsi[key] = entry;
    }

    const textures: TextureIndex["textures"] = {};
    for (const rel of [...plain.keys()].sort()) {
        const img = await decode(path.join(texturesDir, rel));
        if (!img) {
            problems.push(`${rel}: missing or unreadable texture`);
            continue;
        }
        const variants = Math.max(1, plain.get(rel)!);
        const w = Math.floor(img.width / variants);
        const frames: Array<[number, number, number, number, number]> = [];
        for (let v = 0; v < variants; v++) {
            const [page, x, y] = await pages.place(img, v * w, 0, w, img.height);
            frames.push([page, x, y, w, img.height]);
        }
        textures[rel] = frames;
    }

    await pages.flush();
    return { index: { pages: pages.names, rsi, textures }, frames: pages.frames };
}
