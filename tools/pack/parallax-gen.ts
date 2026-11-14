// Port of the game client's parallax generator (Content.Client/Parallax/ParallaxGenerator.cs), which turns a TOML
// config into the 1920×1080 image of a `GeneratedParallaxTextureSource` layer. Its parts are ported as the game runs
// them: FastNoiseLite's 2D OpenSimplex2 with FBm and ridged fractals (Robust.Shared/Noise/FastNoiseLite.cs), .NET's
// seeded System.Random (the Net5Compat subtractive generator that `new Random(seed)` uses), Robust's Color.Blend and
// Vector4 lerp, and ImageSharp's float-to-byte packing. C# float arithmetic is single precision, so every
// operation is rounded with Math.fround; the result matches the game's image byte for byte, except where the
// platform's powf or a fused multiply-add in Vector4.Lerp rounds the last bit differently.
const f = Math.fround;

// ---- TOML (the subset parallax configs use: [[layers]] tables of strings, integers and booleans)

export type TomlValue = string | number | boolean;
export type TomlTable = Record<string, TomlValue>;

export function parseParallaxToml(text: string): { layers: TomlTable[] } {
    const layers: TomlTable[] = [];
    let cur: TomlTable | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\s+|\s+$/g, "");
        if (!line || line.startsWith("#")) continue;
        if (line === "[[layers]]") {
            layers.push((cur = {}));
            continue;
        }
        const m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
        if (!m || !cur) throw new Error(`unsupported TOML line: ${line}`);
        let v = m[2]!.replace(/\s+#.*$/, "");
        let value: TomlValue;
        if (/^"(?:[^"\\]|\\.)*"$/.test(v)) value = JSON.parse(v) as string;
        else if (/^'[^']*'$/.test(v)) value = v.slice(1, -1);
        else if (v === "true" || v === "false") value = v === "true";
        else if (/^[+-]?\d+$/.test(v)) value = Number(v);
        else throw new Error(`unsupported TOML value: ${line}`);
        cur[m[1]!] = value;
    }
    return { layers };
}

// ---- System.Random(seed) (Net5CompatSeedImpl)

const INT_MAX = 2147483647;

export class NetRandom {
    private readonly seeds = new Int32Array(56);
    private inext = 0;
    private inextp = 21;

    constructor(seed: number) {
        const s = this.seeds;
        const subtraction = seed === -2147483648 ? INT_MAX : Math.abs(seed);
        let mj = 161803398 - subtraction;
        s[55] = mj;
        let mk = 1;
        let ii = 0;
        for (let i = 1; i < 55; i++) {
            if ((ii += 21) >= 55) ii -= 55;
            s[ii] = mk;
            mk = mj - mk;
            if (mk < 0) mk += INT_MAX;
            mj = s[ii]!;
        }
        for (let k = 1; k < 5; k++) {
            for (let i = 1; i < 56; i++) {
                let n = i + 30;
                if (n >= 55) n -= 55;
                s[i] = (s[i]! - s[1 + n]!) | 0;
                if (s[i]! < 0) s[i] = s[i]! + INT_MAX;
            }
        }
    }

    private sample(): number {
        let a = this.inext, b = this.inextp;
        if (++a >= 56) a = 1;
        if (++b >= 56) b = 1;
        let r = this.seeds[a]! - this.seeds[b]!;
        if (r === INT_MAX) r--;
        if (r < 0) r += INT_MAX;
        this.seeds[a] = r;
        this.inext = a;
        this.inextp = b;
        return r;
    }

    /** `Next()`: 0 ≤ n < int.MaxValue. */
    next(): number {
        return this.sample();
    }

    /** `Next(min, max)` for ranges up to int.MaxValue. */
    nextRange(min: number, max: number): number {
        return Math.trunc(this.sample() * (1.0 / INT_MAX) * (max - min)) + min;
    }

    /** Robust's `NextFloat()` extension: `Next() * 4.6566128752458E-10f` in single precision. */
    nextFloat(): number {
        return f(f(this.sample()) * NEXT_FLOAT);
    }
}
const NEXT_FLOAT = f(4.6566128752458e-10);

// ---- FastNoiseLite: 2D OpenSimplex2, FBm and ridged fractals

