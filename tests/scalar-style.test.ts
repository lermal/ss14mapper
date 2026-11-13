import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { formatScalar, parseDocument, type YNode } from "../src/map/yaml";
// @ts-expect-error plain JS helper shared with the command line
import { corpusFiles } from "../tools/corpus.mjs";

const files: Array<{ fork: string; file: string }> = corpusFiles();

describe("scalar style", () => {
    it.each([
        ["Space", "Space"],
        ["-1,-1", "-1,-1"],
        ["1.5707963267948966 rad", "1.5707963267948966 rad"],
        ["", '""'],
        ["#FFFFFFFF", "'#FFFFFFFF'"],
        ["...", "'...'"],
        ["- item", "'- item'"],
        ["key: value", "'key: value'"],
        ["sci ", "'sci '"],
        ["it's", "it's"],
        ["line\nbreak", '"line\\nbreak"'],
    ])("writes %j as %s", (value, expected) => {
        expect(formatScalar(value)).toBe(expected);
    });
});

describe.skipIf(files.length === 0)("scalar style in the corpus", () => {
    it("matches the game for every single-line plain and single-quoted value", () => {
        const mismatches: string[] = [];
        const walk = (n: YNode) => {
            if (n.kind === "scalar") {
                const raw = n.raw;
                if ((n.style === "plain" || n.style === "single") && raw && !raw.includes("\n") && !/ #/.test(raw)) {
                    if (formatScalar(n.value) !== raw) mismatches.push(raw);
                }
                return;
            }
            if (n.kind === "map") n.entries.forEach((e) => (walk(e.key), walk(e.value)));
            else n.items.forEach((i) => walk(i.value));
        };
        for (const { file } of files) walk(parseDocument(fs.readFileSync(file, "utf8")).root);
        expect(mismatches.slice(0, 10)).toEqual([]);
    });
});
