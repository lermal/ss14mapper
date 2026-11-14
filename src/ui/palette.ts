// Palette of placeable entities, tiles and decals of the open build, with search.
// API contract shared by the editor (src/editor, src/main.ts); logic without DOM is in palette-search.ts.
import type { Frame, Pack } from "../pack/loader";
import { Categories, FAVOURITES, loadCategories, parseCategories, saveCategories } from "./categories";
import { ENTRY_TYPE, setDragged } from "./drag";
import { showToast } from "./toast";
import { type GridPrefs, loadGrid, loadOpen, saveGrid, saveOpen } from "./palette-prefs";
import { ENTRY_KINDS, type EntryKind, type PaletteEntry, decalEntries, decalIconFrame, entityEntries, entityIconFrame, entryIconFrame, search, tileEntries, tileIconFrame } from "./palette-search";

/** What the mapper picked in the palette: an entity prototype, a tile to paint or a decal prototype, or nothing. */
export type PaletteChoice = { kind: "entity"; id: string } | { kind: "tile"; id: string } | { kind: "decal"; id: string } | null;

/** Frame of the icon the palette shows for an entity prototype (Icon component, else its sprite), or null. */
export function entityIcon(pack: Pack, id: string): Frame | null {
    return entityIconFrame(pack, id);
}

/** Frame of the first variant of a tile, or null. */
export function tileIcon(pack: Pack, id: string): Frame | null {
    return tileIconFrame(pack, id);
}

/** Frame of a decal prototype's sprite, or null. */
export function decalIcon(pack: Pack, id: string): Frame | null {
    return decalIconFrame(pack, id);
}

const ROW = 40;
const ICON = 32;
const OVERSCAN = 4;

