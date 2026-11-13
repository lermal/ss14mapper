import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument, serializeDocument, touchAll } from "../src/map/yaml";
// @ts-expect-error plain JS helper shared with the command line
import { corpusFiles } from "../tools/corpus.mjs";

const files: Array<{ fork: string; file: string }> = corpusFiles();

describe.skipIf(files.length === 0)("map corpus", () => {
    it("reads and writes every map byte for byte", () => {
        const failed: string[] = [];
        for (const { file } of files) {
            const text = fs.readFileSync(file, "utf8");
            try {
                if (serializeDocument(parseDocument(text)) !== text) failed.push(file);
            } catch (e) {
                failed.push(`${file}: ${(e as Error).message}`);
            }
        }
        expect(failed).toEqual([]);
    });

    it("emits every map again from its values exactly as the game wrote it", () => {
        const failed: string[] = [];
        for (const { file } of files) {
            const text = fs.readFileSync(file, "utf8");
            const doc = parseDocument(text);
            touchAll(doc.root);
            const out = serializeDocument(doc);
            if (out !== text) {
                const a = text.split("\n");
                const b = out.split("\n");
                const line = a.findIndex((l, i) => l !== b[i]);
                failed.push(`${file}:${line + 1}\n  game: ${JSON.stringify(a[line])}\n  ours: ${JSON.stringify(b[line])}`);
            }
        }
        expect(failed.slice(0, 10)).toEqual([]);
    });
});
