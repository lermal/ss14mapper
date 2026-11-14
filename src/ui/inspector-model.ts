// Logic of the component inspector without DOM: component names and filtering (fields: inspector-fields.ts).
import type { Pack } from "../pack/loader";

/** Components that cannot be removed from an entity. */
export const FIXED_COMPONENTS = new Set(["Transform", "MapGrid"]);

/**
 * Components registered by the engine, whose C# sources are not in the checkouts packs are built from, so the pack's
 * list lacks them unless some prototype uses them.
 */
const ENGINE_COMPONENTS = ["MetaData"];

/** Names of all components entities of the pack's fork can have, sorted (the components its prototypes use when the pack lacks the full list). */
export function componentNames(pack: Pack): string[] {
    const names = new Set<string>(ENGINE_COMPONENTS);
    for (const name of pack.prototypes.componentNames ?? []) names.add(name);
    if (!pack.prototypes.componentNames) for (const proto of Object.values(pack.prototypes.entities)) for (const name of Object.keys(proto.components)) names.add(name);
    return [...names].sort((a, b) => a.localeCompare(b));
}

/** Names containing `query` (case-insensitive), prefix matches first; at most `limit`. */
export function filterNames(names: readonly string[], query: string, limit = 50): string[] {
    const q = query.trim().toLowerCase();
    if (!q) return names.slice(0, limit);
    const starts: string[] = [], inside: string[] = [];
    for (const n of names) {
        const i = n.toLowerCase().indexOf(q);
        if (i === 0) starts.push(n);
        else if (i > 0) inside.push(n);
    }
    return [...starts, ...inside].slice(0, limit);
}
