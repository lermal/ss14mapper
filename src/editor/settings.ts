// Settings window of the editor: every action with its bindings; click a binding and press a key or a
// mouse button to change it. Conflicts are shown with a choice to replace; edits are saved by the `Keymap`.
import { t as translate } from "../i18n";
import { icon, ICON } from "../ui/icons";
import { BINDABLE_BUTTONS, chordOfKey, chordOfMouse, describeChord, formatChord, type ActionDef, type Chord, type Keymap } from "./keymap";

const CSS = `
.keys-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; z-index: 1750; padding: 24px; }
.keys-dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-l); width: min(680px, 100%); max-height: 100%; display: flex; flex-direction: column; box-shadow: var(--shadow); font: 13px/1.4 var(--font); }
.keys-dialog header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.keys-dialog h2 { margin: 0; font-size: 15px; font-weight: 600; }
.keys-body { overflow: auto; padding: 4px 18px 12px; }
.keys-body h3 { margin: 16px 0 6px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.keys-row { display: flex; align-items: center; gap: 6px; min-height: 30px; flex-wrap: wrap; }
.keys-row .name { flex: 0 0 230px; }
.keys-dialog button { height: 26px; padding: 0 10px; background: var(--raised); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.keys-dialog button:hover { border-color: var(--border-strong); filter: brightness(1.12); }
.keys-dialog button.ks-x { width: 26px; padding: 0; display: grid; place-items: center; background: transparent; border-color: transparent; color: var(--muted); }
.keys-dialog button.ks-x:hover { background: var(--raised); color: var(--text); }
.keys-dialog button.chip { min-width: 54px; border-bottom-width: 2px; border-color: var(--border-strong); border-radius: 5px; font-size: 12px; }
.keys-dialog button.chip.capturing, .keys-dialog button.mini.capturing { background: #3a3016; border-color: var(--warn); color: var(--warn); }
.keys-dialog button.mini { padding: 0 7px; background: transparent; border-color: transparent; color: var(--muted); }
.keys-dialog button.mini:hover { color: var(--text); background: var(--raised); }
.keys-dialog .unbound { color: var(--faint); }
.keys-dialog .warn { flex-basis: 100%; margin: 2px 0 6px 236px; color: var(--warn); font-size: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.keys-dialog footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; flex-wrap: wrap; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: Array<Node | string>): HTMLElementTagNameMap[K] {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
}

/** A binding being chosen: the slot of an action (index -1 adds a new binding). */
interface Capture {
    id: string;
    index: number;
}

export class SettingsWindow {
    private root: HTMLElement | null = null;
    private capture: Capture | null = null;
    /** A chord waiting for the choice to replace another action's binding. */
    private conflict: (Capture & { chord: Chord; others: ActionDef[] }) | null = null;
    private unsubscribe: (() => void) | null = null;

    constructor(private readonly keymap: Keymap) {}

    get isOpen(): boolean {
        return this.root !== null;
    }

    open(): void {
        if (this.root) return;
        if (!document.getElementById("keys-style")) {
            const style = document.createElement("style");
            style.id = "keys-style";
            style.textContent = CSS;
            document.head.append(style);
        }
        const root = (this.root = document.createElement("div"));
        root.className = "keys-backdrop";
        root.addEventListener("mousedown", (e) => {
            // a click outside the window closes it, unless a binding is being chosen
            if (e.target === root && !this.capture) this.close();
        });
        document.body.append(root);
        // capture phase: while the window is open the editor does not see the keys
        window.addEventListener("keydown", this.keyDown, true);
        window.addEventListener("mousedown", this.mouseDown, true);
        window.addEventListener("auxclick", this.stopAux, true);
        this.unsubscribe = this.keymap.onChange(() => this.render());
        this.render();
        root.querySelector<HTMLElement>("button")?.focus();
    }

    close(): void {
        this.cancelCapture();
        window.removeEventListener("keydown", this.keyDown, true);
        window.removeEventListener("mousedown", this.mouseDown, true);
        window.removeEventListener("auxclick", this.stopAux, true);
        this.unsubscribe?.();
        this.root?.remove();
        this.root = null;
    }

    private cancelCapture(): void {
        this.capture = null;
        this.conflict = null;
    }

    private readonly keyDown = (e: KeyboardEvent): void => {
        if (e.code === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (this.capture || this.conflict) {
                this.cancelCapture();
                this.render();
            } else this.close();
            return;
        }
        if (!this.capture) {
            // plain navigation of the window (Tab, Enter, Space on buttons) works; the editor stays out of it
            e.stopPropagation();
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const chord = chordOfKey(e);
        if (chord) this.choose(chord);
    };

    private readonly mouseDown = (e: MouseEvent): void => {
        if (!this.capture || !BINDABLE_BUTTONS.includes(e.button)) return;
        e.preventDefault();
        e.stopPropagation();
        this.choose(chordOfMouse(e));
    };

    /** Browsers act on middle clicks (autoscroll, back/forward); not while choosing. */
    private readonly stopAux = (e: MouseEvent): void => {
        if (this.capture) e.preventDefault();
    };

    private choose(chord: Chord): void {
        const cap = this.capture!;
        const others = this.keymap.conflicts(chord, cap.id);
        if (others.length) {
            this.conflict = { ...cap, chord, others };
            this.capture = null;
            this.render();
            return;
        }
        this.apply(cap, chord, []);
    }

    /** Stores a chord in a slot of an action and removes it from the actions it replaces. */
    private apply(slot: Capture, chord: Chord, replaced: ActionDef[]): void {
        const text = formatChord(chord);
        this.cancelCapture();
        for (const other of replaced) this.keymap.set(other.id, this.keymap.bindings(other.id).filter((b) => b !== text));
        const list = this.keymap.bindings(slot.id).filter((b, i) => b !== text || i === slot.index);
        if (slot.index < 0 || slot.index >= list.length) list.push(text);
        else list[Math.min(slot.index, list.length - 1)] = text;
        this.keymap.set(slot.id, list);
        this.render();
    }

    private render(): void {
        const root = this.root;
        if (!root) return;
        const dialog = el("div", { className: "keys-dialog", role: "dialog" });
        dialog.setAttribute("aria-label", translate("Key bindings"));
        const close = el("button", { onclick: () => this.close(), title: translate("Close"), className: "ks-x" });
        close.setAttribute("aria-label", translate("Close"));
        close.append(icon(ICON.close, 14));
        dialog.append(el("header", {}, el("h2", { textContent: translate("Key bindings") }), close));

        const body = el("div", { className: "keys-body" });
        let group = "";
        for (const a of this.keymap.actions) {
            if (a.group !== group) {
                group = a.group;
                body.append(el("h3", { textContent: group }));
            }
            body.append(this.row(a));
        }
        dialog.append(body);

        const hint = el("span", {
            textContent: this.capture ? translate("Press a key or mouse button. Esc to cancel.") : translate("Click a binding to change it"),
        });
        const all = el("button", { textContent: translate("Reset all"), onclick: () => this.keymap.resetAll() });
        dialog.append(el("footer", {}, hint, all));
        root.replaceChildren(dialog);
        (root.querySelector(".capturing") as HTMLElement | null)?.focus();
    }

    private row(a: ActionDef): HTMLElement {
        const row = el("div", { className: "keys-row" });
        row.append(el("span", { className: "name", textContent: a.label }));
        const list = this.keymap.bindings(a.id);
        list.forEach((b, i) => {
            const capturing = this.capture?.id === a.id && this.capture.index === i;
            const chip = el("button", {
                className: "chip" + (capturing ? " capturing" : ""),
                textContent: capturing ? translate("Press a key…") : describeChord(b),
                title: translate("Change"),
                onclick: () => {
                    this.conflict = null;
                    this.capture = { id: a.id, index: i };
                    this.render();
                },
            });
            row.append(chip, el("button", { className: "mini", textContent: "×", title: translate("Remove"), onclick: () => this.keymap.set(a.id, list.filter((_, j) => j !== i)) }));
        });
        if (!list.length) row.append(el("span", { className: "unbound", textContent: translate("Unbound") }));
        const adding = this.capture?.id === a.id && this.capture.index < 0;
        row.append(
            el("button", {
                className: "mini" + (adding ? " capturing" : ""),
                textContent: adding ? translate("Press a key…") : "+",
                title: translate("Add"),
                onclick: () => {
                    this.conflict = null;
                    this.capture = { id: a.id, index: -1 };
                    this.render();
                },
            }),
        );
        if (!this.keymap.isDefault(a.id)) row.append(el("button", { className: "mini", textContent: translate("Reset"), title: translate("Reset to default"), onclick: () => this.keymap.reset(a.id) }));
        const c = this.conflict;
        if (c && c.id === a.id) {
            const names = c.others.map((o) => o.label).join(", ");
            const warn = el("div", { className: "warn" });
            warn.append(
                translate("{{1}} is already assigned to {{2}}", { 1: describeChord(formatChord(c.chord)), 2: names }),
                el("button", { textContent: translate("Replace"), onclick: () => this.apply(c, c.chord, c.others) }),
                el("button", { textContent: translate("Cancel"), onclick: () => (this.cancelCapture(), this.render()) }),
            );
            row.append(warn);
        }
        return row;
    }
}
