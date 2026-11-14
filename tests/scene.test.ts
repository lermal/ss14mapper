import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
import { Scene } from "../src/render/scene";
// @ts-expect-error plain JS helper shared with the command line
import { corpusFiles } from "../tools/corpus.mjs";
import { packFor } from "./pack-files";

const files: Array<{ fork: string; file: string }> = corpusFiles();

describe.skipIf(files.length === 0)("scenes of the corpus", () => {
    it("draws every map of every fork with its own pack", () => {
        const failed: string[] = [];
        const missing = new Map<string, number>();
        let maps = 0;
        for (const { fork, file } of files) {
            const pack = packFor(fork);
            if (!pack) continue;
            maps++;
            try {
                const scene = new Scene(new MapDocument(fs.readFileSync(file, "utf8")), pack);
                for (const m of scene.missing) missing.set(`${fork}: ${m}`, (missing.get(`${fork}: ${m}`) ?? 0) + 1);
            } catch (e) {
                failed.push(`${file}: ${(e as Error).message}`);
            }
        }
        const report = [...missing].sort((a, b) => b[1] - a[1]);
        console.log(`${maps} maps; distinct missing sprites/prototypes: ${report.length}\n${report.slice(0, 25).map(([k, n]) => `  ${n} × ${k}`).join("\n")}`);
        expect(failed).toEqual([]);
    }, 900_000);
});