const STYLE = `
.palette { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); color: var(--text); font: 13px/1.35 var(--font); }
.palette button { border: 0; background: transparent; }
.palette .pal-tabs { display: flex; gap: 4px; padding: 8px 8px 0; }
.palette .pal-tab { flex: 1; height: 28px; border-radius: var(--radius); color: var(--muted); }
.palette .pal-tab:hover { background: var(--raised); color: var(--text); }
.palette .pal-tab.active { background: var(--accent-soft); color: var(--accent-text); }
.palette .pal-searchrow { display: flex; gap: 6px; padding: 8px; }
.palette .pal-search { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--radius); background: var(--input); color: var(--muted); }
.palette .pal-search:focus-within { border-color: var(--focus); }
.palette .pal-search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); outline: none; }
.palette .pal-gridbtn { flex: none; width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); color: var(--muted); }
.palette .pal-gridbtn:hover { color: var(--text); }
.palette .pal-gridbtn[aria-pressed="true"] { color: var(--accent-text); border-color: var(--accent); }
.palette .pal-head { display: flex; align-items: center; justify-content: space-between; min-height: 22px; padding: 6px 4px 4px 14px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.palette .pal-head .pal-tools { display: flex; gap: 2px; }
.palette .pal-tool { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--radius-s); color: var(--muted); font-size: 16px; line-height: 1; }
.palette .pal-tool:hover { background: var(--raised); color: var(--text); }
.palette .pal-catwrap { flex: none; max-height: 45%; overflow-y: auto; padding: 0 6px; }
.palette .pal-folder { margin-bottom: 2px; }
.palette .pal-fhead { width: 100%; display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px; border-radius: var(--radius); color: var(--text); text-align: left; }
.palette .pal-fhead:hover, .palette .pal-fhead.drop { background: var(--raised); }
.palette .pal-fhead.drop { outline: 1px solid var(--accent); }
.palette .pal-fhead svg { flex: none; }
.palette .pal-chev { transition: transform 0.1s; }
.palette .pal-folder.open .pal-chev { transform: rotate(90deg); }
.palette .pal-fname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette .pal-count { margin-left: auto; color: var(--faint); }
.palette .pal-fbody { padding-left: 18px; }
.palette .pal-fbody.grid { display: flex; flex-wrap: wrap; }
.palette .pal-fempty { padding: 4px 8px 8px; color: var(--faint); }
.palette .pal-edit { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px; }
.palette .pal-edit input { flex: 1; min-width: 0; height: 24px; padding: 0 6px; box-sizing: border-box; border: 1px solid var(--focus); border-radius: var(--radius-s); background: var(--input); color: var(--text); outline: none; }
.palette .pal-err { padding: 0 6px 4px 28px; color: var(--danger-text); font-size: 12px; }
.palette .pal-list { position: relative; flex: 1; min-height: 0; overflow-y: auto; padding: 0 6px; outline: none; }
.palette .pal-spacer { position: relative; width: 100%; }
.palette .row { box-sizing: border-box; display: flex; align-items: center; gap: 10px; height: ${ROW}px; padding: 0 8px; border-radius: var(--radius); cursor: pointer; white-space: nowrap; overflow: hidden; }
.palette .pal-spacer .row { position: absolute; left: 0; right: 0; }
.palette .pal-fbody:not(.grid) .row { width: 100%; }
.palette .row:hover { background: var(--raised); }
.palette .row.chosen { background: var(--accent-soft); }
.palette .row.cursor { box-shadow: inset 0 0 0 1px var(--focus); }
.palette .row.missing { opacity: 0.4; cursor: default; }
.palette .row.cell { width: ${ROW}px; padding: 0; justify-content: center; gap: 0; }
.palette .pal-spacer .row.cell { right: auto; }
.palette .pal-icon { flex: none; width: ${ICON}px; height: ${ICON}px; image-rendering: pixelated; }
.palette .pal-text { min-width: 0; display: flex; flex-direction: column; line-height: 1.2; }
.palette .pal-name { overflow: hidden; text-overflow: ellipsis; }
.palette .pal-suffix { color: var(--muted); }
.palette .pal-id { font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; }
.palette .pal-star { flex: none; margin-left: auto; width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--radius-s); color: var(--faint); opacity: 0.6; }
.palette .row:hover .pal-star { opacity: 1; }
.palette .pal-star:hover { color: var(--text); }
.palette .pal-star.on { color: var(--selection); opacity: 1; }
.palette .pal-empty { padding: 12px 14px; color: var(--faint); }
.pal-menu { position: fixed; z-index: 1000; min-width: 170px; padding: 4px; background: var(--raised); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); font: 13px/1.35 var(--font); box-shadow: var(--shadow); }
.pal-menu .item { position: relative; display: flex; justify-content: space-between; gap: 16px; padding: 5px 10px; border-radius: var(--radius-s); cursor: pointer; white-space: nowrap; }
.pal-menu .item:hover { background: var(--accent-soft); }
.pal-menu .item.danger { color: var(--danger-text); }
.pal-menu .sub { position: absolute; left: 100%; top: -5px; display: none; min-width: 150px; padding: 4px; background: var(--raised); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); }
.pal-menu .sub.left { left: auto; right: 100%; }
.pal-menu .item:hover > .sub { display: block; }
.pal-menu hr { border: 0; border-top: 1px solid var(--border); margin: 4px 0; }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

const svg = (body: string, size = 14, extra = "") => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" ${extra}>${body}</svg>`;
const ICONS = {
    search: svg('<path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>', 14),
    grid: svg('<path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h3A1.5 1.5 0 0 1 7 2.5v3A1.5 1.5 0 0 1 5.5 7h-3A1.5 1.5 0 0 1 1 5.5zM2.5 2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5zm6.5.5A1.5 1.5 0 0 1 10.5 1h3A1.5 1.5 0 0 1 15 2.5v3A1.5 1.5 0 0 1 13.5 7h-3A1.5 1.5 0 0 1 9 5.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5zM1 10.5A1.5 1.5 0 0 1 2.5 9h3A1.5 1.5 0 0 1 7 10.5v3A1.5 1.5 0 0 1 5.5 15h-3A1.5 1.5 0 0 1 1 13.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5zm6.5.5A1.5 1.5 0 0 1 10.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 13.5zm1.5-.5a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5z"/>', 14),
    list: svg('<path fill-rule="evenodd" d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m-3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2m0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2m0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2"/>', 14),
    chevron: svg('<path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708"/>', 11, 'class="pal-chev"'),
    folder: svg('<path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.672a2 2 0 0 1 1.414.586l.828.828A2 2 0 0 0 9.828 3h3.982a2 2 0 0 1 1.992 2.181l-.637 7A2 2 0 0 1 13.174 14H2.826a2 2 0 0 1-1.991-1.819l-.637-7a2 2 0 0 1 .342-1.31zM2.19 4a1 1 0 0 0-.996 1.09l.637 7a1 1 0 0 0 .995.91h10.348a1 1 0 0 0 .995-.91l.637-7A1 1 0 0 0 13.81 4zm4.69-1.707A1 1 0 0 0 6.172 2H2.5a1 1 0 0 0-1 .981l.006.139q.323-.119.684-.12h5.396z"/>', 14),
    star: svg('<path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.56.56 0 0 0-.163-.505L1.71 6.745l4.052-.576a.53.53 0 0 0 .393-.288L8 2.223l1.847 3.658a.53.53 0 0 0 .393.288l4.052.575-2.906 2.77a.56.56 0 0 0-.163.506l.694 3.957-3.686-1.894a.5.5 0 0 0-.461 0z"/>', 14),
    starFill: svg('<path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/>', 14),
    more: svg('<path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3m5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3"/>', 16),
};

