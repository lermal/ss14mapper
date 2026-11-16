// Editor actions and their key / mouse bindings. Pure logic (no DOM): the controller looks events up here
// and runs the handler of the action found; the settings window edits the bindings.
//
// To add an action: add a row to ACTIONS (id, label, group, default bindings) and register its handler
// with `EditorController.handle(id, fn)`. Nothing else needs to know about it: the settings window and
// the stored overrides pick it up from the table.

/** A key (by `KeyboardEvent.code`) or a mouse button ("Mouse1" is the wheel button) with modifiers. */
import { t as translate } from "../i18n";
export interface Chord {
    base: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
}

export interface ActionDef {
    id: string;
    label: string;
    /** Section of the settings window. */
    group: string;
    /** Default bindings, written as "Ctrl+Shift+KeyZ" or "Shift+Mouse1". */
    defaults: string[];
    /** Acts while the key is held (navigation); Shift on top of the binding makes it faster. */
    hold?: boolean;
}

export const ACTIONS: readonly ActionDef[] = [
    { id: "tool.select", label: translate("Select"), group: translate("Tools"), defaults: ["KeyV"] },
    { id: "tool.marquee", label: translate("Marquee"), group: translate("Tools"), defaults: ["KeyM"] },
    { id: "tool.wand", label: translate("Magic wand"), group: translate("Tools"), defaults: ["KeyQ"] },
    { id: "tool.brush", label: translate("Brush"), group: translate("Tools"), defaults: ["KeyB"] },
    { id: "tool.shapes", label: translate("Shapes"), group: translate("Tools"), defaults: ["KeyU"] },
    { id: "tool.erase", label: translate("Eraser"), group: translate("Tools"), defaults: ["KeyX"] },
    { id: "tool.eyedropper", label: translate("Eyedropper"), group: translate("Tools"), defaults: ["KeyI"] },
    { id: "tool.multitool", label: translate("Multitool"), group: translate("Tools"), defaults: ["KeyK"] },
    { id: "tool.ruler", label: translate("Ruler"), group: translate("Tools"), defaults: [] },
    { id: "tool.selectRect", label: translate("Rectangle marquee"), group: translate("Selection"), defaults: [] },
    { id: "tool.selectEllipse", label: translate("Ellipse marquee"), group: translate("Selection"), defaults: ["KeyE"] },
    { id: "tool.lasso", label: translate("Lasso"), group: translate("Selection"), defaults: ["KeyL"] },
    { id: "select.all", label: translate("Select all"), group: translate("Selection"), defaults: ["Ctrl+KeyA"] },
    { id: "select.none", label: translate("Deselect"), group: translate("Selection"), defaults: ["Ctrl+KeyD"] },
    { id: "select.filter", label: translate("Cycle pick filter"), group: translate("Selection"), defaults: [] },
    { id: "tool.shapeLine", label: translate("Line"), group: translate("Shapes"), defaults: ["Shift+KeyL"] },
    { id: "tool.shapeRect", label: translate("Rectangle"), group: translate("Shapes"), defaults: ["Shift+KeyM"] },
    { id: "tool.shapeEllipse", label: translate("Ellipse"), group: translate("Shapes"), defaults: ["Shift+KeyE"] },
    { id: "tool.shapeFill", label: translate("Outline or filled"), group: translate("Shapes"), defaults: ["KeyF"] },
    { id: "edit.flipHorizontal", label: translate("Flip horizontally"), group: translate("Editing"), defaults: [] },
    { id: "edit.flipVertical", label: translate("Flip vertically"), group: translate("Editing"), defaults: [] },
    { id: "edit.rotateCw", label: translate("Rotate clockwise"), group: translate("Editing"), defaults: ["KeyR", "Mouse1"] },
    { id: "edit.rotateCcw", label: translate("Rotate counter-clockwise"), group: translate("Editing"), defaults: ["Shift+KeyR", "Shift+Mouse1"] },
    { id: "edit.delete", label: translate("Delete"), group: translate("Editing"), defaults: ["Delete", "Backspace"] },
    { id: "edit.nudgeUp", label: translate("Nudge up"), group: translate("Editing"), defaults: ["ArrowUp"] },
    { id: "edit.nudgeDown", label: translate("Nudge down"), group: translate("Editing"), defaults: ["ArrowDown"] },
    { id: "edit.nudgeLeft", label: translate("Nudge left"), group: translate("Editing"), defaults: ["ArrowLeft"] },
    { id: "edit.nudgeRight", label: translate("Nudge right"), group: translate("Editing"), defaults: ["ArrowRight"] },
    { id: "edit.copy", label: translate("Copy"), group: translate("Editing"), defaults: ["Ctrl+KeyC"] },
    { id: "edit.cut", label: translate("Cut"), group: translate("Editing"), defaults: ["Ctrl+KeyX"] },
    { id: "edit.paste", label: translate("Paste"), group: translate("Editing"), defaults: ["Ctrl+KeyV"] },
    { id: "edit.undo", label: translate("Undo"), group: translate("Editing"), defaults: ["Ctrl+KeyZ"] },
    { id: "edit.redo", label: translate("Redo"), group: translate("Editing"), defaults: ["Ctrl+Shift+KeyZ", "Ctrl+KeyY"] },
    { id: "edit.cancel", label: translate("Cancel"), group: translate("Editing"), defaults: ["Escape"] },
    // Ctrl+N is the browser's (new window): pages do not get it
    { id: "file.new", label: translate("New map"), group: translate("File"), defaults: [] },
    { id: "file.open", label: translate("Open file"), group: translate("File"), defaults: ["Ctrl+KeyO"] },
    { id: "file.save", label: translate("Save"), group: translate("File"), defaults: ["Ctrl+KeyS"] },
    { id: "file.saveAs", label: translate("Save as"), group: translate("File"), defaults: [] },
    { id: "file.download", label: translate("Download .yml"), group: translate("File"), defaults: ["Ctrl+Shift+KeyS"] },
    { id: "view.panUp", label: translate("Pan up"), group: translate("Navigation"), defaults: ["KeyW"], hold: true },
    { id: "view.panLeft", label: translate("Pan left"), group: translate("Navigation"), defaults: ["KeyA"], hold: true },
    { id: "view.panDown", label: translate("Pan down"), group: translate("Navigation"), defaults: ["KeyS"], hold: true },
    { id: "view.panRight", label: translate("Pan right"), group: translate("Navigation"), defaults: ["KeyD"], hold: true },
    { id: "view.zoomIn", label: translate("Zoom in"), group: translate("Navigation"), defaults: ["Equal", "NumpadAdd"] },
    { id: "view.zoomOut", label: translate("Zoom out"), group: translate("Navigation"), defaults: ["Minus", "NumpadSubtract"] },
    { id: "view.fit", label: translate("Fit map"), group: translate("Navigation"), defaults: ["Shift+Digit1"] },
    { id: "view.subfloor", label: translate("Subfloor"), group: translate("View"), defaults: ["Shift+KeyU"] },
    { id: "view.markers", label: translate("Markers"), group: translate("View"), defaults: [] },
    { id: "view.powered", label: translate("Powered"), group: translate("View"), defaults: ["KeyP"] },
    { id: "view.grid", label: translate("Tile grid"), group: translate("View"), defaults: ["KeyG"] },
    { id: "view.centre", label: translate("Center of mass"), group: translate("View"), defaults: ["KeyC"] },
    { id: "view.direction", label: translate("Heading"), group: translate("View"), defaults: ["KeyH"] },
    { id: "view.links", label: translate("Device links"), group: translate("View"), defaults: [] },
    { id: "view.configuratorLinks", label: translate("Network configurator links"), group: translate("View"), defaults: [] },
    { id: "view.nodes", label: translate("Node networks"), group: translate("View"), defaults: [] },
    { id: "view.decals", label: translate("Decals"), group: translate("View"), defaults: [] },
    { id: "view.parallax", label: translate("Parallax"), group: translate("View"), defaults: [] },
    { id: "help.shortcuts", label: translate("Keyboard shortcuts"), group: translate("View"), defaults: ["Shift+Slash"] },
];