const GRAD2 = new Float32Array([
    0.130526192220052, 0.99144486137381, 0.38268343236509, 0.923879532511287, 0.608761429008721, 0.793353340291235, 0.793353340291235, 0.608761429008721,
    0.923879532511287, 0.38268343236509, 0.99144486137381, 0.130526192220051, 0.99144486137381, -0.130526192220051, 0.923879532511287, -0.38268343236509,
    0.793353340291235, -0.60876142900872, 0.608761429008721, -0.793353340291235, 0.38268343236509, -0.923879532511287, 0.130526192220052, -0.99144486137381,
    -0.130526192220052, -0.99144486137381, -0.38268343236509, -0.923879532511287, -0.608761429008721, -0.793353340291235, -0.793353340291235, -0.608761429008721,
    -0.923879532511287, -0.38268343236509, -0.99144486137381, -0.130526192220052, -0.99144486137381, 0.130526192220051, -0.923879532511287, 0.38268343236509,
    -0.793353340291235, 0.608761429008721, -0.608761429008721, 0.793353340291235, -0.38268343236509, 0.923879532511287, -0.130526192220052, 0.99144486137381,
]);
/** The 256-entry table: the first 48 pairs repeated five times, then 8 pairs of its own. */
export const GRADIENTS_2D = (() => {
    const t = new Float32Array(256);
    for (let i = 0; i < 240; i++) t[i] = GRAD2[i % 48]!;
    const tail = [0.38268343236509, 0.923879532511287, 0.923879532511287, 0.38268343236509, 0.923879532511287, -0.38268343236509, 0.38268343236509, -0.923879532511287,
        -0.38268343236509, -0.923879532511287, -0.923879532511287, -0.38268343236509, -0.923879532511287, 0.38268343236509, -0.38268343236509, 0.923879532511287];
    tail.forEach((v, i) => (t[240 + i] = v));
    return t;
})();

const PRIME_X = 501125321;
const PRIME_Y = 1136930381;
const SQRT3 = f(1.7320508075688772);
const F2 = f(0.5 * f(SQRT3 - 1));
const G2 = f(f(3 - SQRT3) / 6);
const C_T = f(f(2 * f(1 - f(2 * G2))) * f(f(1 / G2) - 2));
const C_A = f(f(-2 * f(1 - f(2 * G2))) * f(1 - f(2 * G2)));
const G2_2M1 = f(f(2 * G2) - 1);
const G2_M1 = f(G2 - 1);
const SIMPLEX_SCALE = f(99.83685446303647);

const fastFloor = (v: number) => (v >= 0 ? Math.trunc(v) : Math.trunc(v) - 1);

function gradCoord(seed: number, xp: number, yp: number, xd: number, yd: number): number {
    let hash = Math.imul(seed ^ xp ^ yp, 0x27d4eb2d);
    hash ^= hash >> 15;
    hash &= 127 << 1;
    return f(f(xd * GRADIENTS_2D[hash]!) + f(yd * GRADIENTS_2D[hash | 1]!));
}

function singleSimplex(seed: number, x: number, y: number): number {
    let i = fastFloor(x);
    let j = fastFloor(y);
    const xi = f(x - i);
    const yi = f(y - j);
    const t = f(f(xi + yi) * G2);
    const x0 = f(xi - t);
    const y0 = f(yi - t);
    i = Math.imul(i, PRIME_X);
    j = Math.imul(j, PRIME_Y);

    let n0 = 0, n1 = 0, n2 = 0;
    const a = f(f(0.5 - f(x0 * x0)) - f(y0 * y0));
    if (a > 0) n0 = f(f(f(a * a) * f(a * a)) * gradCoord(seed, i, j, x0, y0));

    const c = f(f(C_T * t) + f(C_A + a));
    if (c > 0) {
        const x2 = f(x0 + G2_2M1);
        const y2 = f(y0 + G2_2M1);
        n2 = f(f(f(c * c) * f(c * c)) * gradCoord(seed, (i + PRIME_X) | 0, (j + PRIME_Y) | 0, x2, y2));
    }

    if (y0 > x0) {
        const x1 = f(x0 + G2);
        const y1 = f(y0 + G2_M1);
        const b = f(f(0.5 - f(x1 * x1)) - f(y1 * y1));
        if (b > 0) n1 = f(f(f(b * b) * f(b * b)) * gradCoord(seed, i, (j + PRIME_Y) | 0, x1, y1));
    } else {
        const x1 = f(x0 + G2_M1);
        const y1 = f(y0 + G2);
        const b = f(f(0.5 - f(x1 * x1)) - f(y1 * y1));
        if (b > 0) n1 = f(f(f(b * b) * f(b * b)) * gradCoord(seed, (i + PRIME_X) | 0, j, x1, y1));
    }
    return f(f(f(n0 + n1) + n2) * SIMPLEX_SCALE);
}

