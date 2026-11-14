// Data for checking container operations the way the game does, read from a checkout (C# only as text):
// which prototypes the game fills (and the unfilled prototype they derive from), item sizes, entity storage
// defaults and the size of an entity's bounds (EntityStorage.MaxSize is compared with it).
import type { ContainerRules, WhitelistData } from "../../src/pack/format";
import type { Checkout, Raw } from "./game";
import { TYPE_FIELD } from "./game";
import { prototypeFixtures } from "./physics";
import { blank } from "./schemas";

/** Components that spawn entities into containers when the map starts. */
const FILL_COMPONENTS = ["ContainerFill", "EntityTableContainerFill", "StorageFill", "OpenTriggeredStorageFill"];

const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return v === undefined || v === null || Number.isNaN(n) ? fallback : n;
};
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/** Code (comments blanked) of the sources whose path matches; a class may be split between client, server and shared files. */
function source(game: Checkout, file: RegExp): string {
    return game.csharp().filter((s) => file.test(s.file)).map((s) => blank(s.text).code).join("\n");
}

/** Value of a C# field initializer (`Name = <value>;`) in the sources matching `file`. */
function initializer(game: Checkout, file: RegExp, name: string, value: RegExp): string | null {
    const m = new RegExp(`\\b${name}\\s*=\\s*${value.source}`).exec(source(game, file));
    return m ? (m[1] ?? m[0]) : null;
}

/** Entities no wider than this are left out of the rules (no entity storage admits less than it). */
const BOUNDS_FLOOR = 0.6;

/** `PhysicsConstants.PolygonRadius`: the skin of boxes and polygons, counted in their bounds. */
const POLYGON_RADIUS = 0.01;

/** Bounds of a fixture shape as `IPhysShape.ComputeAABB` gives them (at the origin, no rotation), or null. */
function shapeBounds(shape: Raw | null | undefined): [number, number, number, number] | null {
    const type = shape ? String(shape[TYPE_FIELD] ?? "") : "PhysShapeAabb";
    const pair = (v: unknown): [number, number] => {
        if (Array.isArray(v)) return [num(v[0], 0), num(v[1], 0)];
        const [x, y] = String(v ?? "0,0").split(",").map((q) => Number(q.trim()));
        return [x ?? 0, y ?? 0];
    };
    if (type === "PhysShapeCircle") {
        const r = num(shape!.radius, 0.5);
        const [x, y] = pair(shape!.position);
        return [x - r, y - r, x + r, y + r];
    }
    if (type === "PhysShapeAabb") {
        const b = String(shape?.bounds ?? "-0.5,-0.5,0.5,0.5").split(",").map((q) => Number(q.trim()));
        if (b.length !== 4 || b.some(Number.isNaN)) return null;
        const r = num(shape?.radius, POLYGON_RADIUS);
        return [b[0]! - r, b[1]! - r, b[2]! + r, b[3]! + r];
    }
    if (type === "PolygonShape") {
        const v = ((shape!.vertices as unknown[]) ?? []).map(pair);
        if (!v.length) return null;
        const r = num(shape!.radius, POLYGON_RADIUS);
        return [Math.min(...v.map((p) => p[0])) - r, Math.min(...v.map((p) => p[1])) - r, Math.max(...v.map((p) => p[0])) + r, Math.max(...v.map((p) => p[1])) + r];
    }
    return null; // edges and chains
}

export class ContainerData {
    constructor(private readonly game: Checkout) {}

    private readonly cache = new Map<string, { fills: boolean; plainBase?: string }>();

    private fillsOf(id: string): boolean {
        const components = this.game.entity(id).components;
        return FILL_COMPONENTS.some((c) => c in components);
    }

