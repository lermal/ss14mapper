// Parallax picker at the top of the map's properties: a button with the current parallax's thumbnail that opens a
// list of the build's parallaxes. On a map it writes the map entity's `Parallax` component; in a file without a
// map entity (a shuttle) it only changes the background the editor shows.
import type { ParallaxData } from "../pack/format";
import type { Pack } from "../pack/loader";
import { h, icon, ICON } from "./icons";

const STYLE = `
.pxp { margin: 2px 0 8px; padding: 8px 6px 10px; border-bottom: 1px solid var(--border); }
.pxp .pxp-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.pxp .pxp-note { color: var(--faint); font-size: 12px; margin-top: 6px; }
.pxp-btn, .pxp-row { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; text-align: left; color: var(--text); }
.pxp-btn { height: 46px; padding: 0 8px 0 4px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--input); }
.pxp-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.pxp-btn:disabled { opacity: 0.5; }
.pxp-btn[aria-expanded="true"] { border-color: var(--focus); }
.pxp-thumb { flex: none; width: 64px; height: 36px; border-radius: 3px; background: var(--map-bg); object-fit: cover; }
.pxp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pxp-tag { flex: none; padding: 0 5px; border: 1px solid var(--border); border-radius: var(--radius-s); color: var(--muted); font-size: 11px; line-height: 16px; }
.pxp-btn svg { flex: none; color: var(--muted); }
.pxp-list { position: fixed; z-index: 1500; max-height: 60vh; overflow-y: auto; padding: 4px; box-sizing: border-box; background: var(--raised); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); font: 13px/1.35 var(--font); }
.pxp-row { height: 44px; padding: 0 8px 0 4px; border: 0; border-radius: var(--radius-s); background: transparent; }
.pxp-row:hover, .pxp-row:focus-visible { background: var(--accent-soft); outline: none; }
.pxp-row[aria-selected="true"] .pxp-name { color: var(--accent-text); font-weight: 600; }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

export interface PickerState {
    pack: Pack;
    data: ParallaxData;
    /** The parallax shown as chosen. */
    current: string;
    /** "map": written to the map entity; "preview": only what the editor shows (files without a map entity). */
    mode: "map" | "preview";
    onPick: (id: string) => void;
}

export class ParallaxPicker {
    readonly element: HTMLElement;
    private readonly title: HTMLElement;
    private readonly note: HTMLElement;
    private readonly btn: HTMLButtonElement;
    private state: PickerState | null = null;
    private list: HTMLElement | null = null;

    constructor() {
        addStyle();
        this.element = h("div", "pxp");
        const head = h("div", "pxp-head");
        this.title = h("span", "", "Parallax");
        head.append(this.title);
        this.btn = h("button", "pxp-btn");
        this.btn.type = "button";
        this.btn.setAttribute("aria-haspopup", "listbox");
        this.btn.setAttribute("aria-expanded", "false");
        this.btn.addEventListener("click", () => (this.list ? this.close() : this.open()));
        this.note = h("div", "pxp-note");
        this.element.append(head, this.btn, this.note);
        this.set(null);
    }

    private row(cls: string, id: string, state: PickerState, el: HTMLElement): void {
        const p = state.data.parallaxes[id];
        const thumb = h("img", "pxp-thumb");
        thumb.alt = "";
        if (p?.thumbnail) thumb.src = state.pack.url(p.thumbnail);
        el.className = cls;
        el.replaceChildren(thumb, h("span", "pxp-name", id));
        if (id === state.data.default) el.append(h("span", "pxp-tag", "Default"));
        else if (!p) el.append(h("span", "pxp-tag", "Not in this build"));
    }

    /** Shows a state (null: nothing to pick, e.g. while the pack's parallax data loads). */
    set(state: PickerState | null): void {
        this.state = state;
        this.close();
        this.element.hidden = !state;
        if (!state) return;
        this.title.textContent = state.mode === "map" ? "Parallax" : "Background preview";
        this.note.textContent = state.mode === "map" ? "" : "View only. Not saved to the file.";
        this.note.hidden = state.mode === "map";
        this.row("pxp-btn", state.current, state, this.btn);
        this.btn.append(icon(ICON.chevronDown, 14));
        this.btn.title = state.mode === "map" ? "Parallax of this map" : "Background shown behind this file";
    }

    private open(): void {
        const state = this.state;
        if (!state) return;
        const list = h("div", "pxp-list");
        list.setAttribute("role", "listbox");
        const ids = Object.keys(state.data.parallaxes);
        // the default first, the rest by name
        ids.sort((a, b) => (a === state.data.default ? -1 : b === state.data.default ? 1 : a.localeCompare(b)));
        for (const id of ids) {
            const b = h("button");
            b.type = "button";
            b.setAttribute("role", "option");
            b.setAttribute("aria-selected", String(id === state.current));
            this.row("pxp-row", id, state, b);
            b.addEventListener("click", () => {
                this.close();
                if (id !== state.current) state.onPick(id);
            });
            list.append(b);
        }
        document.body.append(list);
        const r = this.btn.getBoundingClientRect();
        list.style.width = `${Math.max(r.width, 260)}px`;
        list.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 4))}px`;
        const below = window.innerHeight - r.bottom - 8;
        if (below >= Math.min(list.scrollHeight, 240)) {
            list.style.top = `${r.bottom + 2}px`;
            list.style.maxHeight = `${below}px`;
        } else {
            list.style.bottom = `${window.innerHeight - r.top + 2}px`;
            list.style.maxHeight = `${r.top - 8}px`;
        }
        this.list = list;
        this.btn.setAttribute("aria-expanded", "true");
        list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
        (list.querySelector<HTMLElement>('[aria-selected="true"]') ?? list.querySelector<HTMLElement>("button"))?.focus();
        window.addEventListener("pointerdown", this.away, true);
        window.addEventListener("keydown", this.key, true);
    }

    private readonly away = (e: Event) => {
        if (this.list?.contains(e.target as Node) || this.btn.contains(e.target as Node)) return;
        this.close();
    };

    private readonly key = (e: KeyboardEvent) => {
        if (!this.list) return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.close();
            this.btn.focus();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            const rows = [...this.list.querySelectorAll<HTMLButtonElement>("button")];
            const i = rows.indexOf(document.activeElement as HTMLButtonElement);
            rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
        }
    };

    close(): void {
        if (!this.list) return;
        this.list.remove();
        this.list = null;
        this.btn.setAttribute("aria-expanded", "false");
        window.removeEventListener("pointerdown", this.away, true);
        window.removeEventListener("keydown", this.key, true);
    }
}