const KINDS: Array<[EntryKind, string]> = [
    ["entity", "Entities"],
    ["tile", "Tiles"],
    ["decal", "Decals"],
];
const KIND_ALL: Record<EntryKind, string> = { entity: "All entities", tile: "All tiles", decal: "All decals" };

/** A list row: a pack entry, or a category entry whose prototype is gone from the pack. */
interface Row extends PaletteEntry {
    missing?: boolean;
}

interface MenuItem {
    label: string;
    run?: () => void;
    sub?: MenuItem[];
    danger?: boolean;
}

/** Inline name input in the folder list: a new category (`then` runs with its name) or a rename. */
interface Editing {
    rename: string | null;
    then?: (name: string) => void;
    error: string;
}

const DRAG_TYPE = ENTRY_TYPE;
const categoryLabel = (name: string) => (name === FAVOURITES ? "Favorites" : name);

export class Palette {
    /** Called whenever the choice changes (picked, cleared, or the pack changed). */
    onChange: ((choice: PaletteChoice) => void) | null = null;
    /** Called after the categories were edited and stored. */
    onCategoriesSaved: (() => void) | null = null;
    private current: PaletteChoice = null;

    private pack: Pack | null = null;
    private all: Record<EntryKind, PaletteEntry[]> = { entity: [], tile: [], decal: [] };
    private tab: EntryKind = "entity";
    private shown: Row[] = [];
    private fork = "";
    private cats = new Categories();
    private grid: GridPrefs = loadGrid();
    private open = new Set<string>();
    private editing: Editing | null = null;
    private menu: HTMLElement | null = null;
    /** Entry of each row element (list and folders). */
    private readonly rowEntry = new WeakMap<HTMLElement, Row>();
    private folderRows: HTMLElement[] = [];
    /** Highlighted row for the keyboard, -1 for none. */
    private cursor = -1;
    /** Columns of the results list (1 in the list view). */
    private cols = 1;

    private readonly tabButtons = new Map<EntryKind, HTMLButtonElement>();
    private readonly input: HTMLInputElement;
    private readonly gridBtn: HTMLButtonElement;
    private readonly catWrap: HTMLDivElement;
    private readonly folders: HTMLDivElement;
    private readonly resultsHead: HTMLDivElement;
    private readonly list: HTMLDivElement;
    private readonly spacer: HTMLDivElement;
    private readonly empty: HTMLDivElement;
    private readonly rows = new Map<number, HTMLElement>();
    private frame = 0;

    /** Builds the palette inside `container` (it owns the container's contents and its own styles). */
    constructor(readonly container: HTMLElement) {
        addStyle();
        container.replaceChildren();
        container.classList.add("palette");

        const tabs = document.createElement("div");
        tabs.className = "pal-tabs";
        tabs.setAttribute("role", "tablist");
        for (const [kind, label] of KINDS) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "pal-tab";
            b.textContent = label;
            b.setAttribute("role", "tab");
            b.addEventListener("click", () => this.setTab(kind));
            this.tabButtons.set(kind, b);
            tabs.append(b);
        }

        const label = document.createElement("label");
        label.className = "pal-search";
        label.insertAdjacentHTML("beforeend", ICONS.search);
        this.input = document.createElement("input");
        this.input.type = "text";
        this.input.placeholder = "Search name or ID";
        this.input.setAttribute("aria-label", "Search");
        this.input.spellcheck = false;
        this.input.addEventListener("input", () => this.refilter());
        this.input.addEventListener("keydown", (e) => this.onKey(e));
        label.append(this.input);
        this.gridBtn = document.createElement("button");
        this.gridBtn.type = "button";
        this.gridBtn.className = "pal-gridbtn";
        this.gridBtn.addEventListener("click", () => this.setGrid(!this.grid[this.tab]));
        const searchRow = document.createElement("div");
        searchRow.className = "pal-searchrow";
        searchRow.append(label, this.gridBtn);

