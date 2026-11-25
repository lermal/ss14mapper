// Dialogs of the map library and new maps: New map, Save as (a name), and Manage library (open, rename and delete
// maps kept in this browser).
import { t as translate } from "../i18n";
import { MAX_FLOOR_SIDE, newMapText, startingFloors, type NewMapKind } from "../map/new-map";
import type { Pack } from "../pack/loader";
import { dialog } from "./dialog";
import { button, h } from "./icons";
import { formatSize, formatWhen, mapFileName, usedBytes, type LibraryEntry, type MapLibrary } from "./library";
import type { Fork } from "./shell";
import { showToast } from "./toast";

const STYLE = `
.dlg .md-section { margin: 0; padding: 0; border: 0; min-width: 0; }
.dlg .md-section + .md-section { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--border); }
.dlg .md-section legend { float: left; width: 100%; padding: 0; margin-bottom: 12px; font-weight: 600; }
.dlg .md-section > .md-content { clear: both; }
.dlg .md-section .dlg-field { margin: 0; gap: 6px; min-width: 0; }
.dlg .md-section input, .dlg .md-section select { width: 100%; min-width: 0; }
.dlg .md-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-top: 16px; }
.dlg .md-seg { display: flex; gap: 2px; min-height: 32px; }
.dlg .md-seg button { flex: 1; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; border-radius: 2px 2px 0 0; background: transparent; color: var(--muted); }
.dlg .md-seg button:hover { background: var(--raised); }
.dlg .md-seg button[aria-pressed="true"] { background: var(--accent-soft); border-bottom-color: var(--accent-text); color: var(--text); }
.dlg .md-hint { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.dlg .md-floor { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; color: var(--text-2); }
.dlg .md-floor input { width: auto; margin: 0; }
.dlg .md-floor-fields.off { opacity: 0.5; }
@media (max-width: 480px) {
  .dlg .md-map-pair { grid-template-columns: minmax(0, 1fr); }
}
.dlg .lib-list { display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow-y: auto; margin-top: 8px; }
.dlg .lib-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.dlg .lib-row .lib-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dlg .lib-row .lib-name { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dlg .lib-row .lib-meta { color: var(--muted); font-size: 12px; }
.dlg .lib-row .lib-badge { margin-left: 6px; padding: 0 6px; border-radius: var(--radius-s); background: var(--accent-soft); color: var(--accent-text); font-size: 11px; font-weight: 600; }
.dlg .lib-row input[type=text] { height: 26px; box-sizing: border-box; padding: 0 6px; border: 1px solid var(--focus); border-radius: var(--radius-s); background: var(--input); color: var(--text); }
.dlg .lib-row .lib-error { color: var(--danger-text); font-size: 12px; }
.dlg .lib-row button.btn { height: 26px; padding: 0 10px; }
.dlg .lib-empty { padding: 14px; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--muted); }
.dlg .lib-foot { margin-top: 10px; color: var(--muted); font-size: 12px; }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

function field(label: string, control: HTMLElement, cls = ""): HTMLElement {
    const l = h("label", `dlg-field${cls ? ` ${cls}` : ""}`);
    l.append(label, control);
    return l;
}

function textInput(value: string): HTMLInputElement {
    const i = h("input");
    i.type = "text";
    i.value = value;
    i.spellcheck = false;
    i.autocomplete = "off";
    return i;
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
    const i = h("input");
    i.type = "number";
    i.value = String(value);
    i.min = String(min);
    i.max = String(max);
    i.step = "1";
    return i;
}

/** Why a typed map name cannot be used, or "" when it can; `taken` tells names already in the library. */
export function nameProblem(typed: string, taken: (file: string) => boolean): string {
    const file = mapFileName(typed);
    if (!file) return translate("Enter a name");
    if (taken(file)) return translate("{{1}} already exists", { 1: file });
    return "";
}

/** Asks for a map name (Save as); resolves with the file name, or null when cancelled. */
export function askMapName(title: string, initial: string, confirm: string, taken: (file: string) => boolean): Promise<string | null> {
    addStyle();
    const input = textInput(initial);
    input.dataset.autofocus = "";
    const error = h("p", "dlg-error");
    input.addEventListener("input", () => (error.textContent = ""));
    return dialog<string | null>(
        title,
        [field(translate("Name"), input), error],
        [
            { label: translate("Cancel"), value: null, spaceAfter: true },
            { label: confirm, value: "ok", kind: "primary" },
        ],
        null,
        {
            check: () => {
                error.textContent = nameProblem(input.value, taken);
                return !error.textContent;
            },
        },
    ).then((v) => (v === null ? null : mapFileName(input.value)));
}

export interface NewMapResult {
    /** File name, e.g. "Tug.yml". */
    file: string;
    build: string;
    text: string;
}

export interface NewMapSetup {
    forks: Fork[];
    build: string;
    loadPack(build: string): Promise<Pack>;
    taken(file: string): boolean;
}

const KINDS: ReadonlyArray<[NewMapKind, string, string, string]> = [
    ["shuttle", translate("Shuttle"), "", translate("New shuttle")],
    ["map", translate("Map"), "", translate("New map")],
];
const MAX_SIDE = MAX_FLOOR_SIDE;

/** New map: type, name, build and a starting floor; resolves with the new file's text, or null when cancelled. */
export function newMapDialog(setup: NewMapSetup): Promise<NewMapResult | null> {
    addStyle();
    let kind: NewMapKind = "shuttle";
    const seg = h("div", "md-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", translate("Type"));
    const name = textInput(KINDS[0]![3]);
    name.dataset.autofocus = "";
    let named = false;
    name.addEventListener("input", () => {
        named = true;
        error.textContent = "";
    });
    const kindButtons = KINDS.map(([k, label]) => {
        const b = button("", label, "", () => setKind(k));
        b.dataset.kind = k;
        seg.append(b);
        return b;
    });
    const setKind = (k: NewMapKind) => {
        kind = k;
        const def = KINDS.find((d) => d[0] === k)!;
        kindButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === k)));
        if (!named) name.value = def[3];
    };
    setKind("shuttle");

    const build = h("select");
    for (const f of setup.forks) build.add(new Option(f.name, f.id));
    build.value = setup.build;

    const floorOn = h("input");
    floorOn.type = "checkbox";
    floorOn.checked = true;
    const floorLabel = h("label", "md-floor");
    floorLabel.append(floorOn, translate("Add a starting floor"));
    const tile = h("select");
    const width = numberInput(5, 1, MAX_SIDE), height = numberInput(5, 1, MAX_SIDE);
    const floorFields = h("div", "md-floor-fields");
    const dimensions = h("div", "md-pair");
    dimensions.append(field(translate("Width (tiles)"), width), field(translate("Height (tiles)"), height));
    floorFields.append(field(translate("Tile"), tile), dimensions);
    floorOn.addEventListener("change", () => {
        floorFields.classList.toggle("off", !floorOn.checked);
        for (const c of [width, height]) c.disabled = !floorOn.checked;
        tile.disabled = !floorOn.checked || !pack;
    });

    const error = h("p", "dlg-error");
    error.setAttribute("role", "alert");
    let pack: Pack | null = null;
    let loadError = "";
    let packFor = "";
    const loadTiles = async () => {
        const id = build.value;
        packFor = id;
        pack = null;
        loadError = "";
        tile.replaceChildren(new Option(translate("Loading…"), ""));
        tile.disabled = true;
        try {
            const p = await setup.loadPack(id);
            if (packFor !== id) return;
            pack = p;
            // the usual floors first, then every other tile of the build
            const usual = startingFloors(p);
            const rest = Object.keys(p.prototypes.tiles).filter((t) => t !== "Space" && !usual.includes(t)).sort((a, b) => a.localeCompare(b));
            const ids = [...usual, ...rest];
            const keep = tile.dataset.chosen;
            const others = h("optgroup");
            others.label = translate("Other");
            others.append(...rest.map((t) => new Option(t, t)));
            tile.replaceChildren(...usual.map((t) => new Option(t, t)), ...(rest.length ? [others] : []));
            tile.value = keep && ids.includes(keep) ? keep : ids.includes("Plating") ? "Plating" : ids[0] ?? "";
            tile.disabled = !floorOn.checked;
        } catch (e) {
            if (packFor !== id) return;
            tile.replaceChildren(new Option(translate("Not available"), ""));
            error.textContent = loadError = translate("Could not load {{1}}: {{2}}", { 1: build.selectedOptions[0]?.text ?? id, 2: (e as Error).message });
        }
    };
    tile.addEventListener("change", () => (tile.dataset.chosen = tile.value));
    build.addEventListener("change", () => {
        error.textContent = "";
        void loadTiles();
    });
    void loadTiles();

    let result: NewMapResult | null = null;
    const check = (): boolean => {
        error.textContent = nameProblem(name.value, setup.taken);
        if (error.textContent) return false;
        if (!pack) {
            error.textContent = loadError || translate("Build is loading");
            return false;
        }
        let floor: { tile: string; width: number; height: number } | undefined;
        if (floorOn.checked) {
            const w = Number(width.value), hgt = Number(height.value);
            const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_SIDE;
            if (!ok(w) || !ok(hgt)) {
                error.textContent = translate("Width and height must be 1 to {{1}}", { 1: MAX_SIDE });
                return false;
            }
            if (!tile.value) {
                error.textContent = translate("Choose a floor tile");
                return false;
            }
            floor = { tile: tile.value, width: w, height: hgt };
        }
        const file = mapFileName(name.value);
        try {
            const text = newMapText({ kind, name: name.value.trim().replace(/\.ya?ml$/i, ""), pack, ...(floor ? { floor } : {}) });
            result = { file, build: build.value, text };
            return true;
        } catch (e) {
            error.textContent = translate("Could not create map: {{1}}", { 1: (e as Error).message });
            return false;
        }
    };
    const typeField = h("div", "dlg-field");
    typeField.append(translate("Type"), seg);
    const mapSection = h("fieldset", "md-section");
    const mapFields = h("div", "md-content");
    const mapPair = h("div", "md-pair md-map-pair");
    mapPair.append(typeField, field(translate("Build"), build));
    mapFields.append(field(translate("Name"), name), mapPair);
    mapSection.append(h("legend", "", translate("Map settings")), mapFields);
    const floorSection = h("fieldset", "md-section");
    const floorContent = h("div", "md-content");
    floorContent.append(floorLabel, floorFields);
    floorSection.append(h("legend", "", translate("Starting floor")), floorContent);
    return dialog<"create" | null>(
        translate("New map"),
        [mapSection, floorSection, error],
        [
            { label: translate("Cancel"), value: null, spaceAfter: true },
            { label: translate("Create"), value: "create", kind: "primary" },
        ],
        null,
        { check, width: 520 },
    ).then((v) => (v === "create" ? result : null));
}

export interface LibraryDialogHooks {
    library: MapLibrary;
    /** The library record of the open map (it cannot be deleted while open). */
    openId: string | null;
    forkName(id: string): string;
    open(id: string): void;
    /** A record was renamed, deleted or restored. */
    changed(entry: { id: string; name?: string }): void;
}

/** Manage library: every map kept in this browser with its size, date and build; open, rename, delete. */
export async function manageLibrary(hooks: LibraryDialogHooks): Promise<void> {
    addStyle();
    const { library } = hooks;
    const list = h("div", "lib-list");
    const foot = h("p", "lib-foot");
    let entries: LibraryEntry[] = [];
    let close: (v: void) => void = () => {};

    const render = async () => {
        entries = await library.list();
        if (!entries.length) list.replaceChildren(h("div", "lib-empty", translate("No maps")));
        else list.replaceChildren(...entries.map(row));
        const maps = `${entries.length} ${entries.length === 1 ? "map" : "maps"}, ${formatSize(usedBytes(entries))}`;
        foot.textContent = `${maps}`;
        try {
            const est = await navigator.storage?.estimate?.();
            if (est?.usage !== undefined && est.quota) foot.textContent += translate(". Storage: {{1}} of {{2}}", { 1: formatSize(est.usage), 2: formatSize(est.quota) });
        } catch {
            // no estimate
        }
    };

    const row = (e: LibraryEntry): HTMLElement => {
        const r = h("div", "lib-row");
        r.dataset.id = e.id;
        const text = h("div", "lib-text");
        const nameEl = h("span", "lib-name", e.name);
        nameEl.title = e.name;
            if (e.id === hooks.openId) nameEl.append(h("span", "lib-badge", translate("library.openBadge")));
        text.append(nameEl, h("span", "lib-meta", `${hooks.forkName(e.build)} · ${formatWhen(e.savedAt)} · ${formatSize(e.size)}`));
        const openBtn = button("btn", translate("Open"), translate("Open {{1}}", { 1: e.name }), () => {
            close();
            hooks.open(e.id);
        });
        const renameBtn = button("btn", translate("Rename"), "", () => rename(e, r, text));
        const del = button("btn danger", translate("Delete"), e.id === hooks.openId ? translate("Open in the editor") : translate("Delete"), () => void remove(e));
        del.disabled = e.id === hooks.openId;
        r.append(text, openBtn, renameBtn, del);
        return r;
    };

    const rename = (e: LibraryEntry, r: HTMLElement, text: HTMLElement) => {
        const input = textInput(e.name);
        const err = h("span", "lib-error");
        const box = h("div", "lib-text");
        box.append(input, err);
        text.replaceWith(box);
        for (const b of r.querySelectorAll("button")) b.hidden = true;
        const save = button("btn primary", translate("Save"), "", () => void commit());
        const cancel = button("btn", translate("Cancel"), "", () => void render());
        r.append(save, cancel);
        input.focus();
        input.select();
        const commit = async () => {
            const problem = nameProblem(input.value, (f) => f !== e.name && entries.some((o) => o.name === f));
            if (problem) {
                err.textContent = problem;
                return;
            }
            const file = mapFileName(input.value);
            if (file !== e.name && (await library.update(e.id, { name: file }))) hooks.changed({ id: e.id, name: file });
            await render();
        };
        input.addEventListener("keydown", (k) => {
            if (k.key === "Enter") {
                k.preventDefault();
                void commit();
            } else if (k.key === "Escape") {
                // ends the rename, not the dialog
                k.preventDefault();
                k.stopPropagation();
                void render();
            }
        });
    };

    const remove = async (e: LibraryEntry) => {
        const gone = await library.remove(e.id);
        if (!gone) return showToast(translate("Could not delete {{1}}", { 1: e.name }));
        hooks.changed({ id: e.id });
        await render();
        showToast(translate("Deleted {{1}}", { 1: e.name }), {
            label: translate("Undo"),
            run: () =>
                void library.restore(gone).then(async (ok) => {
                    if (!ok) return showToast(translate("Could not restore {{1}}", { 1: e.name }));
                    hooks.changed({ id: e.id, name: gone.name });
                    if (list.isConnected) await render();
                }),
        }, 8000);
    };

    await render();
    await dialog<void>(translate("Library"), [list, foot], [{ label: translate("Close"), value: undefined, kind: "primary" }], undefined, {
        width: 620,
        bind: (c) => (close = c),
    });
}
