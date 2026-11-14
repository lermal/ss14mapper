// Asset packs built next to the map corpus, read from disk for tests (texture pages are not loaded).
import fs from "node:fs";
import path from "node:path";
import { Pack } from "../src/pack/loader";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";

export const packsDir: string = process.env.SS14MAPPER_PACKS ?? path.join(corpusRoot(), "packs");

const packs = new Map<string, Pack | null>();

/** The pack of a fork, or null when it has not been built. */
export function packFor(fork: string): Pack | null {
    if (!packs.has(fork)) {
        const dir = path.join(packsDir, fork);
        let pack: Pack | null = null;
        if (fs.existsSync(path.join(dir, "manifest.json"))) {
            const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
            const manifest = read("manifest.json");
            pack = Pack.fromData(manifest, read(manifest.files.prototypes), read(manifest.files.textures), async (name) => read(name));
        }
        packs.set(fork, pack);
    }
    return packs.get(fork)!;
}
