import { describe, expect, it } from "vitest";
import { ACTIONS, Keymap, chordOfKey, chordOfMouse, describeChord, formatChord, parseChord, type KeyStorage } from "../src/editor/keymap";

const mem = (): KeyStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const key = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    chordOfKey({ code, ctrlKey: false, altKey: false, shiftKey: false, ...mods })!;
const id = (km: Keymap, c: ReturnType<typeof key>) => km.lookup(c)?.action.id ?? null;

describe("chords", () => {
    it("round-trips and normalises", () => {
        expect(formatChord(parseChord("Shift+Ctrl+KeyZ") ?? key("x"))).toBe("Ctrl+Shift+KeyZ");
        expect(parseChord("Ctrl+")).toBeNull();
        expect(parseChord("Foo+KeyA")).toBeNull();
        expect(parseChord("Shift")).toBeNull();
        expect(chordOfKey({ code: "ShiftLeft", ctrlKey: false, altKey: false, shiftKey: true })).toBeNull();
        expect(formatChord(chordOfMouse({ button: 1, ctrlKey: false, altKey: false, shiftKey: true }))).toBe("Shift+Mouse1");
        expect(formatChord(key("KeyS", { metaKey: true }))).toBe("Ctrl+KeyS");
    });
    it("describes for people", () => {
        expect(describeChord("Ctrl+Shift+KeyZ")).toBe("Ctrl+Shift+Z");
        expect(describeChord("Mouse1")).toBe("Middle click");
        expect(describeChord("ArrowUp")).toBe("Up");
        expect(describeChord("Shift+Slash")).toBe("?");
        expect(describeChord("Shift+Digit1")).toBe("Shift+1");
        expect(describeChord("Equal")).toBe("=");
    });
});

describe("default bindings", () => {
    const km = new Keymap();
    it("has unique ids and no clashing defaults", () => {
        expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
        const seen = new Map<string, string>();
        for (const a of ACTIONS) for (const b of a.defaults) {
            expect(parseChord(b), b).not.toBeNull();
            expect(seen.get(b), b).toBeUndefined();
            seen.set(b, a.id);
        }
    });
    it("maps the shortcuts of the editor", () => {
        expect(id(km, key("KeyR"))).toBe("edit.rotateCw");
        expect(id(km, key("KeyR", { shiftKey: true }))).toBe("edit.rotateCcw");
        expect(id(km, chordOfMouse({ button: 1, ctrlKey: false, altKey: false, shiftKey: false }) as any)).toBe("edit.rotateCw");
        expect(id(km, chordOfMouse({ button: 1, ctrlKey: false, altKey: false, shiftKey: true }) as any)).toBe("edit.rotateCcw");
        expect(id(km, key("KeyZ", { ctrlKey: true }))).toBe("edit.undo");
        expect(id(km, key("KeyZ", { ctrlKey: true, shiftKey: true }))).toBe("edit.redo");
        expect(id(km, key("KeyY", { ctrlKey: true }))).toBe("edit.redo");
        expect(id(km, key("Delete"))).toBe("edit.delete");
        expect(id(km, key("Escape"))).toBe("edit.cancel");
    });
    it("maps the selection and shape tools", () => {
        expect(id(km, key("KeyM"))).toBe("tool.marquee");
        expect(id(km, key("KeyE"))).toBe("tool.selectEllipse");
        expect(id(km, key("KeyL"))).toBe("tool.lasso");
        expect(id(km, key("KeyQ"))).toBe("tool.wand");
        expect(id(km, key("KeyK"))).toBe("tool.multitool");
        expect(id(km, key("KeyA", { ctrlKey: true }))).toBe("select.all");
        expect(id(km, key("KeyD", { ctrlKey: true }))).toBe("select.none");
        expect(id(km, key("KeyD"))).toBe("view.panRight");
        expect(id(km, key("KeyL", { shiftKey: true }))).toBe("tool.shapeLine");
        expect(id(km, key("KeyM", { shiftKey: true }))).toBe("tool.shapeRect");
        expect(id(km, key("KeyE", { shiftKey: true }))).toBe("tool.shapeEllipse");
        expect(id(km, key("KeyF"))).toBe("tool.shapeFill");
        expect(id(km, key("ArrowLeft"))).toBe("edit.nudgeLeft");
        expect(km.bindings("select.filter")).toEqual([]);
        expect(km.bindings("tool.selectRect")).toEqual([]);
    });
    it("maps the tools of the rail, the view layers and the shortcuts list", () => {
        expect(id(km, key("KeyV"))).toBe("tool.select");
        expect(id(km, key("KeyB"))).toBe("tool.brush");
        expect(id(km, key("KeyU"))).toBe("tool.shapes");
        expect(id(km, key("KeyX"))).toBe("tool.erase");
        expect(id(km, key("KeyI"))).toBe("tool.eyedropper");
        expect(id(km, key("KeyU", { shiftKey: true }))).toBe("view.subfloor");
        expect(id(km, key("KeyP"))).toBe("view.powered");
        expect(id(km, key("Digit1", { shiftKey: true }))).toBe("view.fit");
        expect(id(km, key("Slash", { shiftKey: true }))).toBe("help.shortcuts");
        expect(id(km, key("Equal"))).toBe("view.zoomIn");
        expect(id(km, key("Minus"))).toBe("view.zoomOut");
        expect(id(km, key("KeyO", { ctrlKey: true }))).toBe("file.open");
        expect(km.describe("help.shortcuts")).toBe("?");
    });
    it("keeps Ctrl+S apart from S (pan down)", () => {
        expect(id(km, key("KeyS"))).toBe("view.panDown");
        expect(id(km, key("KeyS", { ctrlKey: true }))).toBe("file.save");
        expect(id(km, key("KeyS", { altKey: true }))).toBeNull();
        expect(id(km, key("KeyS", { ctrlKey: true, shiftKey: true }))).toBe("file.download");
        // Ctrl+N belongs to the browser: New map has no default binding
        expect(id(km, key("KeyN", { ctrlKey: true }))).toBeNull();
        expect(km.bindings("file.new")).toEqual([]);
    });
    it("lets Shift speed up held actions only", () => {
        expect(km.lookup(key("KeyW"))).toMatchObject({ boost: false });
        expect(km.lookup(key("KeyW", { shiftKey: true }))).toMatchObject({ boost: true, action: { id: "view.panUp" } });
        expect(km.lookup(key("KeyG", { shiftKey: true }))).toBeNull();
    });
});

