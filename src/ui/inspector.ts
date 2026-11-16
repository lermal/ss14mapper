// Component inspector, like the game's View Variables: the entity's components (prototype and map), and for an
// opened component its data fields with types and values. Edits write the map's override of the component with
// only the fields that differ from the prototype. Logic without DOM is in inspector-model.ts and inspector-fields.ts.
import { t as translate } from "../i18n";
import type { MapDocument } from "../map/document";
import type { ComponentSchemas, PrototypeData } from "../pack/format";
import type { Pack } from "../pack/loader";
import type { Scene } from "../render/scene";
import { entityLabel, isConfigurator, relations } from "../editor/multitool";
import { splitColor, joinColor } from "./color";
import { ContentsPanel } from "./contents-panel";
import { ICON, icon } from "./icons";
import { FIXED_COMPONENTS, componentNames, filterNames } from "./inspector-model";
import {
    COMPLEX,
    type ComponentView,
    type FieldView,
    componentViews,
    editorText,
    effective,
    fieldViews,
    formatValue,
    toYaml,
    writeField,
} from "./inspector-fields";

const STYLE = `
.inspector { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; background: var(--panel); color: var(--text); font: 13px/1.35 var(--font); }
.inspector .ins-empty { padding: 12px 14px; color: var(--faint); }
.inspector .ins-head { flex: none; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.inspector .ins-name { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.inspector .ins-meta { color: var(--muted); font-size: 12px; word-break: break-all; }
.inspector .ins-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 6px 12px; }
.inspector button { border: 0; background: transparent; }
.inspector button:disabled { opacity: 0.4; cursor: default; }
.inspector input, .inspector select { box-sizing: border-box; min-width: 0; height: 24px; padding: 0 6px; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-s); outline: none; font-size: 12px; }
.inspector input:focus, .inspector select:focus, .inspector textarea:focus { border-color: var(--focus); }
.inspector input.bad { border-color: var(--danger-border); background: var(--danger-bg); }
.inspector textarea { width: 100%; box-sizing: border-box; min-height: 3.2em; resize: vertical; padding: 5px 7px; background: var(--input); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-s); font: 12px/1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; outline: none; }
.inspector .ins-mono { font-family: var(--mono); }
.inspector .ins-note { color: var(--faint); font-size: 12px; padding: 4px 6px; }
.inspector .ins-error { margin: 4px 0; padding: 5px 7px; color: var(--danger-text); background: var(--danger-bg); border: 1px solid var(--danger-border); border-radius: var(--radius-s); font-size: 12px; white-space: pre-wrap; }
.inspector .ins-error:empty { display: none; }
.inspector .ins-btn { height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--raised); font-size: 12px; }
.inspector .ins-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.inspector .ins-btn.primary { border-color: transparent; background: var(--accent); color: #fff; }
.inspector .ins-btn.danger { color: var(--danger-text); }
.inspector .ins-btn.danger:hover:not(:disabled) { background: var(--danger-bg); border-color: var(--danger-border); }
.inspector .ins-btn.on { border-color: var(--accent); color: var(--accent-text); }

/* sections (Links) */
.inspector details { margin-bottom: 6px; }
.inspector summary { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 6px; font-weight: 600; cursor: pointer; list-style: none; border-radius: var(--radius-s); }
.inspector summary::-webkit-details-marker { display: none; }
.inspector summary:hover { background: var(--raised); }
.inspector summary::before { content: ""; flex: none; width: 12px; height: 12px; background: var(--muted); clip-path: polygon(30% 15%, 75% 50%, 30% 85%, 38% 92%, 90% 50%, 38% 8%); transition: transform 0.1s; }
.inspector details[open] > summary::before { transform: rotate(90deg); }
.inspector .ins-sub { color: var(--muted); font-weight: 400; }
.inspector .ins-section { padding: 0 6px 6px 24px; }
.inspector .ins-link { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.inspector .ins-link span { flex: 1; word-break: break-all; }
.inspector .ins-link .ins-x { flex: none; width: 24px; height: 24px; border-radius: var(--radius-s); color: var(--muted); font-size: 16px; line-height: 1; }
.inspector .ins-link .ins-x:hover { background: var(--danger-bg); color: var(--danger-text); }

/* component list */
.inspector .ins-tools { display: flex; gap: 6px; padding: 2px 0 6px; }
.inspector .ins-tools input { flex: 1; height: 26px; }
.inspector .ins-tools .ins-btn { height: 26px; }
.inspector .ins-addform { padding: 0 0 8px; }
.inspector .ins-addform input { width: 100%; height: 26px; }
.inspector .ins-hits { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.inspector .ins-hits button { height: 22px; padding: 0 7px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--raised); font-family: var(--mono); font-size: 12px; }
.inspector .ins-hits button:hover { border-color: var(--accent); }
.inspector .ins-heading { display: flex; align-items: baseline; gap: 6px; padding: 6px 6px 4px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.inspector .ins-comp + .ins-comp { border-top: 1px solid var(--border); }
.inspector .ins-row { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; padding: 0 6px; text-align: left; border-radius: var(--radius-s); }
.inspector .ins-row:hover { background: var(--raised); }
.inspector .ins-row svg { flex: none; color: var(--muted); transition: transform 0.1s; }
.inspector .ins-comp.open > .ins-row svg { transform: rotate(90deg); }
.inspector .ins-comp.open > .ins-row { font-weight: 600; }
.inspector .ins-row .ins-cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector .ins-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.inspector .ins-tag { flex: none; padding: 0 5px; border: 1px solid var(--border); border-radius: var(--radius-s); color: var(--muted); font-size: 11px; font-weight: 400; line-height: 16px; }
.inspector .ins-fields { padding: 2px 0 8px 6px; }
.inspector .ins-ctools { display: flex; gap: 6px; padding: 2px 0 6px; }
.inspector .ins-ctools .ins-btn.danger { margin-left: auto; }

/* fields */
.inspector .ins-field { display: grid; grid-template-columns: minmax(0, 40%) minmax(0, 1fr) 22px; align-items: center; column-gap: 6px; min-height: 30px; padding: 1px 0 1px 6px; border-left: 2px solid transparent; }
.inspector .ins-field.over { border-left-color: var(--accent); }
.inspector .ins-label { min-width: 0; line-height: 1.2; }
.inspector .ins-fname { display: block; overflow-wrap: anywhere; font-size: 12px; }
.inspector .ins-field.over .ins-fname { color: var(--accent-text); font-weight: 600; }
.inspector .ins-ftype { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font: 10px/1.2 var(--mono); }
.inspector .ins-value { display: flex; align-items: center; gap: 4px; min-width: 0; }
.inspector .ins-value > input:not([type="checkbox"]):not([type="color"]), .inspector .ins-value > select { flex: 1; width: 100%; }
.inspector .ins-value.inherited input:not(:focus), .inspector .ins-value.inherited select:not(:focus) { color: var(--text-2); }
.inspector .ins-value.unset input:not(:focus) { color: var(--faint); }
.inspector .ins-value .ins-axis { flex: none; color: var(--faint); font-size: 11px; }
.inspector .ins-value input[type="checkbox"] { width: 15px; height: 15px; margin: 0; }
.inspector .ins-value input[type="color"] { flex: none; width: 26px; height: 24px; padding: 1px; }
.inspector .ins-value input.ins-alpha { flex: none; width: 36px; padding: 0 4px; }
.inspector .ins-value input.ins-hex { font: 11px var(--mono); padding: 0 4px; }
.inspector .ins-value .ins-unit { flex: none; color: var(--faint); font-size: 11px; }
.inspector .ins-preview { flex: 1; min-width: 0; height: 24px; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; border: 1px solid var(--border) !important; border-radius: var(--radius-s); background: var(--input) !important; color: var(--text-2); font: 11px/22px var(--mono); }
.inspector .ins-preview:hover { border-color: var(--border-strong) !important; }
.inspector .ins-reset { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--radius-s); color: var(--muted); }
.inspector .ins-reset:hover { background: var(--raised); color: var(--text); }
.inspector .ins-yaml { grid-column: 1 / -1; padding: 4px 0 4px; }
.inspector .ins-yaml .ins-buttons, .inspector .ins-whole .ins-buttons { display: flex; gap: 6px; margin-top: 4px; }
.inspector .ins-whole { padding: 0 0 6px; }
.inspector .ins-whole pre { margin: 4px 0 0; color: var(--text-2); font: 11px/1.4 var(--mono); white-space: pre-wrap; }
`;

