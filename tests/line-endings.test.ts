// Maps checked out on Windows (git autocrlf) have CRLF line endings, and some editors add a BOM:
// such files must open, save unchanged byte for byte, and keep their line endings after edits.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MapDocument } from "../src/map/document";
// @ts-expect-error plain JS helper shared with the command line
import { corpusRoot } from "../tools/corpus.mjs";

const files = [
    "frontier/Resources/Maps/_NF/Shuttles/BlackMarket/barnacle.yml",
    "goob/Resources/Maps/Shuttles/emergency_omega.yml",
].map((f) => path.join(corpusRoot(), f)).filter((f) => fs.existsSync(f));

describe.skipIf(files.length === 0)("line endings", () => {
    for (const file of files) {
        const lf = fs.readFileSync(file, "utf8");
        const crlf = lf.replaceAll("\n", "\r\n");

        it(`${path.basename(file)} with CRLF opens and saves unchanged`, () => {
            expect(new MapDocument(crlf).serialize()).toBe(crlf);
        });

        it(`${path.basename(file)} with CRLF keeps CRLF after edits`, () => {
            const doc = new MapDocument(crlf);
            const uid = doc.uids().find((u) => doc.transform(u).parent !== null)!;
            const t = doc.transform(uid);
            doc.moveEntity(uid, t.x + 1, t.y);
            doc.setTile(doc.listedGrids()[0]!, 0, 0, "Plating");
            const out = doc.serialize();
            expect(out.replaceAll("\r\n", "")).not.toContain("\n");
            // the same edits on the LF file give the same text up to line endings (time aside)
            const ref = new MapDocument(lf);
            ref.moveEntity(uid, t.x + 1, t.y);
            ref.setTile(ref.listedGrids()[0]!, 0, 0, "Plating");
            const now = new Date(2026, 0, 1);
            expect(doc.serialize(now)).toBe(ref.serialize(now).replaceAll("\n", "\r\n"));
            while (doc.undo());
            expect(doc.serialize()).toBe(crlf);
        });

        it(`${path.basename(file)} with a BOM opens and saves unchanged`, () => {
            const bom = "﻿" + crlf;
            const doc = new MapDocument(bom);
            expect(doc.serialize()).toBe(bom);
            expect(doc.format).toBe(new MapDocument(lf).format);
            expect(doc.format).toBeGreaterThan(0);
        });
    }
});