describe("overrides", () => {
    it("reassigns, persists and resets", () => {
        const storage = mem();
        const km = new Keymap(ACTIONS, storage);
        km.set("edit.rotateCw", ["KeyJ", "Mouse1"]);
        expect(id(km, key("KeyJ"))).toBe("edit.rotateCw");
        expect(id(km, key("KeyR"))).toBeNull();
        expect(km.isDefault("edit.rotateCw")).toBe(false);
        // a reload
        const again = new Keymap(ACTIONS, storage);
        expect(id(again, key("KeyJ"))).toBe("edit.rotateCw");
        again.reset("edit.rotateCw");
        expect(id(again, key("KeyR"))).toBe("edit.rotateCw");
        expect(storage.data.size).toBe(0);
        km.set("edit.rotateCw", ["KeyJ"]);
        km.resetAll();
        expect(km.bindings("edit.rotateCw")).toEqual(["KeyR", "Mouse1"]);
    });
    it("setting the defaults again drops the override", () => {
        const km = new Keymap(ACTIONS, mem());
        km.set("edit.delete", []);
        expect(km.bindings("edit.delete")).toEqual([]);
        km.set("edit.delete", ["Delete", "Backspace"]);
        expect(km.isDefault("edit.delete")).toBe(true);
    });
    it("reports conflicts", () => {
        const km = new Keymap();
        expect(km.conflicts(key("KeyR"), "edit.delete").map((a) => a.id)).toEqual(["edit.rotateCw"]);
        expect(km.conflicts(key("KeyR"), "edit.rotateCw")).toEqual([]);
        expect(km.conflicts(key("KeyO"), "edit.delete")).toEqual([]);
        expect(km.conflicts(key("KeyK"), "edit.delete").map((a) => a.id)).toEqual(["tool.multitool"]);
    });
    it("ignores broken or unknown stored data and works without storage", () => {
        const bad = mem();
        bad.setItem("ss14mapper.keys", "{nope");
        expect(new Keymap(ACTIONS, bad).bindings("edit.undo")).toEqual(["Ctrl+KeyZ"]);
        const odd = mem();
        odd.setItem("ss14mapper.keys", JSON.stringify({ "edit.undo": ["KeyU", 5, "???"], gone: ["KeyA"] }));
        expect(new Keymap(ACTIONS, odd).bindings("edit.undo")).toEqual(["KeyU"]);
        const throwing: KeyStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
        const km = new Keymap(ACTIONS, throwing);
        km.set("edit.undo", ["KeyU"]);
        expect(km.bindings("edit.undo")).toEqual(["KeyU"]);
        expect(new Keymap(ACTIONS, null).bindings("edit.undo")).toEqual(["Ctrl+KeyZ"]);
    });
    it("notifies listeners", () => {
        const km = new Keymap();
        let n = 0;
        const off = km.onChange(() => n++);
        km.set("edit.undo", ["KeyU"]);
        off();
        km.reset("edit.undo");
        expect(n).toBe(1);
    });
    it("takes rows added to the table", () => {
        const km = new Keymap([...ACTIONS, { id: "edit.copy", label: "Copy", group: "Editing", defaults: ["Ctrl+KeyC"] }]);
        expect(id(km, key("KeyC", { ctrlKey: true }))).toBe("edit.copy");
        expect(id(km, key("KeyC"))).toBe("view.centre");
    });
});
