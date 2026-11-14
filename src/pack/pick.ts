// Choosing the build that covers a map best, from small per-build indexes instead of whole packs.
import type { BuildIndex } from "./format";

/** How many prototypes a map uses that a build does not have (renamed ones followed, removed ones not counted). */
export function missingIn(used: Iterable<string>, index: BuildIndex): number {
    const known = new Set(index.entities);
    let n = 0;
    for (const proto of new Set(used)) {
        let now: string | null = proto;
        for (let i = 0; i < 16 && now !== null && now in index.migrations; i++) now = index.migrations[now] ?? null;
        if (now !== null && !known.has(now)) n++;
    }
    return n;
}

export interface Pick {
    id: string;
    missing: number;
    was: number;
}

/**
 * The build whose prototypes cover the map best when it beats `current`, else null. The current build is checked
 * first and nothing else is loaded when it misses nothing; the others are loaded `concurrency` at a time. Ties go
 * to the earlier build in `ids`.
 */
export async function pickBuild(
    used: Iterable<string>,
    ids: string[],
    current: string,
    load: (id: string) => Promise<BuildIndex>,
    concurrency = 4,
): Promise<Pick | null> {
    const protos = [...new Set(used)];
    const missing = new Map<string, number>();
    const score = async (id: string) => void missing.set(id, missingIn(protos, await load(id)));
    if (ids.includes(current)) {
        await score(current);
        if (missing.get(current) === 0) return null;
    }
    const rest = ids.filter((id) => !missing.has(id));
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(Math.max(1, concurrency), rest.length) }, async () => {
            while (next < rest.length) await score(rest[next++]!);
        }),
    );
    const was = missing.get(current) ?? 0;
    let best: string | null = null;
    for (const id of ids) if (best === null || missing.get(id)! < missing.get(best)!) best = id;
    return best !== null && best !== current && missing.get(best)! < was ? { id: best, missing: missing.get(best)!, was } : null;
}
