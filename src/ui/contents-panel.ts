// Contents section of the Properties column: the containers of the entity (entity storage of lockers and crates,
// storage of bags, item slots) with what they hold. Add by search (refused prototypes shown with the reason) or by
// dragging a palette row onto a container; drag a stored entity onto another container to move it, or onto the
// map to take it out there. Take out puts an entity on the tile of its container. Presets save
// a container's contents and put them into others. Logic without DOM is in editor/contents.ts and
// container-presets.ts.
import { language, t as translate } from "../i18n";
import { Contents, contentsKit, takeOutPlace, type ContentsKit, type Floor } from "../editor/contents";
import type { ContainerInfo, MapPlace } from "../map/containers";
import type { MapDocument } from "../map/document";
import type { Pack } from "../pack/loader";
import type { Scene } from "../render/scene";
import { countItems, describeItems, loadPresets, savePresets, type ContentsPreset, type Presets } from "./container-presets";
import { dragged, isOurs, setDragged, UID_TYPE } from "./drag";
import { button, h, icon, ICON, spriteCanvas } from "./icons";
import { popupMenu, type MenuItem } from "./menus";
import { entityIcon } from "./palette";
import { entityEntries, search, type PaletteEntry } from "./palette-search";
import { showToast } from "./toast";

const STYLE = `
.inspector .cts-note { margin: 2px 0 6px; padding: 6px 8px; border: 1px solid var(--border); border-left: 2px solid var(--warn); border-radius: var(--radius-s); background: var(--panel-2); color: var(--text-2); font-size: 12px; }
.inspector .cts-note .ins-btn { margin-top: 6px; }
.inspector .cts-box { margin: 0 0 6px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--panel-2); }
.inspector .cts-box.drop { border-color: var(--accent); }
.inspector .cts-box.refuse { border-color: var(--danger-border); }
.inspector .cts-bhead { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 4px 0 8px; }
.inspector .cts-bname { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inspector .cts-count { color: var(--muted); font-size: 12px; white-space: nowrap; }
.inspector .cts-grow { flex: 1; }
.inspector .cts-icon { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--radius-s); color: var(--muted); }
.inspector .cts-icon:hover:not(:disabled) { background: var(--raised); color: var(--text); }
.inspector .cts-icon.danger:hover:not(:disabled) { background: var(--danger-bg); color: var(--danger-text); }
.inspector .cts-items { padding: 0 4px 4px; }
.inspector .cts-empty { padding: 2px 8px 6px; color: var(--faint); font-size: 12px; }
.inspector .cts-item { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 0 0 2px; border-radius: var(--radius-s); cursor: grab; }
.inspector .cts-item:hover { background: var(--raised); }
.inspector .cts-item canvas { flex: none; width: 24px; height: 24px; }
.inspector .cts-item .cts-chev { width: 18px; }
.inspector .cts-item .cts-chev svg { transition: transform 0.1s; }
.inspector .cts-item.open .cts-chev svg { transform: rotate(90deg); }
.inspector .cts-item .cts-pad { flex: none; width: 18px; }
.inspector .cts-text { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
.inspector .cts-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector .cts-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-size: 11px; }
.inspector .cts-nest { margin: 2px 0 4px 20px; }
.inspector .cts-form { padding: 2px 8px 6px; }
.inspector .cts-row { display: flex; gap: 6px; align-items: center; }
.inspector .cts-row input[type="search"], .inspector .cts-row input[type="text"] { flex: 1; height: 26px; }
.inspector .cts-row input[type="number"] { flex: none; width: 52px; height: 26px; }
.inspector .cts-times { color: var(--muted); font-size: 12px; }
.inspector .cts-hits { margin-top: 4px; max-height: 260px; overflow-y: auto; }
.inspector .cts-hit { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 30px; padding: 0 4px; text-align: left; border-radius: var(--radius-s); }
.inspector .cts-hit:hover:not(:disabled) { background: var(--raised); }
.inspector .cts-hit:disabled { opacity: 1; cursor: default; }
.inspector .cts-hit:disabled canvas, .inspector .cts-hit:disabled .cts-name { opacity: 0.45; }
.inspector .cts-why { color: var(--danger-text); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspector .cts-sub { padding: 6px 0 2px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.inspector .cts-preset { display: flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 4px; border-radius: var(--radius-s); }
.inspector button.cts-preset { width: 100%; text-align: left; }
.inspector button.cts-preset:hover { background: var(--raised); }
.inspector .cts-preset .cts-text { flex: 1; }
.inspector .cts-manage { margin: 0 0 6px; padding: 4px 8px 6px; border: 1px solid var(--border); border-radius: var(--radius-s); }
.inspector .cts-manage .cts-bhead { padding: 0; }
.inspector .cts-err { padding: 0 8px 6px; color: var(--danger-text); font-size: 12px; }
.inspector .cts-err.warn { color: var(--warn); }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

/** How many search results the add form lists (those the container takes first). */
const HITS = 30;
/** How many refused results it lists after them, with the reason. */
const REFUSED_HITS = 8;
const MAX_COUNT = 50;

export interface ContentsTarget {
    doc: MapDocument;
    pack: Pack;
    uid: number;
    /** For taking entities out onto the map (free tiles). */
    scene?: Scene | null;
}

const entries = new WeakMap<Pack, PaletteEntry[]>();
function entityList(pack: Pack): PaletteEntry[] {
    let list = entries.get(pack);
    if (!list) entries.set(pack, (list = entityEntries(pack, language())));
    return list;
}

/** Floor of a scene for the free tile search: anchored entities and drawn loose ones. */
export function sceneFloor(scene: Scene, taken?: Set<string>): Floor {
    return {
        tileAt: (g, x, y) => scene.tileAt(g, x, y),
        anchoredAt: (g, x, y) => scene.anchoredAt(g, x, y),
        looseAt: (g, x, y) => {
            if (taken?.has(`${g}|${x}|${y}`)) return true;
            const [wx, wy] = scene.toWorld(g, x + 0.5, y + 0.5);
            for (const s of scene.sprites.query(wx - 0.5, wy - 0.5, wx + 0.5, wy + 0.5)) {
                const p = scene.placement(s.uid);
                if (p && p.grid === g && Math.floor(p.x) === x && Math.floor(p.y) === y) return true;
            }
            return false;
        },
    };
}

/** "entity_storage" → "Entity storage". */
function containerName(c: ContainerInfo): string {
    if (c.role === "storage" && c.id === "storagebase") return translate("Storage");
    const s = c.id.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
    return s ? s[0]!.toUpperCase() + s.slice(1) : c.id;
}

export class ContentsPanel {
    /** The section; the inspector puts it where it belongs. */
    readonly element: HTMLElement;
    /** An edit was made or refused (for the status line). */
    onEdit: ((message: string) => void) | null = null;

    private target: ContentsTarget | null = null;
    private kit: ContentsKit | null = null;
    private contents: Contents | null = null;
    private unsubscribe: (() => void) | null = null;
    /** Entities shown (the owner, what it holds): a change to any of them redraws the section. */
    private watched = new Set<number>();
    /** Stored entities whose containers are shown. */
    private readonly expanded = new Set<number>();
    /** Container whose add form is open ("owner|id"), with the form's state. */
    private adding: string | null = null;
    private query = "";
    private count = 1;
    private addInput: HTMLInputElement | null = null;
    /** Container whose "save as preset" form is open. */
    private saving: string | null = null;
    private saveName = "";
    private messages = new Map<string, { text: string; warn?: boolean }>();
    private managing = false;
    private renaming: string | null = null;
    private presets: Presets | null = null;
    private presetsFork = "";
    private open = true;

    constructor() {
        addStyle();
        this.element = h("div", "cts-wrap");
    }

    /** Shows the containers of an entity (or nothing with null). */
    show(target: ContentsTarget | null): void {
        this.unsubscribe?.();
        this.unsubscribe = null;
        const same = this.target && target && this.target.doc === target.doc && this.target.uid === target.uid;
        this.target = target;
        if (!same) {
            this.expanded.clear();
            this.adding = this.saving = null;
            this.query = "";
            this.count = 1;
            this.messages.clear();
            this.managing = false;
        }
        if (!target) return void this.element.replaceChildren();
        const fork = target.pack.manifest.fork.id;
        if (!this.presets || this.presetsFork !== fork) {
            this.presets = loadPresets(fork);
            this.presetsFork = fork;
        }
        this.unsubscribe = target.doc.onChange((change) => {
            if (this.target !== target) return;
            if (change.entities.some((u) => this.watched.has(u))) this.render();
        });
        if (this.kit && this.contents?.doc === target.doc && this.kitPack === target.pack) return this.render();
        this.contents = null;
        this.element.replaceChildren();
        void contentsKit(target.pack).then(
            (kit) => {
                if (this.target !== target) return;
                this.kit = kit;
                this.kitPack = target.pack;
                this.contents = new Contents(target.doc, kit);
                this.render();
            },
            () => {},
        );
    }

    private kitPack: Pack | null = null;

    // -----------------------------------------------------------------------------------------
    // Rendering

    private render(): void {
        const t = this.target, contents = this.contents;
        if (!t || !contents || t.doc.proto(t.uid) === undefined) return void this.element.replaceChildren();
        const boxes = contents.containers(t.uid);
        this.watched = new Set([t.uid]);
        if (!boxes.length) return void this.element.replaceChildren();
        const focused = document.activeElement;
        const refocus = focused instanceof HTMLInputElement && this.element.contains(focused) ? focused : null;
        const caret = refocus?.selectionStart ?? null;

        const root = h("details");
        root.open = this.open;
        root.addEventListener("toggle", () => (this.open = root.open));
        const summary = h("summary", "", translate("Contents "));
        const total = boxes.reduce((n, b) => n + b.contents.length, 0);
        summary.append(h("span", "ins-sub", String(total)));
        const body = h("div", "ins-section");
        root.append(summary, body);

        const fill = this.kit?.rules?.fill(t.doc.proto(t.uid)!);
        if (fill?.fills) {
            const note = h("div", "cts-note", translate("The game fills this container at round start; your items come on top."));
            if (fill.plainBase) {
                const base = fill.plainBase;
                note.append(h("br"), button("ins-btn", translate("Use plain {{1}}", { 1: base }), translate("Change the prototype to {{1}}, keeping uid and contents", { 1: base }), () => this.usePlain(base)));
            }
            body.append(note);
        }
        for (const box of boxes) body.append(this.block(t.uid, box, 0));
        if (this.managing) body.append(this.manageList());
        this.element.replaceChildren(root);
        // the search field is kept across redraws: it keeps the focus and the caret
        if (refocus?.isConnected) {
            refocus.focus();
            if (caret !== null && refocus.type !== "number") refocus.setSelectionRange(caret, caret);
        }
    }

    private name(proto: string): string {
        const { pack } = this.target!;
        return pack.entityText(pack.migrate(proto) ?? proto).name;
    }

    private labelOf(uid: number): string {
        const doc = this.target!.doc;
        const meta = doc.components(uid).find((c) => c.type === "MetaData")?.data.name;
        return typeof meta === "string" && meta ? meta : this.name(doc.proto(uid) ?? String(uid));
    }

    /** One container: header, forms, what it holds. */
    private block(owner: number, box: ContainerInfo, depth: number): HTMLElement {
        const t = this.target!;
        const key = `${owner}|${box.id}`;
        this.watched.add(owner);
        const el = h("div", "cts-box");
        const head = h("div", "cts-bhead");
        const name = h("span", "cts-bname", containerName(box));
        name.title = box.id;
        head.append(name);
        const ownerProto = t.doc.proto(owner) ?? "";
        const n = box.contents.length;
        let count = "";
        if (box.role === "entityStorage") count = `${n} / ${this.kit?.rules?.entityStorageCapacity(ownerProto) ?? 30}`;
        else if (box.kind !== "ContainerSlot") count = String(n);
        if (count) head.append(h("span", "cts-count", count));
        head.append(h("span", "cts-grow"));
        const add = button("ins-btn" + (this.adding === key ? " on" : ""), translate("Add"), translate("Add entities"), () => this.toggleAdd(key));
        const more = button("cts-icon", icon(ICON.more, 16), translate("More"), (e) => this.boxMenu(owner, box, e.currentTarget as HTMLElement));
        more.setAttribute("aria-label", translate("More"));
        head.append(add, more);
        el.append(head);
        if (this.adding === key) el.append(this.addForm(owner, box));
        if (this.saving === key) el.append(this.saveForm(owner, box));
        const msg = this.messages.get(key);
        if (msg) el.append(h("div", "cts-err" + (msg.warn ? " warn" : ""), msg.text));
        const items = h("div", "cts-items");
        for (const uid of box.contents) items.append(...this.item(uid, depth));
        if (!n) el.append(h("div", "cts-empty", translate("Empty")));
        else el.append(items);
        this.dropZone(el, owner, box);
        return el;
    }

    /** A stored entity's row, and its containers when expanded. */
    private item(uid: number, depth: number): HTMLElement[] {
        const t = this.target!, contents = this.contents!;
        this.watched.add(uid);
        const proto = t.doc.proto(uid) ?? "";
        const inner = contents.containers(uid);
        const open = inner.length > 0 && this.expanded.has(uid);
        const row = h("div", "cts-item" + (open ? " open" : ""));
        row.draggable = true;
        row.title = translate("{{1}}, uid {{2}}", { 1: proto, 2: uid });
        row.addEventListener("dragstart", (e) => {
            if (!e.dataTransfer) return;
            e.dataTransfer.setData(UID_TYPE, String(uid));
            e.dataTransfer.effectAllowed = "move";
            setDragged({ kind: "uid", uid });
            e.stopPropagation();
        });
        row.addEventListener("dragend", () => setDragged(null));
        if (inner.length) {
            const chev = button("cts-icon cts-chev", icon(ICON.chevronRight, 12), open ? translate("Close") : translate("Open"), () => {
                if (this.expanded.has(uid)) this.expanded.delete(uid);
                else this.expanded.add(uid);
                this.render();
            });
            chev.setAttribute("aria-expanded", String(open));
            row.append(chev);
        } else row.append(h("span", "cts-pad"));
        row.append(spriteCanvas(t.pack, entityIcon(t.pack, t.pack.migrate(proto) ?? proto), 24));
        const text = h("span", "cts-text");
        const held = inner.reduce((s, c) => s + c.contents.length, 0);
        text.append(h("span", "cts-name", this.labelOf(uid) + (held ? ` (${held})` : "")), h("span", "cts-id", proto));
        row.append(text);
        const out = button("cts-icon", icon(ICON.takeOut, 14), translate("Take out"), () => this.takeOut(uid));
        out.setAttribute("aria-label", translate("Take out"));
        const del = button("cts-icon danger", icon(ICON.trash, 14), translate("Delete"), () => this.remove(uid));
        del.setAttribute("aria-label", translate("Delete"));
        row.append(out, del);
        const out_: HTMLElement[] = [row];
        if (open) {
            const nest = h("div", "cts-nest");
            for (const box of inner) nest.append(this.block(uid, box, depth + 1));
            out_.push(nest);
        }
        return out_;
    }

    /** Drops of palette rows and stored entities onto a container. */
    private dropZone(el: HTMLElement, owner: number, box: ContainerInfo): void {
        const what = (): number | { proto: string } | null => {
            const d = dragged();
            if (d?.kind === "uid") return d.uid;
            if (d?.kind === "entry" && d.entry.kind === "entity") return { proto: d.entry.id };
            return null;
        };
        el.addEventListener("dragover", (e) => {
            const item = what();
            if (!isOurs(e) || item === null) return;
            e.preventDefault();
            e.stopPropagation();
            const ok = this.contents!.check(owner, box.id, item).ok;
            if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? (typeof item === "number" ? "move" : "copy") : "none";
            el.classList.toggle("drop", ok);
            el.classList.toggle("refuse", !ok);
        });
        el.addEventListener("dragleave", (e) => {
            if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
            el.classList.remove("drop", "refuse");
        });
        el.addEventListener("drop", (e) => {
            const item = what();
            el.classList.remove("drop", "refuse");
            if (!isOurs(e) || item === null) return;
            e.preventDefault();
            e.stopPropagation();
            setDragged(null);
            this.put(owner, box, item, 1);
        });
    }

    // -----------------------------------------------------------------------------------------
    // Adding

    private toggleAdd(key: string): void {
        this.adding = this.adding === key ? null : key;
        this.saving = null;
        this.addInput = null;
        this.query = "";
        this.render();
        if (this.adding) (this.addInput as HTMLInputElement | null)?.focus();
    }

    private addForm(owner: number, box: ContainerInfo): HTMLElement {
        const form = h("div", "cts-form");
        const row = h("div", "cts-row");
        const input = (this.addInput ??= h("input"));
        input.type = "search";
        input.placeholder = translate("Search entities");
        input.setAttribute("aria-label", translate("Search entities"));
        input.spellcheck = false;
        input.value = this.query;
        input.dataset.focus = "contents-search";
        const times = h("span", "cts-times", "×");
        const qty = h("input");
        qty.type = "number";
        qty.min = "1";
        qty.max = String(MAX_COUNT);
        qty.value = String(this.count);
        qty.title = translate("How many to add");
        qty.setAttribute("aria-label", translate("How many to add"));
        qty.disabled = box.kind === "ContainerSlot";
        row.append(input, times, qty);
        const hits = h("div", "cts-hits");
        form.append(row, hits);
        const fill = () => this.fillHits(hits, owner, box);
        input.oninput = () => {
            this.query = input.value;
            fill();
        };
        input.onkeydown = (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                hits.querySelector<HTMLButtonElement>("button.cts-hit:not(:disabled)")?.click();
            } else if (e.key === "Escape") {
                e.preventDefault();
                this.toggleAdd(`${owner}|${box.id}`);
            }
        };
        qty.addEventListener("change", () => {
            const v = Math.floor(Number(qty.value));
            this.count = Number.isFinite(v) ? Math.max(1, Math.min(MAX_COUNT, v)) : 1;
            qty.value = String(this.count);
        });
        fill();
        return form;
    }

    /** Search results the container takes, then some it refuses with the reason; presets with an empty query. */
    private fillHits(hits: HTMLElement, owner: number, box: ContainerInfo): void {
        const t = this.target!, contents = this.contents!;
        const q = this.query.trim();
        const nodes: HTMLElement[] = [];
        if (q) {
            const ok: PaletteEntry[] = [];
            const refused: Array<[PaletteEntry, string]> = [];
            for (const e of search(entityList(t.pack), q)) {
                const c = contents.check(owner, box.id, { proto: e.id });
                if (c.ok) ok.push(e);
                else if (refused.length < REFUSED_HITS) refused.push([e, c.reason]);
                if (ok.length >= HITS) break;
            }
            const hit = (e: PaletteEntry, why: string | null) => {
                const b = button("cts-hit", spriteCanvas(t.pack, entityIcon(t.pack, e.id), 24), why ?? translate("Add {{1}}", { 1: e.id }), () => {
                    if (why !== null) return;
                    this.put(owner, box, { proto: e.id }, box.kind === "ContainerSlot" ? 1 : this.count);
                    // the next search goes on in the same field
                    if (this.addInput?.isConnected) this.addInput.focus();
                });
                const text = h("span", "cts-text");
                text.append(h("span", "cts-name", e.name + (e.suffix ? ` (${e.suffix})` : "")), h("span", why ? "cts-why" : "cts-id", why ?? e.id));
                b.append(text);
                b.disabled = why !== null;
                return b;
            };
            for (const e of ok) nodes.push(hit(e, null));
            for (const [e, why] of refused) nodes.push(hit(e, why));
            if (!nodes.length) nodes.push(h("div", "cts-empty", translate("No results")));
        }
        const presets = this.presets?.all ?? [];
        if (presets.length && !q) {
            nodes.push(h("div", "cts-sub", translate("Apply preset")));
            for (const p of presets) nodes.push(this.presetButton(owner, box, p));
        } else if (!q) nodes.push(h("div", "cts-empty", translate("Type to search, or drag from the palette.")));
        hits.replaceChildren(...nodes);
    }

    private presetButton(owner: number, box: ContainerInfo, p: ContentsPreset): HTMLElement {
        const b = button("cts-preset", "", translate("Put the preset's items in {{1}}", { 1: containerName(box) }), () => this.applyPreset(owner, box, p));
        const text = h("span", "cts-text");
        text.append(h("span", "cts-name", p.name), h("span", "cts-id", describeItems(p.items, (id) => this.name(id))));
        b.replaceChildren(text, h("span", "cts-count", String(countItems(p.items))));
        return b;
    }

    // -----------------------------------------------------------------------------------------
    // Edits

    private say(message: string): void {
        this.onEdit?.(message);
    }

    private note(owner: number, box: ContainerInfo, text: string, warn = false): void {
        this.messages.set(`${owner}|${box.id}`, { text, warn });
    }

    private put(owner: number, box: ContainerInfo, item: number | { proto: string }, n: number): void {
        const t = this.target!, contents = this.contents!;
        this.messages.clear();
        const label = typeof item === "number" ? this.labelOf(item) : this.name(item.proto);
        const r = contents.put(owner, box.id, item, n);
        if (!r.ok) {
            this.note(owner, box, r.reason);
            this.say(r.reason);
            this.render();
            return;
        }
        const k = r.uids.length;
        let message = translate("Put {{1}}{{2}} in {{3}}", { 1: label, 2: k > 1 ? ` ×${k}` : "", 3: this.labelOf(owner) });
        if (r.reason) {
            message += `. ${r.reason}`;
            this.note(owner, box, translate("Added {{1}} of {{2}}: {{3}}", { 1: k, 2: n, 3: r.reason }), true);
        }
        this.say(message);
        if (t.doc.proto(owner) !== undefined) this.render();
    }

    /** Where an entity taken out goes, or null. */
    private placeFor(uid: number, taken?: Set<string>): MapPlace | null {
        const scene = this.target?.scene;
        if (!scene) return null;
        return takeOutPlace(this.contents!, sceneFloor(scene, taken), uid);
    }

    private takeOut(uid: number): void {
        const label = this.labelOf(uid);
        const place = this.placeFor(uid);
        if (!place) return this.say(translate("No tile to put it on"));
        this.messages.clear();
        this.contents!.takeOut(uid, place);
        this.say(translate("Took out {{1}}", { 1: label }));
    }

    private remove(uid: number): void {
        const label = this.labelOf(uid);
        this.messages.clear();
        this.contents!.delete(uid);
        this.say(translate("Deleted {{1}}", { 1: label }));
    }

    private takeOutAll(box: ContainerInfo): void {
        const { doc } = this.target!;
        const taken = new Set<string>();
        let n = 0;
        doc.batch("Take out", () => {
            for (const uid of box.contents) {
                const place = this.placeFor(uid, taken);
                if (!place) continue;
                taken.add(`${place.grid}|${Math.floor(place.x)}|${Math.floor(place.y)}`);
                this.contents!.takeOut(uid, place);
                n++;
            }
        });
        this.say(n ? translate("Took out {{1}}", { 1: n }) : translate("No tile to put them on"));
    }

    private deleteAll(box: ContainerInfo): void {
        const { doc } = this.target!;
        doc.batch("Delete", () => {
            for (const uid of box.contents) if (doc.proto(uid) !== undefined) this.contents!.delete(uid);
        });
        this.say(translate("Deleted {{1}}", { 1: box.contents.length }));
    }

    private usePlain(base: string): void {
        const t = this.target!;
        const was = t.doc.proto(t.uid);
        try {
            t.doc.changePrototype(t.uid, base);
        } catch (e) {
            return this.say(e instanceof Error ? e.message : String(e));
        }
        this.say(translate("Changed {{1}} to {{2}}", { 1: was, 2: base }));
    }

    // -----------------------------------------------------------------------------------------
    // Presets

    private boxMenu(owner: number, box: ContainerInfo, anchor: HTMLElement): void {
        const presets = this.presets?.all ?? [];
        const empty = !box.contents.length;
        const items: MenuItem[] = [
            { label: translate("Save contents as preset…"), disabled: empty, run: () => this.startSave(owner, box) },
            {
                label: translate("Apply preset"),
                disabled: !presets.length,
                sub: () => presets.map((p) => ({ label: p.name, note: describeItems(p.items, (id) => this.name(id)), run: () => this.applyPreset(owner, box, p) })),
            },
            { label: translate("Manage presets…"), disabled: !presets.length, run: () => this.toggleManage(true) },
            "-",
            { label: translate("Take out all"), disabled: empty || !this.target?.scene, run: () => this.takeOutAll(box) },
            { label: translate("Delete all"), disabled: empty, run: () => this.deleteAll(box) },
        ];
        const r = anchor.getBoundingClientRect();
        popupMenu(items, r.left, r.bottom + 2);
    }

    private startSave(owner: number, box: ContainerInfo): void {
        this.saving = `${owner}|${box.id}`;
        this.adding = null;
        this.saveName = "";
        this.messages.clear();
        this.render();
        this.element.querySelector<HTMLInputElement>("input[data-focus='preset-name']")?.focus();
    }

    private saveForm(owner: number, box: ContainerInfo): HTMLElement {
        const form = h("div", "cts-form");
        const row = h("div", "cts-row");
        const input = h("input");
        input.type = "text";
        input.placeholder = translate("Preset name");
        input.setAttribute("aria-label", translate("Preset name"));
        input.value = this.saveName;
        input.dataset.focus = "preset-name";
        const err = h("div", "cts-err");
        err.style.padding = "4px 0 0";
        const save = () => {
            const name = input.value.trim();
            const presets = this.presets!;
            const why = presets.nameError(name);
            if (why) {
                err.textContent = why;
                return;
            }
            const items = this.contents!.preset(owner, box.id);
            if (!items.length || !presets.add(name, items)) {
                err.textContent = translate("Nothing to save");
                return;
            }
            if (!savePresets(this.presetsFork, presets)) showToast(translate("Could not store the preset in this browser"));
            this.saving = null;
            this.say(translate("Saved preset {{1}}", { 1: name }));
            this.render();
        };
        input.oninput = () => (this.saveName = input.value);
        input.onkeydown = (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                save();
            } else if (e.key === "Escape") {
                e.preventDefault();
                this.saving = null;
                this.render();
            }
        };
        row.append(
            input,
            button("ins-btn primary", translate("Save"), translate("Save preset"), save),
            button("ins-btn", translate("Cancel"), "", () => {
                this.saving = null;
                this.render();
            }),
        );
        form.append(row, err);
        return form;
    }

    private applyPreset(owner: number, box: ContainerInfo, p: ContentsPreset): void {
        this.messages.clear();
        const r = this.contents!.applyPreset(owner, box.id, p.items);
        let message = translate("Applied {{1}}: {{2}} added", { 1: p.name, 2: r.added });
        if (r.skipped) {
            message += translate(", {{1}} skipped ({{2}}{{3}})", { 1: r.skipped, 2: r.reasons.slice(0, 2).join("; "), 3: r.reasons.length > 2 ? "; …" : "" });
            this.note(owner, box, message, true);
        }
        this.say(message);
        showToast(message);
        this.render();
    }

    private toggleManage(on: boolean): void {
        this.managing = on;
        this.renaming = null;
        this.render();
    }

    private manageList(): HTMLElement {
        const presets = this.presets!;
        const box = h("div", "cts-manage");
        const head = h("div", "cts-bhead");
        head.append(h("span", "cts-bname", translate("Presets")), h("span", "cts-grow"), button("ins-btn", translate("Done"), "", () => this.toggleManage(false)));
        box.append(head);
        if (!presets.all.length) box.append(h("div", "cts-empty", translate("No presets")));
        for (const p of presets.all) {
            const row = h("div", "cts-preset");
            if (this.renaming === p.name) {
                const input = h("input");
                input.type = "text";
                input.value = p.name;
                input.setAttribute("aria-label", translate("Preset name"));
                input.style.flex = "1";
                const err = h("span", "cts-why");
                const done = () => {
                    const to = input.value.trim();
                    const why = presets.nameError(to, p.name);
                    if (why) return void (err.textContent = why);
                    presets.rename(p.name, to);
                    savePresets(this.presetsFork, presets);
                    this.renaming = null;
                    this.render();
                };
                input.onkeydown = (e) => {
                    if (e.key === "Enter") done();
                    else if (e.key === "Escape") {
                        this.renaming = null;
                        this.render();
                    }
                };
                row.append(input, err, button("ins-btn", "OK", "", done));
                queueMicrotask(() => input.select());
            } else {
                const text = h("span", "cts-text");
                text.append(h("span", "cts-name", p.name), h("span", "cts-id", describeItems(p.items, (id) => this.name(id))));
                row.append(
                    text,
                    button("ins-btn", translate("Rename"), "", () => {
                        this.renaming = p.name;
                        this.render();
                    }),
                    button("cts-icon danger", icon(ICON.trash, 14), translate("Delete preset"), () => this.deletePreset(p.name)),
                );
            }
            box.append(row);
        }
        return box;
    }

    private deletePreset(name: string): void {
        const presets = this.presets!;
        const fork = this.presetsFork;
        const snap = presets.remove(name);
        if (!snap) return;
        savePresets(fork, presets);
        this.render();
        showToast(translate("Deleted preset {{1}}", { 1: name }), {
            label: translate("Undo"),
            run: () => {
                if (presets.restore(snap)) savePresets(fork, presets);
                this.render();
            },
        });
    }
}
