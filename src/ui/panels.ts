import { t } from "../i18n";
import { browserStorage } from "../editor/keymap";
import { button, h, icon, ICON } from "./icons";
import type { MenuItem } from "./menus";

const DEFINITIONS = [["palette", "Palette"], ["properties", "Properties"], ["rail", "Tools"], ["optionsbar", "Tool options"]] as const;
type Panel = (typeof DEFINITIONS)[number][0];
const KEY = "ss14mapper.panels";

/** Layout preferences are separate from the document and from automatic inspector availability. */
export class Panels {
    private readonly storage = browserStorage();
    private readonly collapsed = new Set<Panel>();
    private readonly restore = new Map<Panel, HTMLButtonElement>();
    private readonly collapse = new Map<Panel, HTMLButtonElement>();
    private propertiesAvailable = false;
    private readonly mobile = window.matchMedia("(max-width: 1000px)");
    private active: Panel | null = null;
    private readonly tabs = new Map<Panel | null, HTMLButtonElement>();

    constructor(private readonly elements: Record<Panel, HTMLElement>) {
        try {
            const saved: unknown = JSON.parse(this.storage?.getItem(KEY) ?? "null");
            if (Array.isArray(saved)) for (const [id] of DEFINITIONS) if (saved.includes(id)) this.collapsed.add(id);
        } catch { /* Unavailable storage: keep the default layout. */ }
        for (const id of ["palette", "properties"] as const) {
            const label = t(id === "palette" ? "Palette" : "Properties");
            const close = button("panel-collapse", icon(ICON.chevronRight, 12), t("Collapse {{panel}}", { panel: label }), () => this.toggle(id));
            close.setAttribute("aria-label", close.title);
            close.setAttribute("aria-controls", id);
            close.classList.toggle("points-left", id === "palette");
            this.collapse.set(id, close);
            if (id === "palette") elements.palette.querySelector(".pal-tabs")!.append(close);
            else {
                const head = h("div", "panel-heading");
                head.append(h("span", "", label), close);
                elements.properties.prepend(head);
            }
            const open = button("panel-restore", label, t("Expand {{panel}}", { panel: label }), () => this.toggle(id));
            open.setAttribute("aria-label", open.title);
            open.setAttribute("aria-controls", id);
            open.setAttribute("aria-expanded", "false");
            this.restore.set(id, open);
            elements[id].after(open);
        }
        const app = elements.palette.closest<HTMLElement>(".app")!;
        const workspace = elements.palette.parentElement!;
        const optionsHome = document.createComment("options bar desktop position");
        elements.optionsbar.before(optionsHome);
        const nav = h("nav", "mobile-panels");
        nav.setAttribute("aria-label", t("Editor panels"));
        for (const [id, label] of [[null, "Map"], ["rail", "Tools"], ["palette", "Palette"], ["properties", "Properties"], ["optionsbar", "Options"]] as const) {
            const tab = button("", t(label), "", () => this.openMobile(this.active === id ? null : id));
            tab.setAttribute("aria-controls", id ?? "view");
            tab.setAttribute("aria-label", t(label));
            if (id === "rail") tab.append(h("span", "mobile-current-tool", t("Select")));
            this.tabs.set(id, tab);
            nav.append(tab);
        }
        app.querySelector("#statusbar")!.before(nav);
        const layout = () => {
            if (this.mobile.matches) workspace.append(elements.optionsbar);
            else optionsHome.after(elements.optionsbar);
            this.render();
        };
        this.mobile.addEventListener("change", layout);
        const viewport = window.visualViewport;
        const resize = () => {
            if (viewport?.scale === 1) document.documentElement.style.setProperty("--visual-height", `${viewport.height}px`);
        };
        viewport?.addEventListener("resize", resize);
        resize();
        elements.rail.addEventListener("click", e => {
            if ((e.target as Element).closest(".rl-tool")) this.openMobile(null);
        });
        // Choosing a material gives the canvas back to the finger immediately.
        elements.palette.addEventListener("palette-choice", () => this.openMobile(null));
        app.addEventListener("show-mobile-properties", () => this.openMobile("properties"));
        layout();
    }

    private openMobile(id: Panel | null): void {
        if (!this.mobile.matches) return;
        this.active = id;
        this.render();
    }

    setPropertiesAvailable(available: boolean): void {
        this.propertiesAvailable = available;
        this.render();
    }

    items(): MenuItem[] {
        if (this.mobile.matches) return DEFINITIONS.map(([id, label]) => ({ label: t(label), checked: this.active === id, disabled: id === "properties" && !this.propertiesAvailable, run: () => this.toggle(id) }));
        return [
            ...DEFINITIONS.map(([id, label]) => ({ label: t(label), checked: !this.collapsed.has(id), run: () => this.toggle(id) })),
            "-",
            { label: t("Show all panels"), run: () => { this.collapsed.clear(); this.save(); this.render(); } },
        ];
    }

    private toggle(id: Panel): void {
        if (this.mobile.matches) return this.openMobile(this.active === id ? null : id);
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        this.save();
        this.render();
        // Keep keyboard focus on the matching, now visible side-panel control.
        const target = this.collapsed.has(id) ? this.restore.get(id) : this.collapse.get(id);
        target?.focus({ preventScroll: true });
    }

    private save(): void {
        try { this.storage?.setItem(KEY, JSON.stringify([...this.collapsed])); } catch { /* Session-only preference. */ }
    }

    private render(): void {
        if (this.mobile.matches && this.active === "properties" && !this.propertiesAvailable) this.active = null;
        const app = this.elements.palette.closest<HTMLElement>(".app")!;
        app.dataset.mobilePanel = this.active ?? "map";
        for (const [id, tab] of this.tabs) {
            tab.setAttribute("aria-pressed", String(this.active === id));
            tab.disabled = id === "properties" && !this.propertiesAvailable;
        }
        for (const [id] of DEFINITIONS) {
            const available = id !== "properties" || this.propertiesAvailable;
            const collapsed = this.mobile.matches ? this.active !== id : this.collapsed.has(id);
            this.elements[id].hidden = collapsed || !available;
            const restore = this.restore.get(id);
            if (restore) restore.hidden = this.mobile.matches || !collapsed || !available;
            this.collapse.get(id)?.setAttribute("aria-expanded", String(!collapsed));
        }
    }
}