export type FractalType = "none" | "fbm" | "ridged";

/** FastNoiseLite with the settings the generator uses (noise type OpenSimplex2, gain 0.5, weighted strength 0). */
export class FastNoiseLite {
    frequency = f(0.01);
    fractal: FractalType = "none";
    lacunarity = f(2);
    private octaves = 3;
    private readonly gain = f(0.5);
    private bounding = f(1 / f(1.75));
    private readonly seed: number;

    constructor(seed = 1337) {
        this.seed = seed;
    }

    setOctaves(octaves: number): void {
        this.octaves = octaves;
        let amp = this.gain, ampFractal = f(1);
        for (let i = 1; i < octaves; i++) {
            ampFractal = f(ampFractal + amp);
            amp = f(amp * this.gain);
        }
        this.bounding = f(1 / ampFractal);
    }

    /** `GetNoise(x, y)`, in −1..1. */
    noise(px: number, py: number): number {
        let x = f(f(px) * this.frequency);
        let y = f(f(py) * this.frequency);
        const t = f(f(x + y) * F2);
        x = f(x + t);
        y = f(y + t);
        if (this.fractal === "none") return singleSimplex(this.seed, x, y);
        let seed = this.seed, sum = 0, amp = this.bounding;
        const ridged = this.fractal === "ridged";
        for (let i = 0; i < this.octaves; i++) {
            const n = singleSimplex(seed, x, y);
            seed = (seed + 1) | 0;
            if (ridged) {
                const a = n < 0 ? -n : n;
                sum = f(sum + f(f(f(a * -2) + 1) * amp));
            } else sum = f(sum + f(n * amp));
            // the weighted-strength lerp is 1 for strength 0
            x = f(x * this.lacunarity);
            y = f(y * this.lacunarity);
            amp = f(amp * this.gain);
        }
        return sum;
    }
}

// ---- colours (Robust.Shared.Maths.Color) and pixels (ImageSharp Rgba32)

type Rgba = [number, number, number, number];

const BYTE_TO_FLOAT = Float32Array.from({ length: 256 }, (_, b) => f(b / 255));

function colorFromHex(hex: string): Rgba {
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
    if (!m) throw new Error(`unsupported colour: ${hex}`);
    const n = parseInt(m[1]!, 16);
    const a = m[2] ? parseInt(m[2], 16) : 255;
    return [BYTE_TO_FLOAT[(n >> 16) & 255]!, BYTE_TO_FLOAT[(n >> 8) & 255]!, BYTE_TO_FLOAT[n & 255]!, BYTE_TO_FLOAT[a]!];
}

/** Rgba32(float r, g, b, a): ×255, +0.5, clamped, truncated. */
function toByte(v: number): number {
    const s = f(f(v * 255) + 0.5);
    return s > 0 ? (s < 255 ? Math.trunc(s) : 255) : 0;
}

/** `Vector4.Lerp(a, b, t)` per component: a·(1−t) + b·t. */
const lerp = (a: number, b: number, t: number) => f(f(a * f(1 - t)) + f(b * t));

export type BlendFactor = "Zero" | "One" | "SrcColor" | "OneMinusSrcColor" | "DstColor" | "OneMinusDstColor" | "SrcAlpha" | "OneMinusSrcAlpha" | "DstAlpha" | "OneMinusDstAlpha";
const FACTORS: readonly BlendFactor[] = ["Zero", "One", "SrcColor", "OneMinusSrcColor", "DstColor", "OneMinusDstColor", "SrcAlpha", "OneMinusSrcAlpha", "DstAlpha", "OneMinusDstAlpha"];