const MODIFIER_CODES = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/;

/** Canonical text of a chord: modifiers in the fixed order Ctrl, Alt, Shift, then the key. */
export function formatChord(c: Chord): string {
    return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", c.base].filter(Boolean).join("+");
}

export function parseChord(text: string): Chord | null {
    const parts = text.split("+");
    const base = parts.pop();
    if (!base || !/^(Mouse\d|[A-Z][A-Za-z0-9]*)$/.test(base) || MODIFIER_CODES.test(base)) return null;
    const c: Chord = { base, ctrl: false, alt: false, shift: false };
    for (const m of parts) {
        if (m === "Ctrl") c.ctrl = true;
        else if (m === "Alt") c.alt = true;
        else if (m === "Shift") c.shift = true;
        else return null;
    }
    return c;
}

interface Mods {
    ctrlKey: boolean;
    metaKey?: boolean;
    altKey: boolean;
    shiftKey: boolean;
}

/** The chord of a key press; null for a modifier key on its own. */
export function chordOfKey(e: Mods & { code: string }): Chord | null {
    if (!e.code || e.code === "Unidentified" || MODIFIER_CODES.test(e.code)) return null;
    return { base: e.code, ctrl: e.ctrlKey || !!e.metaKey, alt: e.altKey, shift: e.shiftKey };
}

