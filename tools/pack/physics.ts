// Masses the game gives grids and entities, read from a checkout (C# only as text).
//
// A grid's body has one fixture per rectangle of its tiles, all with the density
// SharedShuttleSystem.TileDensityMultiplier; an entity's body mass is the sum of its fixtures' area × density
// (SharedPhysicsSystem.ResetMassData), 1 when that is 0.
import fs from "node:fs";
import path from "node:path";
import type { Checkout, Raw } from "./game";
import { TYPE_FIELD } from "./game";

export interface BodyMass {
    mass: number;
    /** Centre of mass in the entity's own coordinates. */
    centre: [number, number];
}

const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return v === undefined || v === null || Number.isNaN(n) ? fallback : n;
};
const vec = (v: unknown): [number, number] => {
    if (Array.isArray(v)) return [num(v[0], 0), num(v[1], 0)];
    const [x, y] = String(v ?? "0,0").split(",").map((s) => Number(s.trim()));
    return [x ?? 0, y ?? 0];
};

/** Convex hull, counter-clockwise (the engine builds polygons from the hull of their vertices). */
function hull(points: Array<[number, number]>): Array<[number, number]> {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: Array<[number, number]> = [];
    for (const q of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
        lower.push(q);
    }
    const upper: Array<[number, number]> = [];
    for (const q of p.reverse()) {
        while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
        upper.push(q);
    }
    return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Area and centroid of a shape (FixtureSystem.GetMassData); edges and chains have none. */
export function shapeArea(shape: Raw | null | undefined): { area: number; centre: [number, number] } {
    // a fixture without a shape gets the default PhysShapeAabb (Box2.UnitCentered)
    const type = shape ? String(shape[TYPE_FIELD] ?? "") : "PhysShapeAabb";
    if (type === "PhysShapeCircle") {
        const r = num(shape!.radius, 0.5);
        return { area: Math.PI * r * r, centre: vec(shape!.position) };
    }
    let points: Array<[number, number]> = [];
    if (type === "PhysShapeAabb") {
        const [l, b, r, t] = String(shape?.bounds ?? "-0.5,-0.5,0.5,0.5").split(",").map((s) => Number(s.trim())) as [number, number, number, number];
        points = [[l, b], [r, b], [r, t], [l, t]];
    } else if (type === "PolygonShape") points = ((shape!.vertices as unknown[]) ?? []).map(vec);
    const h = hull(points);
    if (h.length < 3) return { area: 0, centre: [0, 0] };
    // triangles fanned from the first vertex, as Box2D does
    let area = 0, cx = 0, cy = 0;
    const [ox, oy] = h[0]!;
    for (let i = 1; i + 1 < h.length; i++) {
        const [ax, ay] = [h[i]![0] - ox, h[i]![1] - oy];
        const [bx, by] = [h[i + 1]![0] - ox, h[i + 1]![1] - oy];
        const a = 0.5 * (ax * by - ay * bx);
        area += a;
        cx += (a * (ax + bx)) / 3;
        cy += (a * (ay + by)) / 3;
    }
    return area > 0 ? { area, centre: [ox + cx / area, oy + cy / area] } : { area: 0, centre: [0, 0] };
}

const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/**
 * `Fixtures.fixtures` of a prototype as the engine composes it: the field is `[NeverPushInheritance]`, so a
 * prototype that declares Fixtures keeps only its own fixtures (none without the field); one that does not
 * declares it takes the component of its first parent that has one. Undefined without a Fixtures component.
 */
export function prototypeFixtures(game: Checkout, id: string, seen = new Set<string>()): unknown {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const p = game.proto("entity", id);
    if (!p) return undefined;
    const own = ((p.components as unknown[]) ?? []).find((c) => c && typeof c === "object" && (c as Raw).type === "Fixtures") as Raw | undefined;
    if (own) return own.fixtures ?? {};
    for (const parent of list(p.parent)) {
        const f = prototypeFixtures(game, parent, seen);
        if (f !== undefined) return f;
    }
    return undefined;
}

/** Body mass of a prototype with Physics, or null for entities without a body. */
export function bodyMass(game: Checkout, id: string): BodyMass | null {
    if (!game.entity(id).components.Physics) return null;
    const fixtures = prototypeFixtures(game, id);
    const entries = Array.isArray(fixtures) ? fixtures : fixtures && typeof fixtures === "object" ? Object.values(fixtures) : [];
    let mass = 0, mx = 0, my = 0;
    for (const f of entries as Raw[]) {
        if (!f || typeof f !== "object") continue;
        const density = num(f.density, 1); // PhysicsConstants.DefaultDensity
        if (density <= 0) continue;
        const { area, centre } = shapeArea(f.shape as Raw);
        const m = area * density;
        mass += m;
        mx += m * centre[0];
        my += m * centre[1];
    }
    // "Always need positive mass."
    if (mass <= 0) return { mass: 1, centre: [0, 0] };
    return { mass, centre: [mx / mass, my / mass] };
}

/** A `float` constant of a C# file, following one reference to another constant. */
function constant(text: string, name: string, sources: Array<{ text: string }>): number | null {
    const m = new RegExp(`\\b${name}\\s*=\\s*([^;]+);`).exec(text);
    if (!m) return null;
    const v = m[1]!.trim();
    const lit = /^(-?[\d.]+(?:[eE][-+]?\d+)?)[fFdD]?$/.exec(v);
    if (lit) return Number(lit[1]);
    const ref = /(\w+)$/.exec(v)?.[1];
    if (!ref || ref === name) return null;
    for (const s of sources) {
        if (!s.text.includes(ref)) continue;
        const r = new RegExp(`const\\s+float\\s+${ref}\\s*=\\s*(-?[\\d.]+)[fF]?\\s*;`).exec(s.text);
        if (r) return Number(r[1]);
    }
    return null;
}

export interface GridPhysics {
    /** Density of every grid fixture (SharedShuttleSystem.TileDensityMultiplier). */
    tileDensity: number | null;
    /** Default ContentTileDefinition.Mass: a tile's mass for grid impacts. */
    tileMass: number | null;
}

export function gridPhysics(game: Checkout): GridPhysics {
    const sources = game.csharp();
    const find = (file: string) => {
        const p = path.join(game.root, file);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : (sources.find((s) => s.file.endsWith(path.basename(file)))?.text ?? null);
    };
    const shuttle = find("Content.Shared/Shuttles/Systems/SharedShuttleSystem.cs");
    const tile = find("Content.Shared/Maps/ContentTileDefinition.cs");
    const tileDensity = shuttle ? constant(shuttle, "TileDensityMultiplier", sources) : null;
    const tileMass = tile ? constant(tile, "public float Mass", sources) : null;
    if (tileDensity === null) game.problems.push("SharedShuttleSystem.TileDensityMultiplier not found: grid masses unknown");
    if (tileMass === null) game.problems.push("ContentTileDefinition.Mass default not found: tile masses unknown");
    return { tileDensity, tileMass };
}
