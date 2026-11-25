// Drop-down menus: the menu bar of the top bar (File, Edit, View, Help) and pop-up menus (the tool rail's
// flyouts). Items are built when a menu opens, so their state (disabled, checked) is current.
import { h, icon, ICON } from "./icons";
import { t } from "../i18n";

export type MenuItem =
    | {
          label: string;
          /** Shortcut shown on the right. */
          keys?: string;
          run?: () => void;
          disabled?: boolean;
          /** A check mark (true), an empty slot (false) or none (undefined). */
          checked?: boolean;
          /** An icon path in front of the label. */
          icon?: string;
          /** A submenu, opened on hover. */
          sub?: () => MenuItem[];
          /** Grey note under the label. */
          note?: string;
      }
    | "-";

const STYLE = `
.menu { position: fixed; z-index: 1500; min-width: 220px; max-width: 360px; padding: 4px; background: var(--raised); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); font: 13px/1.35 var(--font); }
.menu hr { border: 0; border-top: 1px solid var(--border); margin: 4px 2px; }
.menu .mi { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 28px; padding: 0 10px 0 6px; box-sizing: border-box; border: 0; border-radius: var(--radius-s); background: transparent; color: inherit; text-align: left; white-space: nowrap; }
.menu .mi:hover:not(:disabled), .menu .mi.open, .menu .mi:focus-visible { background: var(--accent-soft); outline: none; }
.menu .mi:disabled { color: var(--faint); cursor: default; }
.menu .mi .mi-check { width: 16px; flex: none; display: grid; place-items: center; color: var(--accent-text); }
.menu .mi .mi-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: flex; flex-direction: column; }
.menu .mi .mi-note { color: var(--muted); font-size: 11px; }
.menu .mi .mi-keys { color: var(--muted); font-size: 12px; margin-left: 18px; }
.menu .mi .mi-arrow { color: var(--muted); display: grid; }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

/** An open pop-up menu with its submenus; closes on Esc, a click outside or a choice. */
class Popup {
    private readonly roots: HTMLElement[] = [];
    private subTimer = 0;
    private readonly away = (e: Event) => {
        if (this.roots.some((r) => r.contains(e.target as Node)) || this.keep?.(e.target as Node)) return;
        this.close();
    };
    private readonly key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.close();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            const menu = this.roots.at(-1)!;
            const items = [...menu.querySelectorAll<HTMLButtonElement>(":scope > .mi:not(:disabled)")];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
    };
    onClose: (() => void) | null = null;

    constructor(items: MenuItem[], x: number, y: number, private readonly keep?: (t: Node) => boolean, private readonly alignRight = false) {
        addStyle();
        this.roots.push(this.build(items, x, y));
        window.addEventListener("pointerdown", this.away, true);
        window.addEventListener("keydown", this.key, true);
        window.addEventListener("blur", this.closeSoon);
    }

    private readonly closeSoon = () => this.close();

    private build(items: MenuItem[], x: number, y: number, level = 0): HTMLElement {
        const menu = h("div", "menu");
        menu.setAttribute("role", "menu");
        const compact = window.matchMedia("(max-width: 1000px)").matches;
        if (compact && level) {
            const back = h("button", "mi", t("Back"));
            back.type = "button";
            back.setAttribute("role", "menuitem");
            back.addEventListener("click", () => {
                this.closeFrom(level);
                const parent = this.roots[level - 1];
                if (parent) { parent.hidden = false; parent.querySelector<HTMLElement>(".open")?.focus(); }
            });
            menu.append(back, h("hr"));
        }
        menu.addEventListener("contextmenu", (e) => e.preventDefault());
        for (const it of items) {
            if (it === "-") {
                menu.append(h("hr"));
                continue;
            }
            const b = h("button", "mi");
            b.type = "button";
            b.setAttribute("role", it.checked === undefined ? "menuitem" : "menuitemcheckbox");
            if (it.checked !== undefined) b.setAttribute("aria-checked", String(it.checked));
            const check = h("span", "mi-check");
            if (it.checked) check.append(icon(ICON.check, 14));
            else if (it.icon) check.append(icon(it.icon, 14));
            const label = h("span", "mi-label", it.label);
            if (it.note) label.append(h("span", "mi-note", it.note));
            b.append(check, label);
            if (it.keys) b.append(h("span", "mi-keys", it.keys));
            if (it.sub) {
                const arrow = h("span", "mi-arrow");
                arrow.append(icon(ICON.chevronRight, 14));
                b.append(arrow);
            }
            b.disabled = !!it.disabled;
            const openSub = () => {
                this.closeFrom(level + 1);
                menu.querySelectorAll(".mi.open").forEach((o) => o.classList.remove("open"));
                if (!it.sub || it.disabled) return;
                b.classList.add("open");
                const r = b.getBoundingClientRect();
                this.roots.push(this.build(it.sub(), r.right + 2, r.top - 5, level + 1));
                if (compact) menu.hidden = true;
            };
            b.addEventListener("pointerenter", (e) => {
                if (compact || e.pointerType === "touch") return;
                clearTimeout(this.subTimer);
                this.subTimer = window.setTimeout(openSub, it.sub ? 80 : 160);
            });
            b.addEventListener("click", () => {
                if (it.sub) return openSub();
                this.close();
                it.run?.();
            });
            menu.append(b);
        }
        document.body.append(menu);
        const r = menu.getBoundingClientRect();
        // a menu under a control at the right edge ends where the control ends
        if (!level && this.alignRight) x -= r.width;
        const left = x + r.width > window.innerWidth ? (level ? x - r.width - 4 - (this.roots[level - 1]?.offsetWidth ?? 0) : window.innerWidth - r.width - 4) : x;
        menu.style.left = `${Math.max(4, left)}px`;
        menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
        return menu;
    }

    private closeFrom(level: number): void {
        for (const r of this.roots.splice(level)) r.remove();
    }

    close(): void {
        if (!this.roots.length) return;
        clearTimeout(this.subTimer);
        this.closeFrom(0);
        window.removeEventListener("pointerdown", this.away, true);
        window.removeEventListener("keydown", this.key, true);
        window.removeEventListener("blur", this.closeSoon);
        this.onClose?.();
    }
}

let current: Popup | null = null;

/** Opens a pop-up menu at a viewport point (one at a time); `alignRight` puts its right edge at `x`. */
export function popupMenu(items: MenuItem[], x: number, y: number, keep?: (t: Node) => boolean, alignRight = false): Popup {
    current?.close();
    const p = (current = new Popup(items, x, y, keep, alignRight));
    p.onClose = () => {
        if (current === p) current = null;
    };
    return p;
}

export interface MenuDef {
    label: string;
    items: () => MenuItem[];
}

/** Menu buttons in a row: a click opens one; while one is open, hovering another switches to it. */
export class MenuBar {
    private open: { index: number; popup: Popup } | null = null;
    private readonly buttons: HTMLButtonElement[] = [];

    constructor(container: HTMLElement, private readonly menus: MenuDef[]) {
        menus.forEach((m, i) => {
            const b = h("button", "tb-menu", m.label);
            b.type = "button";
            b.setAttribute("aria-haspopup", "menu");
            b.addEventListener("pointerdown", (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                if (this.open?.index === i) this.close();
                else this.show(i);
            });
            b.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                    e.preventDefault();
                    e.stopPropagation();
                    this.show(i);
                }
            });
            b.addEventListener("pointerenter", () => {
                if (this.open && this.open.index !== i) this.show(i);
            });
            this.buttons.push(b);
            container.append(b);
        });
    }

    show(i: number): void {
        const b = this.buttons[i]!;
        const r = b.getBoundingClientRect();
        this.buttons.forEach((o, j) => o.setAttribute("aria-expanded", String(i === j)));
        const popup = popupMenu(this.menus[i]!.items(), r.left, r.bottom + 2, (t) => this.buttons.includes(t as HTMLButtonElement));
        this.open = { index: i, popup };
        const before = popup.onClose;
        popup.onClose = () => {
            before?.();
            if (this.open?.popup !== popup) return;
            this.open = null;
            b.setAttribute("aria-expanded", "false");
            b.blur();
        };
    }

    close(): void {
        this.open?.popup.close();
    }
}
