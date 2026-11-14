import { describe, expect, it } from "vitest";
import { loadGrid, loadOpen, saveGrid, saveOpen } from "../src/ui/palette-prefs";

const memory = () => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};
const broken = {
    getItem: () => {
        throw new Error("denied");
    },
    setItem: () => {
        throw new Error("denied");
    },
};

describe("palette preferences", () => {
    it("remembers grid view per tab", () => {
        const st = memory();
        expect(loadGrid(st)).toEqual({ entity: false, tile: false, decal: false });
        expect(saveGrid({ entity: false, tile: true, decal: false }, st)).toBe(true);
        expect(loadGrid(st)).toEqual({ entity: false, tile: true, decal: false });
    });
    it("ignores garbage and broken storage", () => {
        expect(loadGrid({ getItem: () => "nope" })).toEqual({ entity: false, tile: false, decal: false });
        expect(loadGrid({ getItem: () => '{"entity":"yes","tile":true}' })).toEqual({ entity: false, tile: true, decal: false });
        expect(loadGrid(broken).entity).toBe(false);
        expect(saveGrid({ entity: true, tile: true, decal: true }, broken)).toBe(false);
        expect(saveGrid({ entity: true, tile: true, decal: true }, null)).toBe(false);
        expect(loadOpen("up", broken).size).toBe(0);
    });
    it("remembers open folders per fork", () => {
        const st = memory();
        saveOpen("up", new Set(["A", "__favourites__"]), st);
        expect([...loadOpen("up", st)]).toEqual(["A", "__favourites__"]);
        expect(loadOpen("other", st).size).toBe(0);
    });
});
