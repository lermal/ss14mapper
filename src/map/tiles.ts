// Tile chunks of a grid: base64 of fixed-size records, one per tile, row by row.
//   version 6: int32 tile id, flags, variant                 (6 bytes)
//   version 7: int32 tile id, flags, variant, rotation/mirror (7 bytes)
// Older versions (uint16 id) are read but never written.

export const CHUNK_SIZE = 16;

export interface Tile {
    id: number;
    flags: number;
    variant: number;
    rotationMirroring: number;
}

export const EMPTY_TILE: Tile = { id: 0, flags: 0, variant: 0, rotationMirroring: 0 };

export function recordSize(version: number): number {
    return version >= 7 ? 7 : version >= 6 ? 6 : 4;
}

function fromBase64(text: string): Uint8Array {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function toBase64(bytes: Uint8Array): string {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

export function decodeChunk(base64: string, version: number): Tile[] {
    const bytes = fromBase64(base64);
    const view = new DataView(bytes.buffer);
    const size = recordSize(version);
    const tiles: Tile[] = [];
    for (let o = 0; o + size <= bytes.length; o += size) {
        const wide = version >= 6;
        const p = wide ? 4 : 2;
        tiles.push({
            id: wide ? view.getInt32(o, true) : view.getUint16(o, true),
            flags: bytes[o + p]!,
            variant: bytes[o + p + 1]!,
            rotationMirroring: version >= 7 ? bytes[o + p + 2]! : 0,
        });
    }
    return tiles;
}

export function encodeChunk(tiles: Tile[], version: number): string {
    if (version < 6) throw new Error(`Tile chunk version ${version} cannot be written`);
    const size = recordSize(version);
    const bytes = new Uint8Array(tiles.length * size);
    const view = new DataView(bytes.buffer);
    tiles.forEach((t, i) => {
        const o = i * size;
        view.setInt32(o, t.id, true);
        bytes[o + 4] = t.flags;
        bytes[o + 5] = t.variant;
        if (version >= 7) bytes[o + 6] = t.rotationMirroring;
    });
    return toBase64(bytes);
}

/** Chunk index and position inside the chunk of a tile at grid coordinates. */
export function locate(x: number, y: number): { chunkX: number; chunkY: number; index: number } {
    const chunkX = Math.floor(x / CHUNK_SIZE);
    const chunkY = Math.floor(y / CHUNK_SIZE);
    return { chunkX, chunkY, index: (y - chunkY * CHUNK_SIZE) * CHUNK_SIZE + (x - chunkX * CHUNK_SIZE) };
}