/** Sections whose open state differs from their default; remembered across entities and sessions. */
const COLLAPSED_KEY = "ss14mapper.inspector.collapsed";
/** Components whose fields are shown; remembered across entities and sessions. */
const OPEN_KEY = "ss14mapper.inspector.open";

function storedSet(key: string): Set<string> {
    try {
        const v = JSON.parse(globalThis.localStorage?.getItem(key) ?? "[]") as unknown;
        return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    } catch {
        return new Set<string>();
    }
}
function storeSet(key: string, set: Set<string>): void {
    try {
        globalThis.localStorage?.setItem(key, JSON.stringify([...set]));
    } catch {
        /* not remembered */
    }
}
const collapsed = storedSet(COLLAPSED_KEY);
const opened = storedSet(OPEN_KEY);

/** A `<details>` whose open state is remembered under `key`. */
function section(key: string, title: HTMLElement | string, openByDefault = true): { root: HTMLDetailsElement; body: HTMLElement; summary: HTMLElement } {
    const root = document.createElement("details");
    root.open = collapsed.has(key) ? false : openByDefault;
    root.addEventListener("toggle", () => {
        if (root.open === openByDefault) collapsed.delete(key);
        else collapsed.add(key);
        storeSet(COLLAPSED_KEY, collapsed);
    });
    const summary = document.createElement("summary");
    if (typeof title === "string") summary.textContent = title;
    else summary.append(title);
    const body = document.createElement("div");
    body.className = "ins-section";
    root.append(summary, body);
    return { root, body, summary };
}

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

/** Makes `parent`'s children exactly `nodes`, moving only what is out of place (focus and pending clicks survive). */
function syncChildren(parent: HTMLElement, nodes: readonly Node[]): void {
    nodes.forEach((n, i) => {
        if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] ?? null);
    });
    while (parent.childNodes.length > nodes.length) parent.lastChild!.remove();
}

function btn(cls: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = el("button", cls, text);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
}

interface Target {
    doc: MapDocument;
    pack: Pack;
    uid: number;
    /** Shown above the components (the map's parallax picker); it keeps itself up to date. */
    top?: HTMLElement | null;
    /** The map's scene, for taking stored entities out onto free tiles. */
    scene?: Scene | null;
}

