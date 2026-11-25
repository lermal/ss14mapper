// The shortcuts list (`?`): keys and mouse of the editor, with the mapper's own bindings from the keymap.
import { t as translate } from "../i18n";
import { chordOfKey, describeChord, formatChord, type Keymap } from "../editor/keymap";
import { button, h, icon, ICON } from "./icons";

/** A row: an action of the keymap, several shown as one, or a fixed mouse gesture. */
type Row = { label: string; action: string } | { label: string; actions: string[]; defaults: string } | { label: string; text: string };

const GROUPS: Array<[string, Row[]]> = [
    [translate("Tools"), [
        { label: translate("Select"), action: "tool.select" },
        { label: translate("Marquee"), action: "tool.marquee" },
        { label: translate("Magic wand"), action: "tool.wand" },
        { label: translate("Brush"), action: "tool.brush" },
        { label: translate("Shapes"), action: "tool.shapes" },
        { label: translate("Eraser"), action: "tool.erase" },
        { label: translate("Eyedropper"), action: "tool.eyedropper" },
        { label: translate("Multitool"), action: "tool.multitool" },
        { label: translate("Ruler"), action: "tool.ruler" },
    ]],
    [translate("Edit"), [
        { label: translate("Undo"), action: "edit.undo" },
        { label: translate("Redo"), action: "edit.redo" },
        { label: translate("Copy"), action: "edit.copy" },
        { label: translate("Cut"), action: "edit.cut" },
        { label: translate("Paste"), action: "edit.paste" },
        { label: translate("Delete"), action: "edit.delete" },
        { label: translate("Select all"), action: "select.all" },
        { label: translate("Deselect"), action: "select.none" },
    ]],
    [translate("Transform"), [
        { label: translate("Rotate clockwise"), action: "edit.rotateCw" },
        { label: translate("Rotate counter-clockwise"), action: "edit.rotateCcw" },
        { label: translate("Nudge"), actions: ["edit.nudgeUp", "edit.nudgeLeft", "edit.nudgeDown", "edit.nudgeRight"], defaults: translate("Arrows") },
        { label: translate("Outline or filled"), action: "tool.shapeFill" },
    ]],
    [translate("Mouse"), [
        { label: translate("Pick from stack"), text: translate("Right-click") },
        { label: translate("Cycle stack"), text: translate("Click again") },
        { label: translate("Move selection"), text: translate("Ctrl+drag") },
        { label: translate("Add or subtract"), text: "Shift / Alt" },
        { label: translate("Sample to brush"), text: translate("Alt+click") },
        { label: translate("Put in container (Brush)"), text: translate("Ctrl+click") },
        { label: translate("Drop into container"), text: translate("Ctrl+drag") },
    ]],
    [translate("Navigation"), [
        { label: translate("Pan"), actions: ["view.panUp", "view.panLeft", "view.panDown", "view.panRight"], defaults: "WASD" },
        { label: translate("Pan (mouse)"), text: translate("Middle or right drag") },
        { label: translate("Zoom"), text: translate("Wheel") },
        { label: translate("Zoom in"), action: "view.zoomIn" },
        { label: translate("Zoom out"), action: "view.zoomOut" },
        { label: translate("Fit map"), action: "view.fit" },
    ]],
    [translate("View and file"), [
        { label: translate("Tile grid"), action: "view.grid" },
        { label: translate("Center of mass"), action: "view.centre" },
        { label: translate("Heading"), action: "view.direction" },
        { label: translate("Subfloor"), action: "view.subfloor" },
        { label: translate("Powered"), action: "view.powered" },
        { label: translate("Network configurator links"), action: "view.configuratorLinks" },
        { label: translate("Node networks"), action: "view.nodes" },
        { label: translate("Open"), action: "file.open" },
        { label: translate("Save"), action: "file.save" },
        { label: translate("Download .yml"), action: "file.download" },
        { label: translate("Shortcuts"), action: "help.shortcuts" },
    ]],
];