        const head = document.createElement("div");
        head.className = "pal-head";
        const tools = document.createElement("div");
        tools.className = "pal-tools";
        const add = this.tool("+", "New category");
        add.addEventListener("click", () => this.newCategory());
        const more = this.tool("", "Categories menu");
        more.innerHTML = ICONS.more;
        more.addEventListener("click", () => {
            const r = more.getBoundingClientRect();
            this.showMenu([{ label: "Export categories", run: () => this.exportFile() }, { label: "Import categories…", run: () => this.importFile() }], r.left, r.bottom + 2);
        });
        tools.append(add, more);
        head.append("Categories", tools);
        this.folders = document.createElement("div");
        this.catWrap = document.createElement("div");
        this.catWrap.className = "pal-catwrap";
        this.catWrap.append(this.folders);
        this.attachRows(this.catWrap);

        this.resultsHead = document.createElement("div");
        this.resultsHead.className = "pal-head";

        this.list = document.createElement("div");
        this.list.className = "pal-list";
        this.list.tabIndex = 0;
        this.list.addEventListener("scroll", () => this.schedule());
        this.list.addEventListener("keydown", (e) => this.onKey(e));
        this.attachRows(this.list);
        document.addEventListener("pointerdown", (e) => {
            if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.menu) this.closeMenu();
        });
        this.spacer = document.createElement("div");
        this.spacer.className = "pal-spacer";
        this.empty = document.createElement("div");
        this.empty.className = "pal-empty";
        this.list.append(this.spacer);

        container.append(tabs, searchRow, head, this.catWrap, this.resultsHead, this.list, this.empty);
        new ResizeObserver(() => this.onResize()).observe(this.list);
        this.empty.hidden = true;
        this.updateTabs();
        this.drawCats();
    }

    /** Lists the placeable entities and tiles of a build; clears the choice. */
    setPack(pack: Pack): void {
        this.pack = pack;
        this.fork = pack.manifest.fork.id;
        this.cats = loadCategories(this.fork);
        this.open = loadOpen(this.fork);
        this.editing = null;
        this.drawCats();
        this.all = { entity: entityEntries(pack), tile: tileEntries(pack), decal: decalEntries(pack) };
        this.input.value = "";
        this.refilter();
        this.clear();
    }

    get choice(): PaletteChoice {
        return this.current;
    }

    /**
     * Picks an entry from outside the palette (the decal eyedropper): it becomes the choice even when it is not
     * listed (a decal hidden from the menu). Fires `onChange`.
     */
    select(choice: NonNullable<PaletteChoice>): void {
        // show the tab of what was picked (the eyedropper can pick a tile while entities are listed)
        this.setTab(choice.kind);
        this.current = { ...choice };
        this.draw();
        this.onChange?.(this.current);
    }

    /** Clears the choice (Escape in the editor). */
    clear(): void {
        this.current = null;
        this.draw();
        this.onChange?.(null);
    }

    private tool(text: string, title: string): HTMLButtonElement {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pal-tool";
        b.textContent = text;
        b.title = title;
        b.setAttribute("aria-label", title);
        return b;
    }

    /** Click, context menu and drag of rows inside `root` (the results list or the folders). */
    private attachRows(root: HTMLElement): void {
        const rowOf = (t: EventTarget | null) => {
            const el = (t as HTMLElement).closest<HTMLElement>(".row");
            return el && this.rowEntry.has(el) ? el : null;
        };
        root.addEventListener("click", (e) => {
            const el = rowOf(e.target);
            if (!el) return;
            const entry = this.rowEntry.get(el)!;
            if ((e.target as HTMLElement).closest(".pal-star")) this.toggleFavourite(entry);
            else this.pick(entry);
        });
        root.addEventListener("contextmenu", (e) => {
            const el = rowOf(e.target);
            if (!el) return;
            e.preventDefault();
            this.rowMenu(this.rowEntry.get(el)!, e.clientX, e.clientY);
        });
        root.addEventListener("dragstart", (e) => {
            const el = rowOf(e.target);
            const r = el && this.rowEntry.get(el);
            if (!r || !e.dataTransfer) return;
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: r.kind, id: r.id }));
            e.dataTransfer.effectAllowed = "copy";
            setDragged({ kind: "entry", entry: { kind: r.kind, id: r.id } });
        });
        root.addEventListener("dragend", () => setDragged(null));
    }

    private setTab(kind: EntryKind): void {
        if (kind === this.tab) return;
        this.tab = kind;
        this.updateTabs();
        this.refilter();
        this.drawCats();
    }

    private updateTabs(): void {
        for (const [kind, b] of this.tabButtons) {
            b.classList.toggle("active", kind === this.tab);
            b.setAttribute("aria-selected", String(kind === this.tab));
        }
        const grid = this.grid[this.tab];
        this.gridBtn.setAttribute("aria-pressed", String(grid));
        const label = grid ? "List view" : "Grid view";
        this.gridBtn.title = label;
        this.gridBtn.setAttribute("aria-label", label);
        this.gridBtn.innerHTML = grid ? ICONS.list : ICONS.grid;
    }

    private setGrid(on: boolean): void {
        this.grid[this.tab] = on;
        saveGrid(this.grid);
        this.updateTabs();
        this.reload();
        this.drawCats();
    }

    private columns(): number {
        return this.grid[this.tab] ? Math.max(1, Math.floor((this.list.clientWidth - 12) / ROW)) : 1;
    }

    private onResize(): void {
        if (this.columns() !== this.cols) this.reload();
        else this.schedule();
    }

    private refilter(): void {
        const q = this.input.value;
        this.shown = search(this.all[this.tab], q);
        this.cols = this.columns();
        this.cursor = -1;
        this.list.scrollTop = 0;
        this.spacer.style.height = `${Math.ceil(this.shown.length / this.cols) * ROW}px`;
        this.empty.hidden = this.shown.length > 0;
        this.empty.textContent = this.pack ? "No results" : "No build loaded";
        this.resultsHead.textContent = q.trim() ? `Results (${this.shown.length})` : `${KIND_ALL[this.tab]} (${this.shown.length})`;
        for (const el of this.rows.values()) el.remove();
        this.rows.clear();
        this.draw();
        if (q.trim() || this.folderRows.length) this.drawCats();
    }

    private pick(e: Row): void {
        if (e.missing) return;
        const i = this.shown.indexOf(e);
        if (i >= 0) this.cursor = i;
        const same = this.current?.kind === e.kind && this.current.id === e.id;
        this.current = same ? null : ({ kind: e.kind, id: e.id } as PaletteChoice);
        this.draw();
        this.onChange?.(this.current);
    }

    private onKey(e: KeyboardEvent): void {
        const n = this.shown.length;
        const vertical = e.key === "ArrowDown" || e.key === "ArrowUp";
        const horizontal = (e.key === "ArrowLeft" || e.key === "ArrowRight") && this.cols > 1 && e.target === this.list;
        if (vertical || horizontal) {
            if (!n) return;
            e.preventDefault();
            const step = vertical ? this.cols : 1;
            const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
            this.cursor = Math.max(0, Math.min(n - 1, this.cursor < 0 ? 0 : this.cursor + dir * step));
            const top = Math.floor(this.cursor / this.cols) * ROW;
            if (top < this.list.scrollTop) this.list.scrollTop = top;
            else if (top + ROW > this.list.scrollTop + this.list.clientHeight) this.list.scrollTop = top + ROW - this.list.clientHeight;
            this.draw();
        } else if (e.key === "Enter" && this.cursor >= 0) {
            e.preventDefault();
            this.pick(this.shown[this.cursor]!);
        }
    }

    private schedule(): void {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.draw();
        });
    }

    private isChosen(e: PaletteEntry): boolean {
        return this.current?.kind === e.kind && this.current.id === e.id;
    }

    /** Creates the rows of the visible range, drops the others and refreshes the highlight. */
    private draw(): void {
        const cols = this.cols;
        const firstRow = Math.max(0, Math.floor(this.list.scrollTop / ROW) - OVERSCAN);
        const lastRow = Math.ceil((this.list.scrollTop + (this.list.clientHeight || 600)) / ROW) + OVERSCAN;
        const first = firstRow * cols;
        const last = Math.min(this.shown.length, lastRow * cols);
        for (const [i, el] of this.rows) {
            if (i < first || i >= last) {
                el.remove();
                this.rows.delete(i);
            }
        }
        for (let i = first; i < last; i++) {
            let el = this.rows.get(i);
            if (!el) {
                el = this.makeRow(this.shown[i]!, this.grid[this.tab]);
                el.style.top = `${Math.floor(i / cols) * ROW}px`;
                if (cols > 1) el.style.left = `${(i % cols) * ROW}px`;
                this.rows.set(i, el);
                this.spacer.append(el);
            }
            const e = this.shown[i]!;
            el.classList.toggle("chosen", this.isChosen(e));
            el.classList.toggle("cursor", i === this.cursor);
        }
        for (const el of this.folderRows) el.classList.toggle("chosen", this.isChosen(this.rowEntry.get(el)!));
    }

    private makeRow(e: Row, cell: boolean): HTMLElement {
        const row = document.createElement("div");
        row.className = "row";
        this.rowEntry.set(row, e);
        row.title = e.missing ? `${e.id} (missing)` : cell ? `${e.name}${e.suffix ? ` ${e.suffix}` : ""}\n${e.id}` : e.id;
        row.draggable = !e.missing;
        row.classList.toggle("missing", !!e.missing);
        row.classList.toggle("cell", cell);

        const icon = document.createElement("canvas");
        icon.className = "pal-icon";
        icon.width = icon.height = ICON;
        this.paintIcon(icon, e);
        row.append(icon);
        if (cell) return row;

        const text = document.createElement("div");
        text.className = "pal-text";
        const name = document.createElement("div");
        name.className = "pal-name";
        name.textContent = e.name;
        if (e.suffix) {
            const s = document.createElement("span");
            s.className = "pal-suffix";
            s.textContent = ` ${e.suffix}`;
            name.append(s);
        }
        const id = document.createElement("div");
        id.className = "pal-id";
        id.textContent = e.id;
        text.append(name, id);
        row.append(text);
        if (!e.missing) {
            const on = this.cats.has(FAVOURITES, e);
            const star = document.createElement("button");
            star.type = "button";
            star.className = "pal-star";
            star.classList.toggle("on", on);
            star.title = on ? "Remove from favorites" : "Add to favorites";
            star.setAttribute("aria-label", star.title);
            star.innerHTML = on ? ICONS.starFill : ICONS.star;
            row.append(star);
        }
        return row;
    }

    // --- categories ---

    /** Entries of a category as rows; prototypes missing from the pack become dimmed placeholders. */
    private categoryRows(name: string): Row[] {
        const known = new Map<string, PaletteEntry>();
        for (const kind of ENTRY_KINDS) for (const e of this.all[kind]) known.set(`${kind}:${e.id}`, e);
        const rows: Row[] = [];
        for (const c of this.cats.entries(name) ?? []) {
            const e = known.get(`${c.kind}:${c.id}`);
            if (e) rows.push(e);
            else {
                const lid = c.id.toLowerCase();
                rows.push({ kind: c.kind, id: c.id, name: c.id, suffix: "", lid, lname: lid, hay: lid, missing: true });
            }
        }
        return rows;
    }

    private changed(): void {
        saveCategories(this.fork, this.cats);
        this.drawCats();
        this.reload();
        this.onCategoriesSaved?.();
    }

    /** Categories of these builds were replaced in storage (synced from the account): shows the new ones. */
    reloadCategories(forks: readonly string[]): void {
        if (!this.fork || !forks.includes(this.fork)) return;
        this.cats = loadCategories(this.fork);
        this.editing = null;
        this.drawCats();
        this.reload();
    }

    /** Rebuilds the list keeping the scroll position. */
    private reload(): void {
        const top = this.list.scrollTop;
        this.refilter();
        this.list.scrollTop = top;
        this.draw();
    }

    private toggleOpen(name: string): void {
        if (!this.open.delete(name)) this.open.add(name);
        saveOpen(this.fork, this.open);
        this.drawCats();
    }

    private drawCats(): void {
        const q = this.input.value.trim();
        const cell = this.grid[this.tab];
        this.folderRows = [];
        const out: HTMLElement[] = [];
        for (const name of [FAVOURITES, ...this.cats.names]) {
            if (this.editing && this.editing.rename === name) {
                out.push(this.editor(this.editing));
                continue;
            }
            const rows = q ? search(this.categoryRows(name), q) : this.categoryRows(name);
            const isOpen = this.open.has(name);
            const folder = document.createElement("div");
            folder.className = "pal-folder";
            folder.classList.toggle("open", isOpen);
            folder.dataset.cat = name;
            const head = document.createElement("button");
            head.type = "button";
            head.className = "pal-fhead";
            head.setAttribute("aria-expanded", String(isOpen));
            head.insertAdjacentHTML("beforeend", ICONS.chevron + (name === FAVOURITES ? ICONS.starFill.replace('fill="currentColor"', 'fill="var(--selection)"') : ICONS.folder));
            const label = document.createElement("span");
            label.className = "pal-fname";
            label.textContent = categoryLabel(name);
            const count = document.createElement("span");
            count.className = "pal-count";
            count.textContent = String(rows.length);
            head.append(label, count);
            head.addEventListener("click", () => this.toggleOpen(name));
            if (name !== FAVOURITES) {
                head.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    this.categoryMenu(name, e.clientX, e.clientY);
                });
            }
            head.addEventListener("dragover", (e) => {
                if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
                e.preventDefault();
                head.classList.add("drop");
            });
            head.addEventListener("dragleave", () => head.classList.remove("drop"));
            head.addEventListener("drop", (e) => {
                head.classList.remove("drop");
                e.preventDefault();
                const entry = parseEntry(e.dataTransfer?.getData(DRAG_TYPE));
                if (entry && this.cats.add(name, entry)) this.changed();
            });
            folder.append(head);
            if (isOpen) {
                const body = document.createElement("div");
                body.className = "pal-fbody";
                body.classList.toggle("grid", cell);
                if (!rows.length) {
                    const none = document.createElement("div");
                    none.className = "pal-fempty";
                    none.textContent = q ? "No results" : name === FAVOURITES ? "No favorites" : "Empty";
                    body.append(none);
                }
                for (const r of rows) {
                    const el = this.makeRow(r, cell);
                    this.folderRows.push(el);
                    body.append(el);
                }
                folder.append(body);
            }
            out.push(folder);
        }
        if (this.editing && this.editing.rename === null) out.push(this.editor(this.editing));
        this.folders.replaceChildren(...out);
        this.draw();
        this.focusEditor();
    }

    private editor(state: Editing): HTMLElement {
        const wrap = document.createElement("div");
        wrap.className = "pal-editwrap";
        const row = document.createElement("div");
        row.className = "pal-edit";
        row.insertAdjacentHTML("beforeend", ICONS.folder);
        const input = document.createElement("input");
        input.type = "text";
        input.value = state.rename ?? "";
        input.placeholder = "Category name";
        input.setAttribute("aria-label", state.rename === null ? "New category name" : "Category name");
        input.spellcheck = false;
        const err = document.createElement("div");
        err.className = "pal-err";
        err.setAttribute("role", "alert");
        err.textContent = state.error;
        err.hidden = !state.error;
        input.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
                e.preventDefault();
                this.endEdit(state);
            } else if (e.key === "Enter") {
                e.preventDefault();
                const name = input.value.trim();
                const problem = this.cats.nameError(name, state.rename ?? undefined);
                if (problem) {
                    state.error = problem;
                    err.textContent = problem;
                    err.hidden = false;
                    return;
                }
                this.endEdit(state);
                if (state.rename !== null) {
                    if (name !== state.rename) this.cats.rename(state.rename, name);
                    if (this.open.delete(state.rename)) this.open.add(name);
                    saveOpen(this.fork, this.open);
                } else {
                    this.cats.create(name);
                    this.open.add(name);
                    saveOpen(this.fork, this.open);
                    state.then?.(name);
                }
                this.changed();
            }
        });
        input.addEventListener("input", () => {
            if (!state.error) return;
            state.error = "";
            err.hidden = true;
        });
        input.addEventListener("blur", () => this.endEdit(state));
        row.append(input);
        wrap.append(row, err);
        return wrap;
    }

    private endEdit(state: Editing): void {
        if (this.editing !== state) return;
        this.editing = null;
        this.drawCats();
    }

    private focusEditor(): void {
        if (!this.editing) return;
        const input = this.folders.querySelector<HTMLInputElement>(".pal-edit input");
        input?.focus();
        input?.select();
    }

    private toggleFavourite(e: PaletteEntry): void {
        this.cats.toggleFavourite(e);
        this.changed();
    }

    /** Opens the inline input for a new category; `then` runs with the name once it is created. */
    private newCategory(then?: (name: string) => void): void {
        this.closeMenu();
        this.editing = { rename: null, then, error: "" };
        this.catWrap.scrollTop = this.catWrap.scrollHeight;
        this.drawCats();
        this.catWrap.scrollTop = this.catWrap.scrollHeight;
    }

    private rowMenu(e: Row, x: number, y: number): void {
        const items: MenuItem[] = [];
        if (!e.missing) {
            const fav = this.cats.has(FAVOURITES, e);
            items.push({ label: fav ? "Remove from favorites" : "Add to favorites", run: () => this.toggleFavourite(e) });
            const sub: MenuItem[] = this.cats.names.filter((n) => !this.cats.has(n, e)).map((name) => ({ label: name, run: () => this.addTo(name, e) }));
            sub.push({ label: "New category…", run: () => this.newCategory((name) => this.addTo(name, e)) });
            items.push({ label: "Add to", sub });
        }
        const from = this.cats.containing(e);
        if (from.length) {
            items.push({ label: "-" });
            for (const name of from) items.push({ label: `Remove from ${categoryLabel(name)}`, run: () => this.removeFrom(name, e) });
        }
        this.showMenu(items, x, y);
    }

    private addTo(name: string, e: PaletteEntry): void {
        if (this.cats.add(name, e)) this.changed();
    }

    private removeFrom(name: string, e: PaletteEntry): void {
        if (this.cats.remove(name, e)) this.changed();
    }

    private categoryMenu(name: string, x: number, y: number): void {
        this.showMenu(
            [
                {
                    label: "Rename",
                    run: () => {
                        this.editing = { rename: name, error: "" };
                        this.drawCats();
                    },
                },
                { label: "Delete", danger: true, run: () => this.deleteCategory(name) },
            ],
            x,
            y,
        );
    }

    private deleteCategory(name: string): void {
        const snap = this.cats.snapshot(name);
        if (!snap || !this.cats.delete(name)) return;
        this.changed();
        showToast(`Deleted category "${name}"`, {
            label: "Undo",
            run: () => {
                if (this.cats.restore(snap)) this.changed();
                else showToast(`Could not restore "${name}"`);
            },
        });
    }

    private showMenu(items: MenuItem[], x: number, y: number): void {
        this.closeMenu();
        const build = (list: MenuItem[], into: HTMLElement) => {
            for (const it of list) {
                if (it.label === "-") {
                    into.append(document.createElement("hr"));
                    continue;
                }
                const d = document.createElement("div");
                d.className = it.danger ? "item danger" : "item";
                const text = document.createElement("span");
                text.textContent = it.label;
                d.append(text);
                if (it.sub) {
                    d.append("▸");
                    const sub = document.createElement("div");
                    sub.className = "sub";
                    build(it.sub, sub);
                    d.append(sub);
                } else {
                    d.addEventListener("click", (e) => {
                        e.stopPropagation();
                        this.closeMenu();
                        it.run?.();
                    });
                }
                into.append(d);
            }
        };
        const m = document.createElement("div");
        m.className = "pal-menu";
        build(items, m);
        m.addEventListener("contextmenu", (e) => e.preventDefault());
        document.body.append(m);
        m.style.left = `${Math.max(0, Math.min(x, innerWidth - m.offsetWidth))}px`;
        m.style.top = `${Math.max(0, Math.min(y, innerHeight - m.offsetHeight))}px`;
        if (x + m.offsetWidth + 160 > innerWidth) for (const s of m.querySelectorAll(".sub")) s.classList.add("left");
        this.menu = m;
    }

    private closeMenu(): void {
        this.menu?.remove();
        this.menu = null;
    }

    private exportFile(): void {
        const url = URL.createObjectURL(new Blob([this.cats.toJSON()], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `palette-categories-${this.fork || "build"}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    private importFile(): void {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) return;
            const parsed = parseCategories(await file.text());
            if (!parsed) return void showToast("Could not import categories");
            this.cats.merge(parsed);
            this.changed();
            showToast("Categories imported");
        });
        input.click();
    }

    /** Draws the icon from its texture page once the page is loaded (each page is fetched once by the pack). */
    private paintIcon(canvas: HTMLCanvasElement, e: PaletteEntry): void {
        const pack = this.pack;
        if (!pack) return;
        const f = entryIconFrame(pack, e.kind, e.id);
        if (!f) return;
        const [page, x, y, w, h] = f;
        pack.page(page).then(
            (bmp) => {
                if (this.pack !== pack) return;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                ctx.imageSmoothingEnabled = false;
                // Whole-number scale for small sprites keeps pixels crisp; large ones shrink to fit.
                const fit = ICON / Math.max(w, h);
                const scale = fit >= 1 ? Math.floor(fit) : fit;
                const dw = Math.round(w * scale);
                const dh = Math.round(h * scale);
                ctx.drawImage(bmp, x, y, w, h, Math.floor((ICON - dw) / 2), Math.floor((ICON - dh) / 2), dw, dh);
            },
            () => {},
        );
    }
}

function parseEntry(text: string | undefined): { kind: EntryKind; id: string } | null {
    try {
        const v = JSON.parse(text ?? "") as { kind?: unknown; id?: unknown };
        return ENTRY_KINDS.includes(v.kind as EntryKind) && typeof v.id === "string" ? { kind: v.kind as EntryKind, id: v.id } : null;
    } catch {
        return null;
    }
}
