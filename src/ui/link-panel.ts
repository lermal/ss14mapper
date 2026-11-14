// Linking panel of the multitool, as the game's linking window: the source's ports on the left, the sink's on
// the right. Click a port on one side, then one on the other: links them, or unlinks them when they are linked.
// Existing links are listed below with buttons that remove them.
import type { MapDocument } from "../map/document";
import type { Pack } from "../pack/loader";
import { entityLabel, linkPanel, togglePair, type LinkPanelModel, type PortRow } from "../editor/multitool";

const STYLE = `
.link-panel { box-sizing: border-box; }
.link-panel .lp-head { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.link-panel .lp-title { font-size: 15px; font-weight: 600; }
.link-panel .lp-meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.link-panel .lp-body { padding: 8px 14px 12px; }
.link-panel .lp-blocked { color: var(--danger-text); font-size: 12px; margin: 4px 0; }
.link-panel .lp-note { color: var(--faint); font-size: 12px; margin: 6px 0; }
.link-panel .lp-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
.link-panel .lp-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.link-panel h4 { margin: 10px 0 6px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.link-panel button { height: 26px; padding: 0 10px; background: var(--raised); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
.link-panel button:hover:not(:disabled) { filter: brightness(1.18); }
.link-panel button:disabled { color: var(--faint); cursor: default; }
.link-panel .lp-port { display: flex; align-items: center; width: 100%; margin-bottom: 4px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-panel .lp-port[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: #fff; }
.link-panel .lp-port.linked { border-color: var(--link-line); }
.link-panel .lp-port.refused { opacity: 0.45; }
.link-panel .lp-count { color: var(--link-line); font-size: 12px; margin-left: auto; padding-left: 4px; }
.link-panel .lp-pair { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 28px; }
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
            root.replaceChildren(el("div", "lp-body", "Entity deleted"));
            return;
        }
        const m = linkPanel(doc, source, sink, pack);
        const head = el("div", "lp-head");
        head.append(el("div", "lp-title", "Link ports"), el("div", "lp-meta", `${entityLabel(doc, source, pack)} → ${entityLabel(doc, sink, pack)}`));
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
        button("Link defaults", "Link default ports", () => this.defaults());
        button("Clear", "Remove all links between the two devices", () => {
            const n = doc.unlinkAll(source, sink);
            this.say(n ? `Removed ${n} ${n === 1 ? "link" : "links"}` : "No links to remove");
        }).disabled = !m.links.length;
        if (m.reversible) button("Swap", "Reverse direction", () => this.onSwap?.());
        button("Close", "Close", () => this.onClose?.());
        body.append(buttons);

        const cols = el("div", "lp-columns");
        cols.append(this.column("Source", "source", m.sourcePorts, m), this.column("Sink", "sink", m.sinkPorts, m));
        body.append(cols);
        body.append(el("div", "lp-note", this.picked ? `Pick a ${this.picked.side === "source" ? "sink" : "source"} port` : "Pick a port on each side"));

        body.append(el("h4", "", `Links (${m.links.length})`));
        if (!m.links.length) body.append(el("div", "lp-note", "None"));
        const name = (rows: PortRow[], id: string) => rows.find((r) => r.id === id)?.name ?? id;
        for (const l of m.links) {
            const row = el("div", "lp-pair");
            const remove = el("button", "lp-x", "×");
            remove.title = "Remove link";
            remove.setAttribute("aria-label", "Remove link");
            remove.addEventListener("click", () => {
                doc.unlink(source, sink, l.sourcePort, l.sinkPort);
                this.say(`Unlinked ${l.sourcePort} → ${l.sinkPort}`);
            });
            row.append(el("span", "", `${name(m.sourcePorts, l.sourcePort)} → ${name(m.sinkPorts, l.sinkPort)}`), remove);
            body.append(row);
        }
    }

    private column(title: string, side: "source" | "sink", rows: PortRow[], m: LinkPanelModel): HTMLElement {
        const { doc, pack, source, sink } = this.target!;
        const col = el("div");
        col.append(el("h4", "", title));
        if (!rows.length) col.append(el("div", "lp-note", "No ports"));
        const other = this.picked && this.picked.side !== side ? this.picked.id : null;
        for (const r of rows) {
            const b = el("button", "lp-port", r.name);
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
                    tip.push("Linked (click to unlink)");
                } else if (!check.ok) {
                    b.classList.add("refused");
                    tip.push(`Cannot link: ${check.reason}`);
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
            return this.say(`Cannot link ${sp} → ${kp}: ${r.reason}`);
        }
        this.say(`${r.done === "linked" ? "Linked" : "Unlinked"} ${sp} → ${kp}`);
    }

    private defaults(): void {
        const { doc, pack, source, sink } = this.target!;
        let n: number;
        try {
            n = doc.linkDefaults(source, sink, pack);
        } catch (e) {
            return this.say(`Cannot link: ${e instanceof Error ? e.message : String(e)}`);
        }
        this.say(n ? `Linked ${n} default ${n === 1 ? "pair" : "pairs"}` : "No default links");
    }
}