const STYLE = `
.keys-overlay { position: fixed; inset: 0; z-index: 1700; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; background: rgba(0, 0, 0, 0.55); }
.keys-sheet { width: 100%; max-width: 980px; max-height: 100%; overflow-y: auto; box-sizing: border-box; padding: 22px 26px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5); font: 13px/1.4 var(--font); }
.keys-sheet .ks-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.keys-sheet h2 { margin: 0; font-size: 18px; font-weight: 600; }
.keys-sheet .ks-sub { color: var(--muted); }
.keys-sheet .ks-grow { flex: 1; }
.keys-sheet .ks-btn { height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); color: var(--text); }
.keys-sheet .ks-close { width: 30px; height: 30px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text); display: grid; place-items: center; }
.keys-sheet .ks-btn:hover, .keys-sheet .ks-close:hover { background: var(--accent-soft); }
.keys-sheet .ks-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 22px; }
.keys-sheet h3 { margin: 0 0 8px; color: var(--muted); font-size: 12px; font-weight: 600; }
.keys-sheet .ks-row { display: flex; align-items: center; gap: 10px; min-height: 28px; }
.keys-sheet .ks-row > span { flex: 1; }
.keys-sheet kbd { padding: 2px 7px; border: 1px solid var(--border-strong); border-bottom-width: 2px; border-radius: 5px; background: var(--raised); font: 12px var(--font); white-space: nowrap; }
.keys-sheet kbd.unbound { color: var(--faint); border-style: dashed; }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

/** The keys text of a row ("" when unbound). */
export function rowKeys(keymap: Keymap, row: Row): string {
    if ("text" in row) return row.text;
    if ("action" in row) return keymap.bindings(row.action).map(describeChord).join(" · ");
    if (row.actions.every((a) => keymap.isDefault(a))) return row.defaults;
    return row.actions.map((a) => keymap.bindings(a).map(describeChord)[0] ?? "").filter(Boolean).join(" ");
}

export class ShortcutsOverlay {
    /** "Customize…" was pressed. */
    onCustomize: (() => void) | null = null;
    private root: HTMLElement | null = null;

    constructor(private readonly keymap: Keymap) {}

    get isOpen(): boolean {
        return this.root !== null;
    }

    toggle(): void {
        if (this.root) this.close();
        else this.open();
    }

    open(): void {
        if (this.root) return;
        addStyle();
        const root = (this.root = h("div", "keys-overlay"));
        const sheet = h("div", "keys-sheet");
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-label", translate("Keyboard shortcuts"));
        const head = h("div", "ks-head");
        head.append(
            h("h2", "", translate("Keyboard shortcuts")),
            h("span", "ks-grow"),
            button("ks-btn", translate("Customize…"), translate("Edit key bindings"), () => {
                this.close();
                this.onCustomize?.();
            }),
        );
        const close = button("ks-close", icon(ICON.close, 16), translate("Close (Esc)"), () => this.close());
        close.setAttribute("aria-label", translate("Close"));
        head.append(close);
        const grid = h("div", "ks-grid");
        for (const [title, rows] of GROUPS) {
            const sec = h("section");
            sec.append(h("h3", "", title));
            for (const r of rows) {
                const keys = rowKeys(this.keymap, r);
                const row = h("div", "ks-row");
                row.append(h("span", "", r.label), h("kbd", keys ? "" : "unbound", keys || "unbound"));
                sec.append(row);
            }
            grid.append(sec);
        }
        sheet.append(head, grid);
        root.append(sheet);
        root.addEventListener("pointerdown", (e) => {
            if (e.target === root) this.close();
        });
        window.addEventListener("keydown", this.key, true);
        document.body.append(root);
    }

    close(): void {
        window.removeEventListener("keydown", this.key, true);
        this.root?.remove();
        this.root = null;
    }

    private readonly key = (e: KeyboardEvent): void => {
        // the editor does not act while the list is open; Esc or the list's own key closes it
        e.stopPropagation();
        const chord = chordOfKey(e);
        if (e.key === "Escape" || (chord && this.keymap.bindings("help.shortcuts").includes(formatChord(chord)))) {
            e.preventDefault();
            this.close();
        }
    };
}
