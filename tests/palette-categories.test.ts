import { describe, expect, it } from "vitest";
import { Categories, FAVOURITES, loadCategories, parseCategories, saveCategories } from "../src/ui/categories";

const apc = { kind: "entity", id: "APCBasic" } as const;
const alarm = { kind: "entity", id: "AirAlarm" } as const;
const plating = { kind: "tile", id: "Plating" } as const;

describe("categories", () => {
    it("creates, renames, deletes with name rules", () => {
        const c = new Categories();
        expect(c.create(" Электроника ")).toBe(true);
        expect(c.create("Электроника")).toBe(false);
        expect(c.create("")).toBe(false);
        expect(c.create(FAVOURITES)).toBe(false);
        expect(c.create("B")).toBe(true);
        expect(c.rename("B", "Электроника")).toBe(false);
        expect(c.rename("B", "C")).toBe(true);
        expect(c.rename(FAVOURITES, "X")).toBe(false);
        expect(c.names).toEqual(["Электроника", "C"]);
        expect(c.delete("C")).toBe(true);
        expect(c.delete(FAVOURITES)).toBe(false);
        expect(c.names).toEqual(["Электроника"]);
    });

    it("adds and removes entries of both kinds without duplicates", () => {
        const c = new Categories();
        c.create("A");
        expect(c.add("A", apc)).toBe(true);
        expect(c.add("A", apc)).toBe(false);
        expect(c.add("A", plating)).toBe(true);
        expect(c.add("missing", apc)).toBe(false);
        expect(c.containing(apc)).toEqual(["A"]);
        expect(c.remove("A", apc)).toBe(true);
        expect(c.remove("A", apc)).toBe(false);
        expect(c.entries("A")).toEqual([plating]);
    });

    it("holds decals next to entities and tiles, through JSON", () => {
        const warn = { kind: "decal" as const, id: "WarnLineN" };
        const c = new Categories();
        c.create("Stripes");
        expect(c.add("Stripes", warn)).toBe(true);
        expect(c.add("Stripes", { kind: "entity", id: "WarnLineN" })).toBe(true);
        expect(c.toggleFavourite(warn)).toBe(true);
        const back = Categories.fromJSON(c.toJSON());
        expect(back.entries("Stripes")).toEqual([warn, { kind: "entity", id: "WarnLineN" }]);
        expect(back.has(FAVOURITES, warn)).toBe(true);
    });

    it("toggles favourites", () => {
        const c = new Categories();
        expect(c.toggleFavourite(apc)).toBe(true);
        expect(c.has(FAVOURITES, apc)).toBe(true);
        expect(c.toggleFavourite(apc)).toBe(false);
        expect(c.has(FAVOURITES, apc)).toBe(false);
    });

    it("round-trips through JSON", () => {
        const c = new Categories();
        c.create("Электроника");
        c.add("Электроника", apc);
        c.add("Электроника", alarm);
        c.toggleFavourite(plating);
        const back = Categories.fromJSON(c.toJSON());
        expect(back.toFile()).toEqual(c.toFile());
        expect(c.toFile().version).toBe(1);
    });

    it("merges imports by name and validates shape", () => {
        const c = new Categories();
        c.create("A");
        c.add("A", apc);
        const file = parseCategories(
            JSON.stringify({
                version: 1,
                extra: 1,
                categories: [
                    { name: "A", entries: [apc, alarm, { kind: "bad", id: "x" }, { kind: "tile" }], note: "x" },
                    { name: "New", entries: [plating] },
                    { name: 5, entries: [] },
                    { name: FAVOURITES, entries: [apc] },
                ],
            }),
        )!;
        c.merge(file);
        expect(c.names).toEqual(["A", "New"]);
        expect(c.entries("A")).toEqual([apc, alarm]);
        expect(c.entries("New")).toEqual([plating]);
        expect(c.entries(FAVOURITES)).toEqual([apc]);
    });

    it("rejects wrong files", () => {
        for (const t of ["", "nope", "[]", "null", '{"version":2,"categories":[]}', '{"version":1}']) expect(parseCategories(t)).toBeNull();
        expect(Categories.fromJSON("garbage").names).toEqual([]);
    });

    it("persists per fork and survives broken storage", () => {
        const map = new Map<string, string>();
        const st = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
        const c = new Categories();
        c.create("A");
        c.add("A", apc);
        expect(saveCategories("up", c, st)).toBe(true);
        expect(loadCategories("up", st).entries("A")).toEqual([apc]);
        expect(loadCategories("other", st).names).toEqual([]);
        const bad = {
            getItem: () => {
                throw new Error("denied");
            },
            setItem: () => {
                throw new Error("denied");
            },
        };
        expect(loadCategories("up", bad).names).toEqual([]);
        expect(saveCategories("up", c, bad)).toBe(false);
        expect(saveCategories("up", c, null)).toBe(false);
    });
});

describe("category names and undo of delete", () => {
    it("explains why a name is rejected", () => {
        const c = new Categories();
        c.create("A");
        c.create("B");
        expect(c.nameError("  ")).toBe("Enter a name");
        expect(c.nameError("Favorites")).toMatch(/reserved/);
        expect(c.nameError(FAVOURITES)).toMatch(/reserved/);
        expect(c.nameError("A")).toMatch(/exists/);
        expect(c.nameError("A", "A")).toBeNull();
        expect(c.nameError("B", "A")).toMatch(/exists/);
        expect(c.nameError("C", "A")).toBeNull();
    });

    it("restores a deleted category at its position with its entries", () => {
        const c = new Categories();
        for (const n of ["A", "B", "C"]) c.create(n);
        c.add("B", apc);
        const snap = c.snapshot("B")!;
        expect(c.delete("B")).toBe(true);
        expect(c.names).toEqual(["A", "C"]);
        expect(c.restore(snap)).toBe(true);
        expect(c.names).toEqual(["A", "B", "C"]);
        expect(c.entries("B")).toEqual([apc]);
        expect(c.restore(snap)).toBe(false);
        expect(c.snapshot(FAVOURITES)).toBeNull();
        expect(c.snapshot("none")).toBeNull();
    });
});
