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
        this.render();
    }

    setPropertiesAvailable(available: boolean): void {
        this.propertiesAvailable = available;
        this.render();
    }

    items(): MenuItem[] {
        return [
            ...DEFINITIONS.map(([id, label]) => ({ label: t(label), checked: !this.collapsed.has(id), run: () => this.toggle(id) })),
            "-",
            { label: t("Show all panels"), run: () => { this.collapsed.clear(); this.save(); this.render(); } },
        ];
    }

    private toggle(id: Panel): void {
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
        for (const [id] of DEFINITIONS) {
            const available = id !== "properties" || this.propertiesAvailable;
            const collapsed = this.collapsed.has(id);
            this.elements[id].hidden = collapsed || !available;
            const restore = this.restore.get(id);
            if (restore) restore.hidden = !collapsed || !available;
            this.collapse.get(id)?.setAttribute("aria-expanded", String(!collapsed));
        }
    }
}
