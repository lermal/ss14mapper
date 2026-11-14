// Context menu listing what lies under the cursor (entities, decals, the tile), topmost first. Hovering a row
// reports the item so the map can highlight it; a click chooses it. Esc or a click outside closes it.
import { describe, type StackItem } from "../editor/stack";
import type { Pack } from "../pack/loader";
import { paintFrame } from "./icons";

const ICON = 32;

const STYLE = `
.pick-menu { position: fixed; z-index: 1500; min-width: 240px; max-width: 360px; max-height: 60vh; overflow-y: auto; padding: 4px; background: var(--raised); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); font: 13px/1.35 var(--font); }
.pick-menu .pm-row { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 8px; border-radius: var(--radius-s); cursor: pointer; white-space: nowrap; }
.pick-menu .pm-row:hover, .pick-menu .pm-row.cursor { background: var(--accent-soft); }
.pick-menu .pm-icon { flex: none; width: ${ICON}px; height: ${ICON}px; image-rendering: pixelated; }
.pick-menu .pm-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pick-menu .pm-name { overflow: hidden; text-overflow: ellipsis; }
.pick-menu .pm-id { font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; }
.pick-menu .pm-tag { flex: none; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border: 1px solid var(--border-strong); border-radius: var(--radius-s); padding: 0 4px; }
.pick-menu .pm-tag.decal { color: var(--link-line); }
.pick-menu .pm-tag.tile { color: var(--selection); }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

export class PickMenu {
    /** The item under the pointer or keyboard cursor changed (null: none). */
    onHover: ((item: StackItem | null) => void) | null = null;
    /** A row was chosen (the click's modifiers say how to combine it). */
    onChoose: ((item: StackItem, e: MouseEvent | KeyboardEvent) => void) | null = null;
    /** The menu closed, chosen or not. */
    onClose: (() => void) | null = null;

    private root: HTMLElement | null = null;
    private rows: HTMLElement[] = [];
    private items: StackItem[] = [];
    private cursor = -1;
    private readonly away = (e: Event) => {
        if (!this.root?.contains(e.target as Node)) this.close();
    };
    private readonly lost = () => this.close();
    private readonly key = (e: KeyboardEvent) => {
        if (!["Escape", "ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation(); // Esc must not also clear the selection
        if (e.key === "Escape") return this.close();
        if (e.key === "Enter") {
            const item = this.items[this.cursor];
            if (item) this.choose(item, e);
            return;
        }
        const n = this.items.length;
        this.move((this.cursor + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    };

    get isOpen(): boolean {
        return this.root !== null;
    }

    /** Opens the menu with its top left corner at a viewport point (kept inside the window). */
    open(x: number, y: number, items: readonly StackItem[], pack: Pack): void {
        this.close();
        if (!items.length) return;
        addStyle();
        this.items = [...items];
        const root = document.createElement("div");
        root.className = "pick-menu";
        root.addEventListener("contextmenu", (e) => e.preventDefault());
        this.items.forEach((item, i) => {
            const info = describe(item, pack);
            const row = document.createElement("div");
            row.className = "pm-row";
            const icon = document.createElement("canvas");
            icon.className = "pm-icon";
            icon.width = icon.height = ICON;
            const text = document.createElement("div");
            text.className = "pm-text";
            const name = document.createElement("span");
            name.className = "pm-name";
            name.textContent = info.name;
            const id = document.createElement("span");
            id.className = "pm-id";
            id.textContent = info.id;
            text.append(name, id);
            const tag = document.createElement("span");
            tag.className = `pm-tag ${info.tag}`;
            tag.textContent = info.tag;
            row.append(icon, text, tag);
            row.addEventListener("pointerenter", () => this.move(i));
            row.addEventListener("click", (e) => this.choose(item, e));
            root.append(row);
            this.rows.push(row);
            if (info.icon) paintFrame(icon, pack, info.icon);
        });
        document.body.append(root);
        this.root = root;
        const r = root.getBoundingClientRect();
        root.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width))}px`;
        root.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height))}px`;
        window.addEventListener("pointerdown", this.away, true);
        window.addEventListener("wheel", this.away, true);
        window.addEventListener("keydown", this.key, true);
        window.addEventListener("blur", this.lost);
    }

    close(): void {
        const root = this.root;
        if (!root) return;
        this.root = null;
        root.remove();
        this.rows = [];
        this.items = [];
        this.cursor = -1;
        window.removeEventListener("pointerdown", this.away, true);
        window.removeEventListener("wheel", this.away, true);
        window.removeEventListener("keydown", this.key, true);
        window.removeEventListener("blur", this.lost);
        this.onHover?.(null);
        this.onClose?.();
    }

    private move(i: number): void {
        if (i === this.cursor) return;
        this.rows[this.cursor]?.classList.remove("cursor");
        this.cursor = i;
        this.rows[i]?.classList.add("cursor");
        this.rows[i]?.scrollIntoView({ block: "nearest" });
        this.onHover?.(this.items[i] ?? null);
    }

    private choose(item: StackItem, e: MouseEvent | KeyboardEvent): void {
        this.close();
        this.onChoose?.(item, e);
    }
}