export function chordOfMouse(e: Mods & { button: number }): Chord {
    return { base: `Mouse${e.button}`, ctrl: e.ctrlKey || !!e.metaKey, alt: e.altKey, shift: e.shiftKey };
}

/** Mouse buttons that can carry an action (the left and right ones belong to the tools). */
export const BINDABLE_BUTTONS = [1, 3, 4];

const MOUSE_NAMES: Record<string, string> = { Mouse0: translate("Left click"), Mouse1: translate("Middle click"), Mouse2: translate("Right click"), Mouse3: translate("Mouse back"), Mouse4: translate("Mouse forward") };

/** Keys whose code says little: the character on a US layout. */
const KEY_NAMES: Record<string, string> = {
    Slash: "/", Backslash: "\\", Equal: "=", Minus: "-", Comma: ",", Period: ".", Semicolon: ";", Quote: "'",
    Backquote: "`", BracketLeft: "[", BracketRight: "]", NumpadAdd: "Num +", NumpadSubtract: "Num -",
};

/** Human text of a key code: "KeyR" → "R", "ArrowUp" → "Up". */
function keyName(code: string): string {
    return MOUSE_NAMES[code] ?? KEY_NAMES[code] ?? code.replace(/^Key|^Digit/, "").replace(/^Arrow/, "").replace(/^Numpad/, "Num ").replace(/^Bracket/, "Bracket ");
}

