// Settings window of the editor: every action with its bindings; click a binding and press a key or a
// mouse button to change it. Conflicts are shown with a choice to replace; edits are saved by the `Keymap`.
import { t as translate } from "../i18n";
import { icon, ICON } from "../ui/icons";
import { BINDABLE_BUTTONS, chordOfKey, chordOfMouse, describeChord, formatChord, type ActionDef, type Chord, type Keymap } from "./keymap";

const CSS = `
.keys-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; z-index: 1750; padding: 24px; }
.keys-dialog { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-l); width: min(720px, 100%); max-height: 100%; display: flex; flex-direction: column; box-shadow: var(--shadow); font: 13px/1.4 var(--font); }
.keys-dialog header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.keys-dialog h2 { margin: 0; font-size: 18px; font-weight: 600; }
.keys-search { padding: 14px 20px; }
.keys-search input { width: 100%; height: 34px; box-sizing: border-box; padding: 0 10px; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-s); }
.keys-body { overflow: auto; min-height: 0; padding: 0 20px 16px; }
.keys-group { border-top: 1px solid var(--border); }
.keys-group summary { display: flex; align-items: center; gap: 8px; min-height: 38px; cursor: pointer; list-style: none; font-weight: 600; }
.keys-group summary::-webkit-details-marker { display: none; }
.keys-group summary svg { flex: none; color: var(--muted); }
.keys-group[open] summary svg { transform: rotate(90deg); }
.keys-group summary .count { margin-left: auto; color: var(--muted); font: 11px var(--mono); }
.keys-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 6px 16px; min-height: 32px; padding: 4px 0; border-top: 1px solid var(--border); }
.keys-row:first-child { border-top: 0; }
.keys-row .name { min-width: 0; overflow-wrap: anywhere; }
.keys-bindings { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.keys-binding { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
.keys-dialog button { min-height: 28px; padding: 0 10px; background: transparent; color: var(--text); border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
.keys-dialog button:hover { background: var(--raised); }
.keys-dialog button.ks-x { width: 32px; padding: 0; display: grid; place-items: center; color: var(--muted); }
.keys-dialog button.chip { min-width: 44px; border: 0; border-radius: 0; background: var(--input); font: 12px var(--mono); }
.keys-dialog button.chip.capturing, .keys-dialog button.mini.capturing { background: #3a3016; color: var(--warn); outline: 1px solid var(--warn); outline-offset: -1px; }
.keys-dialog button.mini { padding: 0 7px; color: var(--muted); }
.keys-dialog button.mini:hover { color: var(--text); }
.keys-dialog .unbound { color: var(--faint); }
.keys-dialog .warn { grid-column: 1 / -1; padding: 8px 10px; margin-bottom: 4px; background: var(--panel-2); border-left: 2px solid var(--warn); color: var(--warn); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.keys-dialog footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
.keys-dialog footer button { flex: none; border-color: var(--border); }
.keys-empty { color: var(--muted); padding: 16px 0; }
@media (max-width: 540px) {
  .keys-backdrop { padding: 12px; }
  .keys-dialog header, .keys-dialog footer { padding: 12px; }
  .keys-search { padding: 12px; }
  .keys-body { padding: 0 12px 12px; }
  .keys-row { grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 10px 0; }
  .keys-dialog footer { flex-wrap: wrap; }
}

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
    private closed: Promise<void> = Promise.resolve();
    private resolveClosed: (() => void) | null = null;
    private capture: Capture | null = null;
    /** A chord waiting for the choice to replace another action's binding. */
    private conflict: (Capture & { chord: Chord; others: ActionDef[] }) | null = null;
    private unsubscribe: (() => void) | null = null;

    private query = "";
    private expanded = new Set<string>();
    private returnFocus: HTMLElement | null = null;

    constructor(private readonly keymap: Keymap) {
        if (keymap.actions[0]) this.expanded.add(keymap.actions[0].group);
    }

    get isOpen(): boolean {
        return this.root !== null;
    }

    open(): Promise<void> {
        if (this.root) return this.closed;
        this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
        if (!document.getElementById("keys-style")) {
            const style = document.createElement("style");
            style.id = "keys-style";
            style.textContent = CSS;
            document.head.append(style);
        }
        this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
        root.querySelector<HTMLElement>("input")?.focus();
        return this.closed;
    }

    close(): void {
        this.cancelCapture();
        window.removeEventListener("keydown", this.keyDown, true);
        window.removeEventListener("mousedown", this.mouseDown, true);
        window.removeEventListener("auxclick", this.stopAux, true);
        this.unsubscribe?.();
        this.root?.remove();
        this.root = null;
        this.resolveClosed?.();
        this.resolveClosed = null;
        this.returnFocus?.focus();
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
            if (e.key === "Tab" && this.root) {
                const controls = [...this.root.querySelectorAll<HTMLElement>("button, input, summary")].filter((el) => el.offsetParent !== null && !el.hasAttribute("disabled"));
                const first = controls[0], last = controls.at(-1);
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
            }
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
        const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
        const focusKey = focused?.dataset.focus;
        const caret = focused instanceof HTMLInputElement ? focused.selectionStart : null;
        const scroll = root.querySelector(".keys-body")?.scrollTop ?? 0;
        const dialog = el("div", { className: "keys-dialog", role: "dialog" });
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-label", translate("Key bindings"));
        const close = el("button", { onclick: () => this.close(), title: translate("Close"), className: "ks-x" });
        close.setAttribute("aria-label", translate("Close"));
        close.dataset.focus = "close";
        close.append(icon(ICON.close, 14));
        dialog.append(el("header", {}, el("h2", { textContent: translate("Key bindings") }), close));

        const search = el("input", { type: "search", value: this.query, placeholder: translate("Search actions or shortcuts") });
        search.setAttribute("aria-label", translate("Search actions or shortcuts"));
        search.dataset.focus = "search";
        search.addEventListener("input", () => { this.query = search.value; this.render(); });
        dialog.append(el("div", { className: "keys-search" }, search));
        const body = el("div", { className: "keys-body" });
        const query = this.query.trim().toLocaleLowerCase();
        const grouped = new Map<string, ActionDef[]>();
        for (const a of this.keymap.actions) {
            const text = [a.label, a.group, a.id, ...this.keymap.bindings(a.id).map(describeChord)].join(" ").toLocaleLowerCase();
            if (query && !text.includes(query)) continue;
            const actions = grouped.get(a.group) ?? [];
            actions.push(a);
            grouped.set(a.group, actions);
        }
        for (const [name, actions] of grouped) {
            const details = el("details", { className: "keys-group", open: !!query || this.expanded.has(name) });
            details.addEventListener("toggle", () => {
                if (this.query || !details.isConnected) return;
                if (details.open) this.expanded.add(name); else this.expanded.delete(name);
            });
            const summary = el("summary", {}, icon(ICON.chevronRight, 12), name, el("span", { className: "count", textContent: String(actions.length) }));
            summary.dataset.focus = `group:${name}`;
            details.append(summary, el("div", {}, ...actions.map((a) => this.row(a))));
            body.append(details);
        }
        if (!grouped.size) body.append(el("p", { className: "keys-empty", textContent: translate("No matching actions") }));
        dialog.append(body);

        const hint = el("span", {
            textContent: this.capture ? translate("Press a key or mouse button. Esc to cancel.") : translate("Click a binding to change it"),
        });
        const all = el("button", { textContent: translate("Reset all"), onclick: () => this.keymap.resetAll() });
        hint.setAttribute("role", "status");
        all.dataset.focus = "reset-all";
        dialog.append(el("footer", {}, hint, all));
        root.replaceChildren(dialog);
        body.scrollTop = scroll;
        const next = root.querySelector<HTMLElement>(".capturing") ?? (focusKey ? [...root.querySelectorAll<HTMLElement>("[data-focus]")].find((el) => el.dataset.focus === focusKey) : null);
        next?.focus({ preventScroll: true });
        if (next instanceof HTMLInputElement && caret !== null) next.setSelectionRange(caret, caret);
    }

    private row(a: ActionDef): HTMLElement {
        const row = el("div", { className: "keys-row" });
        row.dataset.action = a.id;
        row.append(el("span", { className: "name", textContent: a.label }));
        const bindings = el("div", { className: "keys-bindings" });
        row.append(bindings);
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
            chip.setAttribute("aria-label", translate("Change binding for {{action}}: {{key}}", { action: a.label, key: describeChord(b) }));
            const remove = el("button", { className: "mini", textContent: "×", title: translate("Remove"), onclick: () => this.keymap.set(a.id, list.filter((_, j) => j !== i)) });
            remove.setAttribute("aria-label", translate("Remove binding for {{action}}: {{key}}", { action: a.label, key: describeChord(b) }));
            bindings.append(el("span", { className: "keys-binding" }, chip, remove));
        });
        if (!list.length) bindings.append(el("span", { className: "unbound", textContent: translate("Unbound") }));
        const adding = this.capture?.id === a.id && this.capture.index < 0;
        bindings.append(
            el("button", {
                className: "mini" + (adding ? " capturing" : ""),
                textContent: adding ? translate("Press a key…") : "+",
                title: translate("Add binding for {{action}}", { action: a.label }),
                onclick: () => {
                    this.conflict = null;
                    this.capture = { id: a.id, index: -1 };
                    this.render();
                },
            }),
        );
        if (!this.keymap.isDefault(a.id)) bindings.append(el("button", { className: "mini", textContent: translate("Reset"), title: translate("Reset to default"), onclick: () => this.keymap.reset(a.id) }));
        const c = this.conflict;
        if (c && c.id === a.id) {
            const names = c.others.map((o) => o.label).join(", ");
            const warn = el("div", { className: "warn", role: "alert" });
            warn.append(
                translate("{{1}} is already assigned to {{2}}", { 1: describeChord(formatChord(c.chord)), 2: names }),
                el("button", { textContent: translate("Replace"), onclick: () => this.apply(c, c.chord, c.others) }),
                el("button", { textContent: translate("Cancel"), onclick: () => (this.cancelCapture(), this.render()) }),
            );
            row.append(warn);
        }
        row.querySelectorAll<HTMLButtonElement>("button").forEach((b, i) => {
            b.dataset.focus = `${a.id}:${i}`;
            if (b.textContent === "+") b.setAttribute("aria-label", b.title);
        });
        return row;
    }
}
