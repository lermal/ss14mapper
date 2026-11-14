// Full component data of entity prototypes, with inheritance applied as the game does.
import type { PrototypeData } from "./format";

export type Components = Record<string, Record<string, unknown>>;

/**
 * Components of a prototype with its parents applied: the engine pushes parents in order onto the child and keeps
 * values already set, so the first parent listed wins; fields of a component merge (one level deep).
 */
export function resolveComponents(data: PrototypeData, id: string, cache = new Map<string, Components>()): Components {
    const done = cache.get(id);
    if (done) return done;
    const out: Components = {};
    cache.set(id, out); // guards against inheritance cycles
    const p = data.entities[id];
    if (!p) return out;
    for (const parent of p.parents ?? []) {
        for (const [type, fields] of Object.entries(resolveComponents(data, parent, cache))) out[type] = { ...fields, ...(out[type] ?? {}) };
    }
    for (const [type, fields] of Object.entries(p.components)) out[type] = { ...(out[type] ?? {}), ...fields };
    return out;
}