/** One channel of `factor · v` in Color.Blend (`v` is the dst channel for the dst factor, the src one for the src factor). */
function factorTimes(factor: BlendFactor, v: number, src: number, dst: number, srcA: number, dstA: number): number {
    switch (factor) {
        case "Zero": return 0;
        case "One": return v;
        case "SrcColor": return f(v * src);
        case "OneMinusSrcColor": return f(v * f(1 - src));
        case "DstColor": return f(v * dst);
        case "OneMinusDstColor": return f(v * f(1 - dst));
        case "SrcAlpha": return f(v * srcA);
        case "OneMinusSrcAlpha": return f(v * f(1 - srcA));
        case "DstAlpha": return f(v * dstA);
        case "OneMinusDstAlpha": return f(v * f(1 - dstA));
    }
}

/** `Color.Blend(dst, src, dstFactor, srcFactor)` written back into `img` at byte offset `i`. */
function blendInto(img: Uint8Array, i: number, src: Rgba, dstFactor: BlendFactor, srcFactor: BlendFactor): void {
    const dstA = BYTE_TO_FLOAT[img[i + 3]!]!;
    for (let k = 0; k < 3; k++) {
        const d = BYTE_TO_FLOAT[img[i + k]!]!, s = src[k]!;
        const dPart = factorTimes(dstFactor, d, s, d, src[3], dstA);
        const sPart = factorTimes(srcFactor, s, s, d, src[3], dstA);
        img[i + k] = toByte(dstFactor === "Zero" ? sPart : srcFactor === "Zero" ? dPart : f(dPart + sPart));
    }
    img[i + 3] = toByte(Math.min(1, f(dstA + f(dstA * src[3]))));
}

// ---- layers

const str = (t: TomlTable, k: string) => (typeof t[k] === "string" ? (t[k] as string) : undefined);
const num = (t: TomlTable, k: string) => (typeof t[k] === "number" ? (t[k] as number) : undefined);
const parseFloat32 = (t: TomlTable, k: string, def: number) => {
    const s = str(t, k);
    if (s === undefined) return def;
    const v = Number(s);
    if (Number.isNaN(v)) throw new Error(`${k}: not a number: ${s}`);
    return f(v);
};
const factor = (t: TomlTable, k: string): BlendFactor => {
    const s = str(t, k);
    if (s === undefined) return "One";
    if (!FACTORS.includes(s as BlendFactor)) throw new Error(`unknown blend factor ${s}`);
    return s as BlendFactor;
};
const noiseType = (t: TomlTable, k: string): FractalType => {
    const s = str(t, k);
    if (s === undefined || s === "fbm") return "fbm";
    if (s === "ridged") return "ridged";
    throw new Error(`unknown noise type ${s}`);
};

export interface GeneratedImage {
    width: number;
    height: number;
    /** RGBA, rows top to bottom. */
    data: Uint8Array;
}

function applyClear(img: GeneratedImage, t: TomlTable): void {
    const c = colorFromHex(str(t, "color") ?? "#000000");
    const b = c.map(toByte);
    for (let i = 0; i < img.data.length; i += 4) img.data.set(b, i);
}

function applyToAlpha(img: GeneratedImage): void {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const r = BYTE_TO_FLOAT[d[i]!]!, g = BYTE_TO_FLOAT[d[i + 1]!]!, b = BYTE_TO_FLOAT[d[i + 2]!]!;
        d[i] = toByte(r);
        d[i + 1] = toByte(g);
        d[i + 2] = toByte(b);
        d[i + 3] = toByte(Math.min(f(f(r + g) + b), 1));
    }
}

/** `MathF.Pow` (single precision). */
const powf = (a: number, b: number) => f(Math.pow(a, b));