/** What the panel needs from the pack beyond the prototype index, loaded on demand (null in older packs). */
interface Extra {
    schemas: ComponentSchemas | null;
    data: PrototypeData | null;
}

/** DOM of one component in the list, kept across renders so clicks and focus survive edits elsewhere. */
interface CompEl {
    root: HTMLElement;
    row: HTMLButtonElement;
    sig: string;
    fields: HTMLElement | null;
    fieldsSig: string;
    rows: Map<string, { el: HTMLElement; sig: string }>;
}

export class Inspector {
    /** Fired after an edit was applied, e.g. for status messages. */
    onEdit: ((message: string) => void) | null = null;

    private target: Target | null = null;
    private unsubscribe: (() => void) | null = null;
    private names: string[] = [];
    private namesPack: Pack | null = null;
    private extra = new WeakMap<Pack, Extra>();
    private loading = new WeakMap<Pack, Promise<void>>();
    private filter = "";
    private comps = new Map<string, CompEl>();
    /** Open YAML editors: "Type" (whole component) or "Type.field" → draft text. */
    private drafts = new Map<string, string>();
    private errors = new Map<string, string>();
    private head: HTMLElement | null = null;
    private list: HTMLElement | null = null;
    private links: HTMLElement | null = null;
    private datalist: HTMLDataListElement | null = null;
    private heading: HTMLElement | null = null;
    /** The Contents section (containers and what they hold). */
    private readonly contents = new ContentsPanel();

    /** Builds the panel inside `container` (it owns the container's contents and its own styles). */
    constructor(readonly container: HTMLElement) {
        addStyle();
        container.classList.add("inspector");
        // typing in the panel is not for the editor's shortcuts
        container.addEventListener("keydown", (e) => e.stopPropagation());
        container.addEventListener("keyup", (e) => e.stopPropagation());
        this.contents.onEdit = (message) => this.onEdit?.(message);
        this.showEmpty(translate("Select one entity"));
    }

