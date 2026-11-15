// Editor actions and their key / mouse bindings. Pure logic (no DOM): the controller looks events up here
// and runs the handler of the action found; the settings window edits the bindings.
//
// To add an action: add a row to ACTIONS (id, label, group, default bindings) and register its handler
// with `EditorController.handle(id, fn)`. Nothing else needs to know about it: the settings window and
// the stored overrides pick it up from the table.

/** A key (by `KeyboardEvent.code`) or a mouse button ("Mouse1" is the wheel button) with modifiers. */
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
    { id: "tool.select", label: "Select", group: "Tools", defaults: ["KeyV"] },
    { id: "tool.marquee", label: "Marquee", group: "Tools", defaults: ["KeyM"] },
    { id: "tool.wand", label: "Magic wand", group: "Tools", defaults: ["KeyQ"] },
    { id: "tool.brush", label: "Brush", group: "Tools", defaults: ["KeyB"] },
    { id: "tool.shapes", label: "Shapes", group: "Tools", defaults: ["KeyU"] },
    { id: "tool.erase", label: "Eraser", group: "Tools", defaults: ["KeyX"] },
    { id: "tool.eyedropper", label: "Eyedropper", group: "Tools", defaults: ["KeyI"] },
    { id: "tool.multitool", label: "Multitool", group: "Tools", defaults: ["KeyK"] },
    { id: "tool.selectRect", label: "Rectangle marquee", group: "Selection", defaults: [] },
    { id: "tool.selectEllipse", label: "Ellipse marquee", group: "Selection", defaults: ["KeyE"] },
    { id: "tool.lasso", label: "Lasso", group: "Selection", defaults: ["KeyL"] },
    { id: "select.all", label: "Select all", group: "Selection", defaults: ["Ctrl+KeyA"] },
    { id: "select.none", label: "Deselect", group: "Selection", defaults: ["Ctrl+KeyD"] },
    { id: "select.filter", label: "Cycle pick filter", group: "Selection", defaults: [] },
    { id: "tool.shapeLine", label: "Line", group: "Shapes", defaults: ["Shift+KeyL"] },
    { id: "tool.shapeRect", label: "Rectangle", group: "Shapes", defaults: ["Shift+KeyM"] },
    { id: "tool.shapeEllipse", label: "Ellipse", group: "Shapes", defaults: ["Shift+KeyE"] },
    { id: "tool.shapeFill", label: "Outline or filled", group: "Shapes", defaults: ["KeyF"] },
    { id: "edit.rotateCw", label: "Rotate clockwise", group: "Editing", defaults: ["KeyR", "Mouse1"] },
    { id: "edit.rotateCcw", label: "Rotate counter-clockwise", group: "Editing", defaults: ["Shift+KeyR", "Shift+Mouse1"] },
    { id: "edit.delete", label: "Delete", group: "Editing", defaults: ["Delete", "Backspace"] },
    { id: "edit.nudgeUp", label: "Nudge up", group: "Editing", defaults: ["ArrowUp"] },
    { id: "edit.nudgeDown", label: "Nudge down", group: "Editing", defaults: ["ArrowDown"] },
    { id: "edit.nudgeLeft", label: "Nudge left", group: "Editing", defaults: ["ArrowLeft"] },
    { id: "edit.nudgeRight", label: "Nudge right", group: "Editing", defaults: ["ArrowRight"] },
    { id: "edit.copy", label: "Copy", group: "Editing", defaults: ["Ctrl+KeyC"] },
    { id: "edit.cut", label: "Cut", group: "Editing", defaults: ["Ctrl+KeyX"] },
    { id: "edit.paste", label: "Paste", group: "Editing", defaults: ["Ctrl+KeyV"] },
    { id: "edit.undo", label: "Undo", group: "Editing", defaults: ["Ctrl+KeyZ"] },
    { id: "edit.redo", label: "Redo", group: "Editing", defaults: ["Ctrl+Shift+KeyZ", "Ctrl+KeyY"] },
    { id: "edit.cancel", label: "Cancel", group: "Editing", defaults: ["Escape"] },
    // Ctrl+N is the browser's (new window): pages do not get it
    { id: "file.new", label: "New map", group: "File", defaults: [] },
    { id: "file.open", label: "Open file", group: "File", defaults: ["Ctrl+KeyO"] },
    { id: "file.save", label: "Save", group: "File", defaults: ["Ctrl+KeyS"] },
    { id: "file.saveAs", label: "Save as", group: "File", defaults: [] },
    { id: "file.download", label: "Download .yml", group: "File", defaults: ["Ctrl+Shift+KeyS"] },
    { id: "view.panUp", label: "Pan up", group: "Navigation", defaults: ["KeyW"], hold: true },
    { id: "view.panLeft", label: "Pan left", group: "Navigation", defaults: ["KeyA"], hold: true },
    { id: "view.panDown", label: "Pan down", group: "Navigation", defaults: ["KeyS"], hold: true },
    { id: "view.panRight", label: "Pan right", group: "Navigation", defaults: ["KeyD"], hold: true },
    { id: "view.zoomIn", label: "Zoom in", group: "Navigation", defaults: ["Equal", "NumpadAdd"] },
    { id: "view.zoomOut", label: "Zoom out", group: "Navigation", defaults: ["Minus", "NumpadSubtract"] },
    { id: "view.fit", label: "Fit map", group: "Navigation", defaults: ["Shift+Digit1"] },
    { id: "view.subfloor", label: "Subfloor", group: "View", defaults: ["Shift+KeyU"] },
    { id: "view.markers", label: "Markers", group: "View", defaults: [] },
    { id: "view.powered", label: "Powered", group: "View", defaults: ["KeyP"] },
    { id: "view.grid", label: "Tile grid", group: "View", defaults: ["KeyG"] },
    { id: "view.centre", label: "Center of mass", group: "View", defaults: ["KeyC"] },
    { id: "view.direction", label: "Heading", group: "View", defaults: ["KeyH"] },
    { id: "view.links", label: "Device links", group: "View", defaults: [] },
    { id: "view.decals", label: "Decals", group: "View", defaults: [] },
    { id: "view.parallax", label: "Parallax", group: "View", defaults: [] },
    { id: "help.shortcuts", label: "Keyboard shortcuts", group: "View", defaults: ["Shift+Slash"] },
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

const MOUSE_NAMES: Record<string, string> = { Mouse0: "Left click", Mouse1: "Middle click", Mouse2: "Right click", Mouse3: "Mouse back", Mouse4: "Mouse forward" };

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