function applyNoise(img: GeneratedImage, t: TomlTable): void {
    const inner = colorFromHex(str(t, "innercolor") ?? "#FFFFFF");
    const outer = colorFromHex(str(t, "outercolor") ?? "#000000");
    const noise = new FastNoiseLite(num(t, "seed") ?? 1234);
    noise.fractal = noiseType(t, "noise_type");
    noise.frequency = parseFloat32(t, "frequency", 1);
    noise.lacunarity = parseFloat32(t, "lacunarity", f(Math.PI / 3));
    noise.setOctaves(num(t, "octaves") ?? 3);
    const threshold = parseFloat32(t, "threshold", 0);
    const power = parseFloat32(t, "power", 1);
    const srcFactor = factor(t, "sourcefactor"), dstFactor = factor(t, "destfactor");
    const threshVal = f(1 / f(1 - threshold));
    const powFactor = f(1 / power);
    const src: Rgba = [0, 0, 0, 0];
    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            let v = Math.min(1, Math.max(0, f(f(noise.noise(x, y) + 1) / 2)));
            v = Math.max(0, f(v - threshold));
            v = f(v * threshVal);
            v = powf(v, powFactor);
            for (let k = 0; k < 3; k++) src[k] = lerp(outer[k]!, inner[k]!, v);
            src[3] = v;
            blendInto(img.data, (y * img.width + x) * 4, src, dstFactor, srcFactor);
        }
    }
}

function applyPoints(img: GeneratedImage, t: TomlTable): void {
    const { width, height } = img;
    const seed = num(t, "seed") ?? 1234;
    const count = num(t, "count") ?? 100;
    const srcFactor = factor(t, "sourcefactor"), dstFactor = factor(t, "destfactor");
    const far = colorFromHex(str(t, "farcolor") ?? "#000000");
    const close = colorFromHex(str(t, "closecolor") ?? "#FFFFFF");
    const o = (num(t, "pointsize") ?? 1) - 1;
    const masked = t.mask === true;
    const buffer = new Uint8Array(width * height * 4);
    const random = new NetRandom(seed);
    const put = (x: number, y: number, dist: number) => {
        const c = [0, 1, 2, 3].map((k) => toByte(lerp(far[k]!, close[k]!, dist)));
        for (let oy = y - o; oy <= y + o; oy++) {
            for (let ox = x - o; ox <= x + o; ox++) {
                const ix = ((ox % width) + width) % width, iy = ((oy % height) + height) % height;
                buffer.set(c, (iy * width + ix) * 4);
            }
        }
    };
    if (!masked) {
        for (let i = 0; i < count; i++) {
            const x = random.nextRange(0, width);
            const y = random.nextRange(0, height);
            put(x, y, random.nextFloat());
        }
    } else {
        // as in the game, the mask's frequency and persistence are read but not applied (FastNoiseLite's 0.01 stays)
        const noise = new FastNoiseLite(num(t, "maskseed") ?? 1234);
        noise.fractal = noiseType(t, "masknoise_type");
        noise.lacunarity = parseFloat32(t, "masklacunarity", f((Math.PI * 2) / 3));
        noise.setOctaves(num(t, "maskoctaves") ?? 3);
        const threshold = parseFloat32(t, "maskthreshold", 0);
        const power = parseFloat32(t, "maskpower", 1);
        const threshVal = f(1 / f(1 - threshold));
        const powFactor = f(1 / power);
        let attempts = 0;
        for (let i = 0; i < count; i++) {
            const x = random.nextRange(0, width);
            const y = random.nextRange(0, height);
            let v = Math.min(1, Math.max(0, f(f(noise.noise(x, y) + 1) / 2)));
            v = Math.max(0, f(v - threshold));
            v = f(v * threshVal);
            v = powf(v, powFactor);
            if (random.nextFloat() > v) {
                if (++attempts <= 9999) i--;
                continue;
            }
            put(x, y, random.nextFloat());
        }
    }
    const src: Rgba = [0, 0, 0, 0];
    for (let i = 0; i < buffer.length; i += 4) {
        for (let k = 0; k < 4; k++) src[k] = BYTE_TO_FLOAT[buffer[i + k]!]!;
        blendInto(img.data, i, src, dstFactor, srcFactor);
    }
}

/** The image the game generates for a parallax config (`ParallaxGenerator.GenerateParallax`, 1920×1080 in the client). */
export function generateParallax(toml: string, width = 1920, height = 1080): GeneratedImage {
    const img: GeneratedImage = { width, height, data: new Uint8Array(width * height * 4) };
    for (const layer of parseParallaxToml(toml).layers) {
        switch (layer.type) {
            case "clear": applyClear(img, layer); break;
            case "toalpha": applyToAlpha(img); break;
            case "noise": applyNoise(img, layer); break;
            case "points": applyPoints(img, layer); break;
            default: throw new Error(`unsupported parallax layer type ${String(layer.type)}`);
        }
    }
    return img;
}