    /**
     * Whether the game fills the entity's containers, and the nearest ancestor (parents in order, nearest first)
     * that is not abstract and does not fill.
     */
    fills(id: string): { fills: boolean; plainBase?: string } {
        const done = this.cache.get(id);
        if (done) return done;
        const out: { fills: boolean; plainBase?: string } = { fills: this.fillsOf(id) };
        if (out.fills) {
            const seen = new Set([id]);
            let level = [id];
            while (level.length && !out.plainBase) {
                const next: string[] = [];
                for (const at of level) {
                    for (const parent of list(this.game.proto("entity", at)?.parent)) {
                        if (seen.has(parent) || !this.game.proto("entity", parent)) continue;
                        seen.add(parent);
                        next.push(parent);
                    }
                }
                out.plainBase = next.find((p) => !this.game.entity(p).abstract && !this.fillsOf(p));
                level = next;
            }
        }
        this.cache.set(id, out);
        return out;
    }

    /** Width and height of an entity's bounds (union of its fixtures' bounds and its origin), or null when it has none. */
    bounds(id: string): [number, number] | null {
        const fixtures = prototypeFixtures(this.game, id);
        if (fixtures === undefined) return null;
        const entries = Array.isArray(fixtures) ? fixtures : fixtures && typeof fixtures === "object" ? Object.values(fixtures) : [];
        let box: [number, number, number, number] = [0, 0, 0, 0];
        for (const f of entries as Raw[]) {
            const b = f && typeof f === "object" ? shapeBounds(f.shape as Raw) : null;
            if (b) box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
        }
        const size: [number, number] = [round(box[2] - box[0]), round(box[3] - box[1])];
        return size[0] > 0 || size[1] > 0 ? size : null;
    }

    rules(): ContainerRules {
        const { game } = this;
        const problems = game.problems;
        const itemSizes: ContainerRules["itemSizes"] = {};
        for (const [id, p] of game.all("itemSize")) itemSizes[id] = { weight: num(p.weight, 1), shape: list(p.defaultShape) };
        if (!Object.keys(itemSizes).length) problems.push("no itemSize prototypes: item sizes and shapes unknown");

        const find = (file: RegExp, name: string, value: RegExp, fallback: string, what: string) => {
            const v = initializer(game, file, name, value);
            if (v === null) problems.push(`${what} not found in the sources: assumed ${fallback}`);
            return v ?? fallback;
        };
        const defaultItemSize = find(/Item[\\/]ItemComponent\.cs$/, "Size", /"(\w+)"/, "Small", "ItemComponent.Size default");
        const defaultStorageMaxItemSize = find(/SharedStorageSystem\.cs$/, "DefaultStorageMaxItemSize", /"(\w+)"/, "Normal", "DefaultStorageMaxItemSize");
        const capacity = Number(find(/EntityStorageComponent\.cs$/, "Capacity", /(\d+)\s*;/, "30", "EntityStorage.Capacity default"));
        const maxSize = Number(find(/EntityStorageComponent\.cs$/, "MaxSize", /([\d.]+)f?\s*;/, "1", "EntityStorage.MaxSize default"));

        // upstream's component carries the default whitelist; older forks leave it null and the system admits mobs and items
        const storageSource = source(game, /Shared[\\/].*EntityStorageComponent\.cs$/);
        const declared = /Whitelist\s*=\s*new\(\)\s*\{\s*Components\s*=\s*\[([^\]]*)\]/.exec(storageSource);
        const systemFallback = /HasComp<MobStateComponent>\(\w+\)\s*\|\|\s*HasComp<ItemComponent>/.test(source(game, /SharedEntityStorageSystem\.cs$/));
        let whitelist: WhitelistData = { components: ["MobState", "Item"] };
        if (declared) whitelist = { components: [...declared[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) };
        else if (!systemFallback) problems.push("default whitelist of EntityStorage not found: assumed MobState and Item");

        const bounds: ContainerRules["bounds"] = {};
        for (const id of [...game.all("entity").keys()].sort()) {
            if (game.entity(id).abstract) continue;
            const b = this.bounds(id);
            if (b && Math.max(...b) > BOUNDS_FLOOR) bounds[id] = b;
        }
        return {
            itemSizes,
            defaultItemSize,
            defaultStorageMaxItemSize,
            entityStorage: { capacity, maxSize, whitelist, blacklist: /\bEntityWhitelist\?\s+Blacklist\b/.test(storageSource) },
            boundsFloor: BOUNDS_FLOOR,
            bounds,
        };
    }
}