export function describeChord(text: string): string {
    const c = parseChord(text);
    if (!c) return text;
    if (c.base === "Slash" && c.shift && !c.ctrl && !c.alt) return "?";
    return [c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift", keyName(c.base)].filter(Boolean).join("+");
}

/** Where overrides are kept (the browser's localStorage, or anything with these three methods). */
export interface KeyStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/** localStorage, or null when the browser denies it. */
export function browserStorage(): KeyStorage | null {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export const STORAGE_KEY = "ss14mapper.keys";

export interface Found {
    action: ActionDef;
    /** Matched only after dropping Shift from the press (a held action going faster). */
    boost: boolean;
}

export class Keymap {
    private overrides = new Map<string, string[]>();
    private index: Map<string, string> | null = null;
    private readonly listeners = new Set<() => void>();
    private readonly byId = new Map<string, ActionDef>();

    constructor(
        readonly actions: readonly ActionDef[] = ACTIONS,
        private readonly storage: KeyStorage | null = null,
    ) {
        for (const a of actions) this.byId.set(a.id, a);
        this.load();
    }

    action(id: string): ActionDef | undefined {
        return this.byId.get(id);
    }

    /** Current bindings of an action (written form). */
    bindings(id: string): string[] {
        return this.overrides.get(id) ?? this.byId.get(id)?.defaults ?? [];
    }

    isDefault(id: string): boolean {
        return !this.overrides.has(id);
    }

    /** "R / Middle click" for tooltips; empty when unbound. */
    describe(id: string): string {
        return this.bindings(id).map(describeChord).join(" / ");
    }

    /** Replaces the bindings of an action (an empty list leaves it unbound). */
    set(id: string, bindings: string[]): void {
        const def = this.byId.get(id);
        if (!def) return;
        const clean = [...new Set(bindings)].filter((b) => parseChord(b));
        if (clean.length === def.defaults.length && clean.every((b, i) => b === def.defaults[i])) this.overrides.delete(id);
        else this.overrides.set(id, clean);
        this.changed();
    }

    reset(id: string): void {
        if (this.overrides.delete(id)) this.changed();
    }

    resetAll(): void {
        if (!this.overrides.size) return;
        this.overrides.clear();
        this.changed();
    }

    /** The overrides by action id (actions left at their defaults are absent), for the settings sync. */
    overridesById(): Record<string, string[]> {
        return Object.fromEntries([...this.overrides].map(([id, list]) => [id, [...list]]));
    }

    /** Replaces every override at once (synced settings); unknown actions and invalid bindings are dropped. */
    replaceOverrides(data: Record<string, string[]>): void {
        this.overrides.clear();
        for (const [id, list] of Object.entries(data)) {
            if (this.byId.has(id) && Array.isArray(list)) this.overrides.set(id, list.filter((b) => typeof b === "string" && !!parseChord(b)));
        }
        this.changed();
    }

    /** Another tab changed the stored overrides: reads them again (not saved back) and tells the listeners. */
    reload(): void {
        this.overrides.clear();
        this.load();
        this.index = null;
        for (const fn of this.listeners) fn();
    }

    /** The action a chord triggers; a held action also answers to its chord with Shift (faster). */
    lookup(chord: Chord): Found | null {
        const index = this.buildIndex();
        let id = index.get(formatChord(chord));
        if (id) return { action: this.byId.get(id)!, boost: false };
        if (chord.shift) {
            id = index.get(formatChord({ ...chord, shift: false }));
            const action = id ? this.byId.get(id)! : null;
            if (action?.hold) return { action, boost: true };
        }
        return null;
    }

    /** Other actions bound to this chord. */
    conflicts(chord: Chord, except: string): ActionDef[] {
        const key = formatChord(chord);
        return this.actions.filter((a) => a.id !== except && this.bindings(a.id).includes(key));
    }

    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private buildIndex(): Map<string, string> {
        if (this.index) return this.index;
        const index = new Map<string, string>();
        for (const a of this.actions) for (const b of this.bindings(a.id)) if (!index.has(b)) index.set(b, a.id);
        return (this.index = index);
    }

    private changed(): void {
        this.index = null;
        this.save();
        for (const fn of this.listeners) fn();
    }

    private load(): void {
        try {
            const raw = this.storage?.getItem(STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw) as Record<string, unknown>;
            for (const [id, list] of Object.entries(data)) {
                if (!this.byId.has(id) || !Array.isArray(list)) continue;
                this.overrides.set(id, list.filter((b): b is string => typeof b === "string" && !!parseChord(b)));
            }
        } catch {
            // unreadable settings: defaults
        }
    }

    private save(): void {
        try {
            if (!this.storage) return;
            if (this.overrides.size) this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.overrides)));
            else this.storage.removeItem(STORAGE_KEY);
        } catch {
            // storage full or denied: the bindings last until the page closes
        }
    }
}
