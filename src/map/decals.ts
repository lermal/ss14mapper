// Decals as the game stores them. Two storages exist:
//   - `DecalGrid.chunkCollection` on the grid (version 2; every fork, and upstream maps saved before
//     chunk entities): decal ids are unique per grid;
//   - `DecalChunk.decals` on chunk entities (`ChunkEntity` prototype, one per 16×16 area of a grid;
//     upstream maps saved since): decal ids are unique per chunk, so a decal is named "cx,cy:id" as
//     the game prints a `DecalIndex`.
// Both group decals with equal data into nodes: `{ node: { id, color, angle, zIndex, cleanable }, decals: { id: "x,y" } }`.

/** What a decal looks like; decals that share it share a node. */
export interface DecalProps {
    /** Decal prototype. */
    proto: string;
    /** "#RRGGBBAA", or null when the decal has no colour. */
    color: string | null;
    /** Radians. */
    angle: number;
    zIndex: number;
    cleanable: boolean;
}

export interface Decal extends DecalProps {
    /** "123" in a `DecalGrid`, "cx,cy:123" on chunk entities. */
    id: string;
    /** Grid coordinates of the decal's bottom left corner (the game's `Coordinates`). */
    x: number;
    y: number;
}

/** A decal to place: prototype, bottom left corner on the grid, other properties (the game's defaults when left out). */
export interface NewDecal {
    proto: string;
    x: number;
    y: number;
    props?: Partial<Omit<DecalProps, "proto">>;
}

/**
 * Entity prototypes the engine creates in code (`ChunkEntitySystem`, no YAML in any checkout): they have no sprite
 * and are not in a pack, which is not a missing prototype.
 */
export const ENGINE_PROTOTYPES: ReadonlySet<string> = new Set(["ChunkEntity"]);

/** Tiles per side of a decal chunk entity (`ChunkEntitySystem.GetChunkIndices`). */
export const DECAL_CHUNK_SIZE = 16;

/** Order of node fields: maps saved by older engines write them reversed, newer ones in their own order. */
export const NODE_FIELDS_OLD = ["cleanable", "zIndex", "angle", "color", "id"] as const;
export const NODE_FIELDS_NEW = ["zIndex", "id", "color", "cleanable", "angle"] as const;

/** Colour as `Color.ToHex` writes it ("#RRGGBBAA"); accepts #RGB, #RGBA, #RRGGBB and #RRGGBBAA. */
export function normalizeColor(color: string | null | undefined): string | null {
    if (color === null || color === undefined) return null;
    let s = color.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]+$/.test(s) || ![3, 4, 6, 8].includes(s.length)) throw new Error(`Not a colour: ${color}`);
    if (s.length <= 4) s = [...s].map((c) => c + c).join("");
    if (s.length === 6) s += "FF";
    return "#" + s.toUpperCase();
}

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Node order in saved maps (`DecalData.CompareTo`): prototype, colour, angle, z, cleanable. */
export function compareProps(a: DecalProps, b: DecalProps): number {
    if (a.proto !== b.proto) return ordinal(a.proto, b.proto);
    if (a.color !== b.color) return a.color === null ? -1 : b.color === null ? 1 : ordinal(a.color, b.color);
    if (a.angle !== b.angle) return a.angle < b.angle ? -1 : 1;
    if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
    return Number(a.cleanable) - Number(b.cleanable);
}

/** Node fields as plain strings → decal properties (absent fields take the game's defaults). */
export function readProps(fields: Map<string, string>): DecalProps {
    const color = fields.get("color");
    let normalized: string | null = null;
    try {
        normalized = normalizeColor(color);
    } catch {
        normalized = color ?? null; // a colour name; kept as written
    }
    return {
        proto: fields.get("id") ?? "",
        color: normalized,
        angle: parseAngle(fields.get("angle")),
        zIndex: Number(fields.get("zIndex") ?? 0) || 0,
        cleanable: (fields.get("cleanable") ?? "false").toLowerCase() === "true",
    };
}

export function parseAngle(text: string | undefined): number {
    if (text === undefined) return 0;
    const t = text.trim();
    if (t.endsWith("deg")) return (parseFloat(t) * Math.PI) / 180;
    return parseFloat(t) || 0;
}

/** "x,y" → numbers. */
export function parsePosition(text: string): [number, number] {
    const [x, y] = text.split(",").map((v) => parseFloat(v));
    return [x ?? 0, y ?? 0];
}

export function chunkOf(x: number, y: number): [number, number] {
    return [Math.floor(x / DECAL_CHUNK_SIZE), Math.floor(y / DECAL_CHUNK_SIZE)];
}

/** "123" → { local: 123 }; "cx,cy:123" → { chunk: [cx, cy], local: 123 }. */
export function parseDecalId(id: string): { chunk?: [number, number]; local: number } {
    const m = /^(-?\d+),(-?\d+):(\d+)$/.exec(id);
    if (m) return { chunk: [Number(m[1]), Number(m[2])], local: Number(m[3]) };
    if (!/^\d+$/.test(id)) throw new Error(`Not a decal id: ${id}`);
    return { local: Number(id) };
}

export function decalId(local: number, chunk?: [number, number]): string {
    return chunk ? `${chunk[0]},${chunk[1]}:${local}` : String(local);
}

/** Draw order of decals with equal z, as the game's overlay sorts them: chunk, then id. */
export function decalOrder(id: string): number {
    const m = /^(?:(-?\d+),(-?\d+):)?(\d+)$/.exec(id);
    if (!m) return 0;
    const local = Number(m[3]);
    if (m[1] === undefined) return local;
    const chunk = [Number(m[1]), Number(m[2])];
    return ((chunk[0]! + 32768) * 65536 + (chunk[1]! + 32768)) * 65536 + local;
}
