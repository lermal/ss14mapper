// Linking panel of the multitool, as the game's linking window: the source's ports on the left, the sink's on
// the right. Click a port on one side, then one on the other: links them, or unlinks them when they are linked.
// Existing links are listed below with buttons that remove them.
import { t as translate } from "../i18n";
import type { MapDocument } from "../map/document";
import type { Pack } from "../pack/loader";
import { entityLabel, linkPanel, togglePair, type LinkPanelModel, type PortRow } from "../editor/multitool";

const STYLE = `
.link-panel { box-sizing: border-box; }
.link-panel .lp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.link-panel .lp-title { font-size: 13px; font-weight: 600; }
.link-panel .lp-device { margin-bottom: 8px; color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
.link-panel .lp-body { padding: 8px 14px 12px; }
.link-panel .lp-blocked { color: var(--danger-text); font-size: 12px; margin: 4px 0; }
.link-panel .lp-note { color: var(--muted); font-size: 12px; margin: 6px 0; }
.link-panel .lp-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.link-panel .lp-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; margin-top: 12px; }
.link-panel h4 { margin: 0 0 6px; color: var(--muted); font-size: 12px; font-weight: 600; }
.link-panel button { height: 26px; padding: 0 10px; background: var(--raised); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.link-panel button:hover:not(:disabled) { background: var(--accent-soft); }
.link-panel button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.link-panel .lp-close { border: 0; background: transparent; color: var(--muted); }
.link-panel .lp-links { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.link-panel .lp-links-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.link-panel .lp-links-head h4 { margin: 0; color: var(--text); }
.link-panel .lp-clear { border: 0; background: transparent; color: var(--danger-text); padding: 0 4px; }
.link-panel button:disabled { color: var(--faint); cursor: default; }
.link-panel .lp-port { display: flex; align-items: center; width: 100%; min-height: 30px; height: auto; margin-bottom: 2px; padding: 5px 6px; text-align: left; border-color: transparent; background: transparent; }
.link-panel .lp-port-name { min-width: 0; overflow-wrap: anywhere; }
.link-panel .lp-port[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: #fff; }
.link-panel .lp-port.linked { border-color: var(--link-line); }
.link-panel .lp-port.refused { opacity: 0.45; }
.link-panel .lp-count { color: var(--link-line); font-size: 12px; margin-left: auto; padding-left: 4px; }
.link-panel .lp-pair { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 32px; border-top: 1px solid var(--border); }
.link-panel .lp-pair > span { min-width: 0; overflow-wrap: anywhere; }
.link-panel .lp-pair .lp-x { width: 24px; height: 24px; padding: 0; border: 0; background: transparent; color: var(--muted); }
.link-panel .lp-pair .lp-x:hover { color: var(--text); background: var(--raised); }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

export interface LinkTarget {
    doc: MapDocument;
    pack: Pack;
    source: number;
    sink: number;
}

export class LinkPanel {
    /** An edit was made or refused (for the status line). */
    onEdit: ((message: string) => void) | null = null;
    /** "Swap" was pressed: the sink becomes the source. */
    onSwap: (() => void) | null = null;
    /** "Close" was pressed. */
    onClose: (() => void) | null = null;

    private target: LinkTarget | null = null;
    private unsubscribe: (() => void) | null = null;
    /** The port picked first, waiting for one on the other side. */
    private picked: { side: "source" | "sink"; id: string } | null = null;

    constructor(readonly container: HTMLElement) {
        addStyle();
        container.classList.add("link-panel");
        container.addEventListener("keydown", (e) => e.stopPropagation());
        container.addEventListener("keyup", (e) => e.stopPropagation());
        container.hidden = true;
    }

    /** Shows the ports of two entities (or hides the panel with null). Re-renders on changes to either. */
    show(target: LinkTarget | null): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.target = target;
        this.picked = null;
        this.container.hidden = !target;
        if (!target) return void this.container.replaceChildren();
        this.render();
        this.unsubscribe = target.doc.onChange((change) => {
            if (this.target === target && (change.entities.includes(target.source) || change.entities.includes(target.sink))) this.render();
        });
    }

    private say(message: string): void {
        this.onEdit?.(message);
    }

    private render(): void {
        const { doc, pack, source, sink } = this.target!;
        const root = this.container;
        if (doc.proto(source) === undefined || doc.proto(sink) === undefined) {
            root.replaceChildren(el("div", "lp-body", translate("Entity deleted")));
            return;
        }
        const m = linkPanel(doc, source, sink, pack);
        const head = el("div", "lp-head");
        const close = el("button", "lp-close", "×");
        close.type = "button";
        close.setAttribute("aria-label", translate("Close"));
        close.title = translate("Close");
        close.addEventListener("click", () => this.onClose?.());
        head.append(el("div", "lp-title", translate("Link ports")), close);
        const body = el("div", "lp-body");
        root.replaceChildren(head, body);
        if (m.blocked) body.append(el("div", "lp-blocked", m.blocked));
        const buttons = el("div", "lp-buttons");
        const button = (text: string, title: string, fn: () => void) => {
            const b = el("button", "", text);
            b.title = title;
            b.addEventListener("click", fn);
            buttons.append(b);
            return b;
        };
        button(translate("Link defaults"), translate("Link default ports"), () => this.defaults());
        const clear = button(translate("Clear links"), translate("Remove all links between the two devices"), () => {
            const n = doc.unlinkAll(source, sink);
            this.say(n ? translate("links.removed", { count: n }) : translate("No links to remove"));
        });
        clear.disabled = !m.links.length;
        clear.className = "lp-clear";
        if (m.reversible) button(translate("Swap"), translate("Reverse direction"), () => this.onSwap?.());
        body.append(buttons);

        const cols = el("div", "lp-columns");
        cols.append(this.column(translate("Source"), "source", m.sourcePorts, m), this.column(translate("Sink"), "sink", m.sinkPorts, m));
        body.append(cols);
        body.append(el("div", "lp-note", this.picked ? translate(this.picked.side === "source" ? "Pick a sink port" : "Pick a source port") : translate("Pick a port on each side")));

        const links = el("section", "lp-links");
        const linksHead = el("div", "lp-links-head");
        linksHead.append(el("h4", "", translate("Links ({{1}})", { 1: m.links.length })), clear);
        links.append(linksHead);
        body.append(links);
        if (!m.links.length) links.append(el("div", "lp-note", translate("No links yet.")));
        const name = (rows: PortRow[], id: string) => rows.find((r) => r.id === id)?.name ?? id;
        for (const l of m.links) {
            const row = el("div", "lp-pair");
            const remove = el("button", "lp-x", "×");
            remove.title = translate("Remove link");
            remove.setAttribute("aria-label", translate("Remove link"));
            remove.addEventListener("click", () => {
                doc.unlink(source, sink, l.sourcePort, l.sinkPort);
                this.say(translate("Unlinked {{1}} → {{2}}", { 1: l.sourcePort, 2: l.sinkPort }));
            });
            row.append(el("span", "", `${name(m.sourcePorts, l.sourcePort)} → ${name(m.sinkPorts, l.sinkPort)}`), remove);
            links.append(row);
        }
    }

    private column(title: string, side: "source" | "sink", rows: PortRow[], m: LinkPanelModel): HTMLElement {
        const { doc, pack, source, sink } = this.target!;
        const col = el("div");
        col.append(el("h4", "", title));
        col.append(el("div", "lp-device", entityLabel(doc, side === "source" ? source : sink, pack)));
        if (!rows.length) col.append(el("div", "lp-note", translate("No ports")));
        const other = this.picked && this.picked.side !== side ? this.picked.id : null;
        for (const r of rows) {
            const b = el("button", "lp-port");
            b.append(el("span", "lp-port-name", r.name));
            const mine = (l: { sourcePort: string; sinkPort: string }) => (side === "source" ? l.sourcePort : l.sinkPort) === r.id;
            const count = m.links.filter(mine).length;
            if (count) b.append(el("span", "lp-count", `×${count}`));
            const tip = [r.id !== r.name ? r.id : "", r.description ?? ""].filter(Boolean);
            b.setAttribute("aria-pressed", String(this.picked?.side === side && this.picked.id === r.id));
            if (other !== null) {
                const [sp, kp] = side === "sink" ? [other, r.id] : [r.id, other];
                const linked = m.links.some((l) => l.sourcePort === sp && l.sinkPort === kp);
                const check = doc.canLink(source, sink, sp, kp, pack);
                if (linked) {
                    b.classList.add("linked");
                    tip.push(translate("Linked (click to unlink)"));
                } else if (!check.ok) {
                    b.classList.add("refused");
                    tip.push(translate("Cannot link: {{1}}", { 1: check.reason }));
                }
            }
            b.title = tip.join("\n");
            b.addEventListener("click", () => this.pick(side, r.id));
            col.append(b);
        }
        return col;
    }

    private pick(side: "source" | "sink", id: string): void {
        const { doc, pack, source, sink } = this.target!;
        const p = this.picked;
        if (!p || p.side === side) {
            this.picked = p?.side === side && p.id === id ? null : { side, id };
            return this.render();
        }
        this.picked = null;
        const [sp, kp] = side === "sink" ? [p.id, id] : [id, p.id];
        const r = togglePair(doc, source, sink, sp, kp, pack);
        // an edit re-renders through the change event; a refusal does not
        if ("reason" in r) {
            this.render();
            return this.say(translate("Cannot link {{1}} → {{2}}: {{3}}", { 1: sp, 2: kp, 3: r.reason }));
        }
        this.say(`${r.done === "linked" ? translate("Linked") : translate("Unlinked")} ${sp} → ${kp}`);
    }

    private defaults(): void {
        const { doc, pack, source, sink } = this.target!;
        let n: number;
        const had = doc.links(source).filter((l) => l.sink === sink).length;
        try {
            n = doc.linkDefaults(source, sink, pack);
        } catch (e) {
            return this.say(translate("Cannot link: {{1}}", { 1: e instanceof Error ? e.message : String(e) }));
        }
        this.say(n ? translate("links.defaults", { count: n }) : had ? translate("No default links, existing links removed") : translate("No default links"));
    }
}