    /** Shows an entity (or clears the panel with null). Re-renders on document changes that touch it. */
    show(target: Target | null): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.target = target;
        this.comps.clear();
        this.drafts.clear();
        this.errors.clear();
        this.list = this.links = this.head = this.heading = null;
        this.contents.show(target && { doc: target.doc, pack: target.pack, uid: target.uid, scene: target.scene ?? null });
        if (!target) return this.showEmpty(translate("Select one entity"));
        if (this.namesPack !== target.pack) {
            this.namesPack = target.pack;
            this.names = componentNames(target.pack);
        }
        this.build();
        this.unsubscribe = target.doc.onChange((change) => {
            if (this.target === target && change.entities.includes(target.uid)) this.refresh();
        });
        if (!this.extra.has(target.pack)) this.load(target.pack);
    }

    /** Loads the pack's component schemas and full prototype data, then re-renders. */
    private load(pack: Pack): void {
        if (this.loading.has(pack)) return;
        const p = Promise.all([pack.componentSchemas(), pack.prototypeData()])
            .then(([schemas, data]) => void this.extra.set(pack, { schemas, data }))
            .catch(() => void this.extra.set(pack, { schemas: null, data: null }))
            .finally(() => {
                this.loading.delete(pack);
                if (this.target?.pack === pack) this.refresh();
            });
        this.loading.set(pack, p);
    }

    private showEmpty(message: string): void {
        this.container.replaceChildren(el("div", "ins-empty", message));
    }

    private protoId(): string | undefined {
        const { doc, pack, uid } = this.target!;
        const id = doc.proto(uid);
        return id === undefined ? undefined : (pack.migrate(id) ?? id);
    }

    private build(): void {
        const { doc, uid } = this.target!;
        if (doc.proto(uid) === undefined) return this.showEmpty(translate("Entity deleted"));
        const root = this.container;
        this.head = el("div", "ins-head");
        const body = el("div", "ins-body");
        this.links = el("div");
        this.list = el("div", "ins-list");
        this.datalist = el("datalist");
        this.datalist.id = `ins-ids-${Math.random().toString(36).slice(2)}`;
        body.append(...(this.target!.top ? [this.target!.top] : []), this.links, this.contents.element, this.tools(), this.list, this.datalist);
        root.replaceChildren(this.head, body);
        this.refresh();
    }

    /** Prototype components (full data when loaded, else the pack's drawing subset) and MetaData's name and description. */
    private protoComponents(): Record<string, Record<string, unknown>> {
        const { pack } = this.target!;
        const id = this.protoId();
        if (!id) return {};
        const extra = this.extra.get(pack);
        const base = pack.prototypes.entities[id];
        let comps: Record<string, Record<string, unknown>>;
        if (extra?.data?.entities[id]) {
            comps = { ...pack.fullComponents(extra.data, id) };
            const desc = extra.data.entities[id]!.description;
            comps.MetaData = { ...(comps.MetaData ?? {}), ...(base ? { name: base.name } : {}), ...(desc ? { desc } : {}) };
        } else {
            comps = { ...(base?.components ?? {}) };
            if (base) comps.MetaData = { name: base.name };
        }
        if (!comps.Transform) comps.Transform = {};
        return comps;
    }

    private refresh(): void {
        const { doc, uid } = this.target!;
        if (doc.proto(uid) === undefined) {
            this.comps.clear();
            return this.showEmpty(translate("Entity deleted"));
        }
        if (!this.list || !this.list.isConnected) return this.build();
        const focus = this.focusKey();
        this.refreshHead();
        this.refreshLinks();
        this.refreshList();
        if (focus) this.restoreFocus(focus);
    }

    private refreshHead(): void {
        const { doc, pack, uid } = this.target!;
        const id = doc.proto(uid)!;
        const current = this.protoId();
        const proto = current ? pack.prototypes.entities[current] : undefined;
        const meta = doc.components(uid).find((c) => c.type === "MetaData")?.data;
        // entities without a prototype: the map itself and grids
        const kind = id ? null : doc.mapEntities().includes(uid) ? translate("Map") : doc.grids().includes(uid) ? translate("Grid") : translate("Entity");
        const name = typeof meta?.name === "string" && meta.name ? meta.name : (current && pack.entityText(current).name) || id || kind!;
        const about = kind ? translate("{{1}}, uid {{2}}", { 1: kind, 2: uid }) : translate("{{1}}, uid {{2}}{{3}}", { 1: id, 2: uid, 3: proto ? "" : translate(", not in the pack") });
        this.head!.replaceChildren(el("div", "ins-name", name), el("div", "ins-meta", about));
    }

    private tools(): HTMLElement {
        const wrap = el("div");
        const bar = el("div", "ins-tools");
        const search = el("input");
        search.type = "search";
        search.placeholder = translate("Filter components");
        search.setAttribute("aria-label", translate("Filter components"));
        search.spellcheck = false;
        search.value = this.filter;
        search.addEventListener("input", () => {
            this.filter = search.value;
            this.refreshList();
        });
        const form = el("div", "ins-addform");
        form.hidden = true;
        const add = btn("ins-btn", translate("Add"), translate("Add component"), () => {
            form.hidden = !form.hidden;
            if (!form.hidden) input.focus();
        });
        bar.append(search, add);

        const input = el("input");
        input.placeholder = translate("Component name");
        input.setAttribute("aria-label", translate("Component name"));
        input.spellcheck = false;
        const hits = el("div", "ins-hits");
        const error = el("div", "ins-error");
        const fill = () => {
            const found = filterNames(this.names, input.value, 12);
            hits.replaceChildren(...found.map((n) => btn("", n, "", () => choose(n))));
        };
        const choose = (name: string) => {
            name = name.trim();
            if (!name) return;
            const { doc, uid } = this.target!;
            const view = this.views().find((v) => v.type === name);
            if (!view && !this.names.includes(name)) {
                error.textContent = translate("No component named {{1}}", { 1: name });
                return;
            }
            if (!view) {
                try {
                    doc.setComponent(uid, name, "");
                } catch (e) {
                    error.textContent = e instanceof Error ? e.message : String(e);
                    return;
                }
                this.onEdit?.(translate("Added {{1}}", { 1: name }));
            }
            error.textContent = "";
            input.value = "";
            form.hidden = true;
            this.filter = search.value = "";
            opened.add(name);
            storeSet(OPEN_KEY, opened);
            this.refreshList();
            this.comps.get(name)?.root.scrollIntoView({ block: "nearest" });
        };
        input.addEventListener("focus", fill);
        input.addEventListener("input", fill);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const typed = input.value.trim();
                choose(this.names.includes(typed) ? typed : (hits.querySelector("button")?.textContent ?? typed));
            } else if (e.key === "Escape") {
                form.hidden = true;
                add.focus();
            }
        });
        form.append(input, hits, error);
        wrap.append(bar, form);
        return wrap;
    }

    private views(): ComponentView[] {
        const { doc, pack, uid } = this.target!;
        return componentViews(this.protoComponents(), doc.components(uid), this.extra.get(pack)?.schemas ?? null);
    }

    /** Brings the component rows in line with the document, rebuilding only what changed. */
    private refreshList(): void {
        const list = this.list!;
        const { doc, pack, uid } = this.target!;
        const overrides = doc.components(uid);
        const proto = this.protoComponents();
        const extra = this.extra.get(pack);
        const views = componentViews(proto, overrides, extra?.schemas ?? null);
        const q = this.filter.trim().toLowerCase();
        const shown = q ? views.filter((v) => v.type.toLowerCase().includes(q)) : views;
        const keep = new Set(shown.map((v) => v.type));
        for (const [type, c] of this.comps) if (!keep.has(type)) (c.root.remove(), this.comps.delete(type));
        const nodes: HTMLElement[] = [];
        this.heading ??= el("div", "ins-heading");
        const count = el("span", "ins-sub", String(views.length));
        this.heading.replaceChildren(translate("Components"), count);
        nodes.push(this.heading);
        for (const v of shown) {
            const over = overrides.find((o) => o.type === v.type);
            const open = opened.has(v.type);
            const sig = `${v.inPrototype}|${v.overridden}|${open}`;
            let c = this.comps.get(v.type);
            if (!c || c.sig !== sig) {
                const fresh = this.compRow(v, open);
                if (c) c.root.replaceWith(fresh.root);
                c = { ...fresh, sig };
                this.comps.set(v.type, c);
            }
            if (open) this.refreshFields(c, v, proto[v.type], over?.text, !extra);
            nodes.push(c.root);
        }
        if (!shown.length) nodes.push(el("div", "ins-note", q ? translate("No matches") : translate("No components")));
        syncChildren(list, nodes);
    }

    private compRow(v: ComponentView, open: boolean): Omit<CompEl, "sig"> {
        const root = el("div", "ins-comp" + (open ? " open" : ""));
        const row = el("button", "ins-row");
        row.type = "button";
        row.append(icon(ICON.chevronRight, 12), el("span", "ins-cname", v.type));
        if (v.overridden) {
            const dot = el("span", "ins-dot");
            dot.title = translate("Changed on the map");
            row.append(dot);
        }
        if (!v.inPrototype) {
            const tag = el("span", "ins-tag", translate("component.mapBadge"));
            tag.title = translate("Not in the prototype");
            row.append(tag);
        }
        row.title = v.overridden ? (v.inPrototype ? translate("Changed on the map") : translate("Added on the map")) : "";
        row.addEventListener("click", () => {
            if (opened.has(v.type)) opened.delete(v.type);
            else opened.add(v.type);
            storeSet(OPEN_KEY, opened);
            this.refreshList();
        });
        root.append(row);
        return { root, row, fields: null, fieldsSig: "", rows: new Map() };
    }

    /** The fields of an open component, rebuilt row by row where they changed. */
    private refreshFields(c: CompEl, v: ComponentView, proto: Record<string, unknown> | undefined, overrideText: string | undefined, loading: boolean): void {
        const { pack } = this.target!;
        const schemas = this.extra.get(pack)?.schemas ?? null;
        const schema = schemas?.components[v.type];
        const whole = this.drafts.has(v.type) || (!loading && !schema);
        const sig = JSON.stringify([overrideText ?? null, v.overridden, whole, loading, this.errors.get(v.type) ?? "", proto ?? null]);
        if (c.fields && c.fieldsSig === sig) return;
        const box = c.fields ?? el("div", "ins-fields");
        if (!c.fields) c.root.append(box);
        c.fields = box;
        c.fieldsSig = sig;
        const nodes: HTMLElement[] = [];

        const tools = el("div", "ins-ctools");
        if (schema) {
            const yaml = btn("ins-btn" + (this.drafts.has(v.type) ? " on" : ""), "YAML", translate("Edit as YAML"), () => {
                if (this.drafts.has(v.type)) this.drafts.delete(v.type);
                else this.drafts.set(v.type, overrideText ?? "");
                this.rerender(v.type);
            });
            tools.append(yaml);
        }
        if (v.overridden) {
            const label = v.inPrototype ? translate("Remove override") : translate("Remove component");
            const remove = btn("ins-btn danger", label, v.inPrototype ? translate("Reset all fields to the prototype") : translate("Remove the component from this entity"), () => this.removeOverride(v.type));
            remove.disabled = FIXED_COMPONENTS.has(v.type);
            if (remove.disabled) remove.title = translate("{{1}} cannot be removed", { 1: v.type });
            tools.append(remove);
        }
        if (tools.childElementCount) nodes.push(tools);
        const error = el("div", "ins-error", this.errors.get(v.type) ?? "");
        nodes.push(error);

        if (loading) {
            nodes.push(el("div", "ins-note", translate("Loading fields")));
            c.rows.clear();
        } else if (whole) {
            nodes.push(this.wholeEditor(v, proto, overrideText, !schema));
            c.rows.clear();
        } else {
            const fields = fieldViews(schema, proto, overrideText);
            const order = (schema ?? []).map((f) => f.name);
            const seen = new Set<string>();
            for (const f of fields) {
                seen.add(f.name);
                const draft = this.drafts.get(`${v.type}.${f.name}`);
                const fsig = JSON.stringify([f.override?.text ?? null, f.proto ?? null, draft ?? null, v.inPrototype]);
                let r = c.rows.get(f.name);
                if (!r || r.sig !== fsig) {
                    r = { el: this.fieldRow(v, f, order), sig: fsig };
                    c.rows.set(f.name, r);
                }
                nodes.push(r.el);
            }
            for (const k of [...c.rows.keys()]) if (!seen.has(k)) c.rows.delete(k);
            if (!fields.length) nodes.push(el("div", "ins-note", translate("No data fields")));
        }
        syncChildren(box, nodes);
    }

    /** Rebuilds a component's fields on the next render (after a UI action that changed what they show). */
    private rerender(type: string): void {
        const c = this.comps.get(type);
        if (c) {
            c.fieldsSig = "";
            c.rows.clear();
        }
        this.refreshList();
    }

    /** The whole override as YAML (components without a schema, or on request), with the prototype's values below. */
    private wholeEditor(v: ComponentView, proto: Record<string, unknown> | undefined, overrideText: string | undefined, unknown: boolean): HTMLElement {
        const wrap = el("div", "ins-whole");
        const area = el("textarea");
        area.spellcheck = false;
        area.setAttribute("aria-label", v.type);
        area.dataset.focus = v.type;
        area.value = this.drafts.get(v.type) ?? overrideText ?? "";
        area.placeholder = v.overridden ? "" : translate("Fields set on the map");
        area.rows = Math.min(16, Math.max(2, area.value.split("\n").length));
        area.addEventListener("input", () => this.drafts.set(v.type, area.value));
        const target = this.target;
        const apply = () => {
            if (target !== this.target) return;
            if (this.write(v.type, area.value.trim() === "" && v.inPrototype ? null : area.value, translate("Edited {{1}}", { 1: v.type }))) {
                this.drafts.delete(v.type);
                this.rerender(v.type);
            }
        };
        area.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                apply();
            }
        });
        const buttons = el("div", "ins-buttons");
        buttons.append(
            btn("ins-btn primary", translate("Apply"), "Ctrl+Enter", apply),
            btn("ins-btn", unknown ? translate("Revert") : translate("Close"), "", () => {
                this.drafts.delete(v.type);
                this.errors.delete(v.type);
                this.rerender(v.type);
            }),
        );
        wrap.append(area, buttons);
        if (proto && Object.keys(proto).length) {
            const title = el("div", "ins-heading", translate("Prototype"));
            wrap.append(title, el("pre", "", toYaml(proto)));
        }
        if (unknown) wrap.prepend(el("div", "ins-note", translate("No field list for this component. Edit it as YAML.")));
        return wrap;
    }

    /** Writes an override text (null removes the override); returns whether it was applied. */
    private write(type: string, text: string | null, message: string): boolean {
        const { doc, uid } = this.target!;
        const current = doc.components(uid).find((o) => o.type === type);
        try {
            if (text === null) {
                if (current) doc.removeComponent(uid, type);
            } else if (!current || current.text !== text) doc.setComponent(uid, type, text);
            else return true;
        } catch (e) {
            this.errors.set(type, e instanceof Error ? e.message : String(e));
            this.refreshList();
            return false;
        }
        this.errors.delete(type);
        this.onEdit?.(message);
        return true;
    }

    private removeOverride(type: string): void {
        const { doc, uid } = this.target!;
        try {
            if (doc.removeComponent(uid, type)) this.onEdit?.(translate("Removed {{1}} override", { 1: type }));
            this.errors.delete(type);
        } catch (e) {
            this.errors.set(type, e instanceof Error ? e.message : String(e));
            this.refreshList();
        }
    }

    /** Sets a field to an editor's value (or resets it with null). Returns an error message, or null. */
    private setField(v: ComponentView, f: FieldView, input: unknown | null, order: readonly string[], target: Target | null): string | null {
        // an editor of an entity no longer shown (its value committed as the selection changed)
        if (target !== this.target) return null;
        const { doc, uid } = this.target!;
        const overrideText = doc.components(uid).find((o) => o.type === v.type)?.text;
        let yaml: string | null = null;
        if (input !== null) {
            try {
                yaml = formatValue(f, input);
            } catch (e) {
                return e instanceof Error ? e.message : String(e);
            }
        }
        const colors = this.target!.pack.prototypes.colors;
        let text: string | null;
        try {
            text = writeField(overrideText, f, yaml, order, v.inPrototype, colors);
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
        const ok = this.write(v.type, text, input === null ? translate("Reset {{1}}.{{2}}", { 1: v.type, 2: f.name }) : translate("Set {{1}}.{{2}}", { 1: v.type, 2: f.name }));
        return ok ? null : (this.errors.get(v.type) ?? translate("Not applied"));
    }

    private fieldRow(v: ComponentView, f: FieldView, order: readonly string[]): HTMLElement {
        const target = this.target;
        const row = el("div", "ins-field" + (f.override ? " over" : ""));
        const label = el("div", "ins-label");
        const name = el("span", "ins-fname");
        // long camelCase names wrap at word boundaries
        f.name.split(/(?<=[a-z0-9])(?=[A-Z])/).forEach((part, i) => {
            if (i) name.append(document.createElement("wbr"));
            name.append(part);
        });
        const type = el("span", "ins-ftype", f.type);
        const s = f.schema;
        const notes = [f.type === "?" ? translate("Not in the component's field list") : f.type, s?.required ? "required" : "", s?.vv === "rw" ? translate("VV: read-write") : s?.vv === "r" ? translate("VV: read-only") : ""].filter(Boolean);
        label.title = `${f.name}: ${notes.join(", ")}`;
        label.append(name, type);
        const { value, source } = effective(f);
        const cell = el("div", "ins-value" + (source === "prototype" ? " inherited" : source === "default" || source === "none" ? " unset" : ""));
        cell.title = { map: translate("Map value"), prototype: translate("Prototype value"), default: translate("Default value"), none: translate("Not set") }[source];
        const reset = el("button", "ins-reset");
        reset.type = "button";
        if (f.override) {
            reset.title = translate("Reset to prototype");
            reset.setAttribute("aria-label", translate("Reset {{1}} to prototype", { 1: f.name }));
            reset.append(icon(ICON.undo, 14));
            reset.addEventListener("click", () => {
                this.drafts.delete(`${v.type}.${f.name}`);
                this.setField(v, f, null, order, target);
            });
        } else reset.tabIndex = -1;
        row.append(label, cell, reset);

        const key = `${v.type}.${f.name}`;
        const colors = this.target!.pack.prototypes.colors;
        const commit = (input: unknown, field: HTMLInputElement | HTMLSelectElement | null) => {
            const err = this.setField(v, f, input, order, target);
            if (field) {
                field.classList.toggle("bad", !!err);
                field.title = err ?? "";
            }
        };
        const text = (initial: string, mark = "", mode: "text" | "decimal" | "numeric" = "text") => {
            const input = el("input");
            input.type = "text";
            input.value = initial;
            input.spellcheck = false;
            input.dataset.focus = key + mark;
            if (mode !== "text") input.inputMode = mode;
            input.setAttribute("aria-label", f.name);
            // "commit" on Enter (the field keeps the focus) or when the field loses it with a new value
            let last = initial;
            const send = () => {
                if (input.value === last) return;
                last = input.value;
                input.dispatchEvent(new Event("commit"));
            };
            input.addEventListener("change", send);
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") send();
                else if (e.key === "Escape") {
                    input.value = last = initial;
                    input.classList.remove("bad");
                    input.title = "";
                    input.blur();
                }
            });
            return input;
        };

        if (COMPLEX.has(f.kind)) {
            const draft = this.drafts.get(key);
            const current = editorText(f, value, colors);
            const preview = el("button", "ins-preview", current.split("\n").length > 1 ? current.split("\n")[0] + " ..." : current || "null");
            preview.type = "button";
            preview.dataset.focus = key;
            preview.title = current || "null";
            preview.addEventListener("click", () => {
                if (this.drafts.has(key)) this.drafts.delete(key);
                else this.drafts.set(key, current);
                this.rerender(v.type);
                (this.container.querySelector(`textarea[data-focus="${CSS.escape(key + ".yaml")}"]`) as HTMLTextAreaElement | null)?.focus();
            });
            cell.append(preview);
            if (draft !== undefined) {
                const box = el("div", "ins-yaml");
                const area = el("textarea");
                area.spellcheck = false;
                area.value = draft;
                area.dataset.focus = key + ".yaml";
                area.setAttribute("aria-label", f.name);
                area.rows = Math.min(14, Math.max(2, draft.split("\n").length));
                const err = el("div", "ins-error");
                area.addEventListener("input", () => this.drafts.set(key, area.value));
                const apply = () => {
                    const msg = area.value.trim() === "" ? translate("Empty value") : this.setField(v, f, area.value, order, target);
                    err.textContent = msg ?? "";
                    if (!msg) {
                        this.drafts.delete(key);
                        this.rerender(v.type);
                    }
                };
                area.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        apply();
                    } else if (e.key === "Escape") {
                        this.drafts.delete(key);
                        this.rerender(v.type);
                    }
                });
                const buttons = el("div", "ins-buttons");
                buttons.append(
                    btn("ins-btn primary", translate("Apply"), "Ctrl+Enter", apply),
                    btn("ins-btn", translate("Cancel"), "Esc", () => {
                        this.drafts.delete(key);
                        this.rerender(v.type);
                    }),
                );
                box.append(area, err, buttons);
                row.append(box);
            }
            return row;
        }

        switch (f.kind) {
            case "bool": {
                const box = el("input");
                box.type = "checkbox";
                box.checked = String(value).toLowerCase() === "true";
                box.dataset.focus = key;
                box.setAttribute("aria-label", f.name);
                box.addEventListener("commit", () => commit(box.checked, null));
                cell.append(box);
                break;
            }
            case "enum": {
                const select = el("select");
                select.dataset.focus = key;
                select.setAttribute("aria-label", f.name);
                const members = [...(this.extra.get(this.target!.pack)?.schemas?.enums[f.schema?.enum ?? ""]?.members ?? [])];
                const cur = value === null || value === undefined ? "" : String(value);
                if (!members.includes(cur)) members.unshift(cur);
                for (const m of members) select.append(new Option(m || "null", m, false, m === cur));
                select.addEventListener("change", () => commit(select.value, select));
                cell.append(select);
                break;
            }
            case "color": {
                const hex = editorText(f, value, colors);
                const [rgb, alpha] = splitColor(hex || null);
                const picker = el("input");
                picker.type = "color";
                picker.value = rgb;
                picker.dataset.focus = key + ".rgb";
                picker.setAttribute("aria-label", translate("{{1}} colour", { 1: f.name }));
                const field = text(hex, ".hex");
                field.classList.add("ins-hex");
                const a = text(String(alpha), ".a", "numeric");
                a.className = "ins-alpha";
                a.title = translate("Alpha (0-255)");
                a.setAttribute("aria-label", translate("{{1}} alpha", { 1: f.name }));
                picker.addEventListener("change", () => commit(joinColor(picker.value, Number(a.value)), field));
                field.addEventListener("commit", () => commit(field.value, field));
                a.addEventListener("commit", () => {
                    const n = Number(a.value);
                    if (!/^\d+$/.test(a.value.trim()) || n > 255) {
                        a.classList.add("bad");
                        a.title = translate("Alpha is 0 to 255");
                        return;
                    }
                    commit(joinColor(picker.value, n), a);
                });
                cell.append(picker, field, a);
                break;
            }
            case "vector2":
            case "vector2i": {
                const [x0, y0] = typeof value === "string" ? value.split(",").map((p) => p.trim()) : ["", ""];
                const x = text(x0 ?? "", ".x", "decimal");
                const y = text(y0 ?? "", ".y", "decimal");
                const send = (field: HTMLInputElement) => commit([x.value, y.value], field);
                x.addEventListener("commit", () => send(x));
                y.addEventListener("commit", () => send(y));
                cell.append(el("span", "ins-axis", "x"), x, el("span", "ins-axis", "y"), y);
                break;
            }
            case "angle": {
                const input = text(editorText(f, value, colors), "", "decimal");
                input.title = translate("Degrees");
                input.addEventListener("commit", () => commit(input.value, input));
                cell.append(input, el("span", "ins-unit", translate("unit.degrees")));
                break;
            }
            case "timespan": {
                const input = text(editorText(f, value, colors));
                input.title = translate("Seconds, or 500ms, 2m, 1h");
                input.addEventListener("commit", () => commit(input.value, input));
                cell.append(input, el("span", "ins-unit", translate("unit.seconds")));
                break;
            }
            case "proto": {
                const input = text(editorText(f, value, colors));
                input.setAttribute("list", this.datalist!.id);
                input.placeholder = f.schema?.proto ?? "";
                const ids = () => (f.schema?.proto === "entity" ? Object.keys(this.target!.pack.prototypes.entities) : (this.extra.get(this.target!.pack)?.schemas?.prototypeIds[f.schema?.proto ?? ""] ?? []));
                const fill = () => this.datalist!.replaceChildren(...filterNames(ids(), input.value, 40).map((id) => new Option(id)));
                input.addEventListener("focus", fill);
                input.addEventListener("input", fill);
                input.addEventListener("commit", () => commit(input.value, input));
                cell.append(input);
                break;
            }
            case "int":
            case "float":
            case "entity": {
                const input = text(editorText(f, value, colors), "", f.kind === "float" ? "decimal" : "numeric");
                input.addEventListener("commit", () => commit(input.value, input));
                cell.append(input);
                break;
            }
            default: {
                const input = text(editorText(f, value, colors));
                if (source === "none") input.placeholder = "null";
                input.addEventListener("commit", () => commit(input.value, input));
                cell.append(input);
            }
        }
        return row;
    }

    private focusKey(): { key: string; start: number | null } | null {
        const a = document.activeElement as HTMLElement | null;
        if (!a || !this.container.contains(a) || !a.dataset.focus) return null;
        return { key: a.dataset.focus, start: a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a.selectionStart : null };
    }

    private restoreFocus(f: { key: string; start: number | null }): void {
        const a = document.activeElement as HTMLElement | null;
        if (a && this.container.contains(a)) return;
        const next = this.container.querySelector<HTMLElement>(`[data-focus="${CSS.escape(f.key)}"]`);
        if (!next) return;
        next.focus();
        if (f.start !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
            try {
                next.setSelectionRange(f.start, f.start);
            } catch {
                /* not a text field */
            }
        }
    }

    /** Links of the entity with buttons that remove them (linking itself is the multitool's). */
    private refreshLinks(): void {
        const { doc, pack, uid } = this.target!;
        const box = this.links;
        if (!box) return;
        const r = relations(doc, uid);
        const ports = doc.signalPorts(uid, pack);
        const config = isConfigurator(doc, uid, pack);
        const rows: HTMLElement[] = [];
        const row = (text: string, title: string, remove: () => void) => {
            const div = el("div", "ins-link");
            const b = el("button", "ins-x", "×");
            b.title = title;
            b.setAttribute("aria-label", title);
            b.addEventListener("click", remove);
            div.append(el("span", "", text), b);
            rows.push(div);
        };
        const label = (other: number) => entityLabel(doc, other, pack);
        for (const l of r.outgoing) {
            row(`${l.sourcePort} → ${label(l.sink)} ${l.sinkPort}`, translate("Unlink"), () => {
                doc.unlink(l.source, l.sink, l.sourcePort, l.sinkPort);
                this.onEdit?.(translate("Unlinked {{1}} → {{2}}", { 1: l.sourcePort, 2: l.sinkPort }));
            });
        }
        for (const l of r.incoming) {
            row(`${label(l.source)} ${l.sourcePort} → ${l.sinkPort}`, translate("Unlink"), () => {
                doc.unlink(l.source, l.sink, l.sourcePort, l.sinkPort);
                this.onEdit?.(translate("Unlinked {{1}} → {{2}}", { 1: l.sourcePort, 2: l.sinkPort }));
            });
        }
        for (const d of r.devices) {
            row(translate("Device: {{1}}", { 1: label(d) }), translate("Remove from this device list"), () => {
                doc.removeFromDeviceList(uid, d, pack);
                this.onEdit?.(translate("Removed {{1}} from the device list", { 1: label(d) }));
            });
        }
        for (const c of r.lists) {
            row(translate("In the list of {{1}}", { 1: label(c) }), translate("Remove from that device list"), () => {
                doc.removeFromDeviceList(c, uid, pack);
                this.onEdit?.(translate("Removed from the device list of {{1}}", { 1: label(c) }));
            });
        }
        const any = rows.length || ports.source.length || ports.sink.length || config;
        if (!any) return void box.replaceChildren();
        const title = el("span", "", translate("Links "));
        title.append(el("span", "ins-sub", String(rows.length)));
        const sec = section(translate("Links"), title);
        const note = [ports.source.length ? translate("source: {{1}}", { 1: ports.source.join(", ") }) : "", ports.sink.length ? translate("sink: {{1}}", { 1: ports.sink.join(", ") }) : "", config ? translate("device list: {{1}}", { 1: r.devices.length }) : ""].filter(Boolean).join(", ");
        sec.body.append(el("div", "ins-note", note), ...(rows.length ? rows : [el("div", "ins-note", translate("No links. Link with the multitool."))]));
        box.replaceChildren(sec.root);
    }
}
