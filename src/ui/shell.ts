// The editor shell around the map: top bar (menus, map name, build, undo and redo, Save), options bar,
// tool rail, status bar, and the Layers and zoom controls on the map. It draws the controller's state on every
// refresh (cheaply: only what changed is touched) and turns clicks into controller commands.
import { language, languages, t as translate } from "../i18n";
import { LAYERS, type EditorController, type Layer } from "../editor/controller";
import { describeChord, type Keymap } from "../editor/keymap";
import { MenuBar, popupMenu, type MenuItem, type MenuDef } from "./menus";
import { creditLink } from "./credit";
import { button, h, icon, ICON } from "./icons";
import { MARQUEE_SHAPES, OptionsBar, SHAPE_KINDS, TOOLS } from "./options-bar";
import type { NetworkFilter } from "../editor/node-overlay";

export interface Fork {
    id: string;
    name: string;
    /** The build's repository, for the link to its source. */
    repo?: string;
    /** URL of the pack's directory, ending with a slash. */
    pack: string;
}

export interface ShellHooks {
    setFork(id: string): void;
    /** Maps of the library for File > Open recent, newest first. */
    recent(): MenuItem[];
    /** Manage library. */
    library(): void;
    settings(): void;
    panels(): MenuItem[];
    shortcuts(): void;
    about(): void;
    setLanguage(code: string): void;
    /** File > Add a build…; absent without accounts. */
    addBuild?(): void;
    /** Help > Send feedback…; absent without accounts. */
    reportBug?(): void;
}

const LAYER_DEFS: ReadonlyArray<[Layer, string, string]> = [
    ["subfloor", translate("Subfloor"), "view.subfloor"],
    ["markers", translate("Markers"), "view.markers"],
    ["powered", translate("Powered"), "view.powered"],
    ["grid", translate("Tile grid"), "view.grid"],
    ["centre", translate("Center of mass"), "view.centre"],
    ["direction", translate("Heading"), "view.direction"],
    ["links", translate("Device links"), "view.links"],
    ["configuratorLinks", translate("Network configurator links"), "view.configuratorLinks"],
    ["nodes", translate("Node networks"), "view.nodes"],
    ["decals", translate("Decals"), "view.decals"],
    ["parallax", translate("Parallax"), "view.parallax"],
];

const STYLE = `
.app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; overflow: hidden; background: var(--bg); color: var(--text); }
.topbar { display: flex; align-items: center; gap: 4px; height: 36px; flex: none; padding: 0 8px; box-sizing: border-box; background: var(--panel); border-bottom: 1px solid var(--border); white-space: nowrap; overflow-x: auto; scrollbar-width: thin; }
.topbar .tb-brand { display: flex; align-items: center; gap: 8px; padding-right: 10px; font-weight: 600; }
.topbar .tb-menu { height: 30px; padding: 0 10px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text); }
.topbar .tb-menu:hover, .topbar .tb-menu[aria-expanded="true"] { background: var(--raised); }
.topbar .tb-centre { flex: 1; min-width: 0; display: flex; justify-content: flex-start; align-items: center; gap: 10px; padding-left: 14px; margin-left: 8px; border-left: 1px solid var(--border); }
.topbar .tb-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
.topbar .tb-dot { width: 8px; height: 8px; border-radius: 4px; background: var(--warn); flex: none; }
.topbar .tb-build { height: 24px; display: inline-flex; align-items: center; padding: 0 8px; border: 0; border-radius: 0; color: var(--muted); font-size: 12px; white-space: nowrap; }
.topbar .tb-fork { height: 28px; padding: 0 28px 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); color: var(--text); appearance: none; -webkit-appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23c9d1dc' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
.topbar .tb-icon { width: 32px; height: 30px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text); display: grid; place-items: center; }
.topbar .tb-icon:hover:not(:disabled) { background: var(--raised); }
.topbar .tb-icon:disabled { color: var(--faint); cursor: default; }
.topbar .tb-sep { width: 1px; height: 22px; background: var(--border); margin: 0 6px; }
.topbar .tb-save { height: 28px; padding: 0 10px; border: 0; border-radius: 2px; background: transparent; color: var(--text); font-weight: 500; }
.topbar .tb-save:hover:not(:disabled) { background: var(--raised); }
.topbar .tb-save:disabled { opacity: 0.5; cursor: default; }
.workspace { flex: 1; display: flex; min-height: 0; }
.rail { width: 44px; flex: none; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 0; overflow-y: auto; scrollbar-width: thin; box-sizing: border-box; background: var(--panel); border-right: 1px solid var(--border); }
.rail .rl-gap { width: 28px; height: 1px; background: var(--border); margin: 4px 0; }
.rail .rl-tool { position: relative; width: 36px; height: 36px; flex: none; border-radius: 2px; display: grid; place-items: center; border: 1px solid transparent; background: transparent; color: var(--text-2); }
.rail .rl-tool:hover { background: var(--raised); }
.rail .rl-tool[aria-pressed="true"] { border-color: transparent; border-left-color: var(--accent-text); background: var(--accent-soft); color: var(--text); }
.rail .rl-flyout { position: absolute; right: 3px; bottom: 3px; width: 0; height: 0; border-left: 5px solid transparent; border-bottom: 5px solid var(--muted); }
.palette-col { width: 288px; flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--panel); border-right: 1px solid var(--border); }
.view { position: relative; flex: 1; min-width: 0; overflow: hidden; background: var(--map-bg); }
.view canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.view #overlay, .view #parallax { pointer-events: none; }
.properties { width: 300px; flex: none; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; background: var(--panel); border-left: 1px solid var(--border); }
.properties > * { flex: none; }
.properties > #inspector { flex: 1; min-height: 0; }
.map-controls { position: absolute; right: 14px; bottom: 14px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.map-controls .mc-layers { width: 236px; padding: 8px; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--radius-l); background: var(--panel); box-shadow: var(--shadow); }
.map-controls .mc-layers label { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px; border-radius: var(--radius-s); cursor: pointer; }
.map-controls .mc-layers label:hover { background: var(--raised); }
.map-controls .mc-layers .mc-key { margin-left: auto; color: var(--muted); font-size: 11px; }
.map-controls .mc-bar { display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.map-controls .mc-networks { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; padding: 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); }
.map-controls .mc-networks label { display: flex; align-items: center; gap: 8px; }
.map-controls .mc-networks select { padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); color: var(--text); }
.map-controls .mc-network-status { color: var(--muted); font-size: 12px; }
.map-controls .mc-bar button { height: 28px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text); }
.map-controls .mc-bar button:hover { background: var(--raised); }
.map-controls .mc-bar .mc-zoom { width: 30px; font-size: 15px; }
.map-controls .mc-bar .mc-fit { padding: 0 8px; }
.map-controls .mc-bar .mc-toggle { display: flex; align-items: center; gap: 6px; padding: 0 10px; }
.map-controls .mc-bar .mc-toggle[aria-expanded="true"] { background: var(--accent-soft); color: #fff; }
.map-controls .mc-bar .mc-sep { width: 1px; height: 20px; background: var(--border); margin: 0 2px; }
.map-controls .mc-bar .mc-pct { min-width: 48px; text-align: center; font-variant-numeric: tabular-nums; }
.statusbar { display: flex; align-items: center; gap: 12px; height: 28px; flex: none; padding: 0 12px; box-sizing: border-box; background: var(--panel); border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; }
.statusbar .sb-build { color: var(--muted); text-decoration: none; }
.statusbar .sb-build[href]:hover { color: var(--accent-text); text-decoration: underline; }
.statusbar .sb-credit { flex: none; margin-left: auto; color: var(--muted); font-weight: 400; text-decoration: none; }
.statusbar .sb-credit:hover { color: var(--text); }
.statusbar .sb-cursor { font-family: var(--mono); min-width: 165px; white-space: pre; }
.statusbar .sb-hint { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.statusbar .sb-missing { display: flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border: 1px solid #5a4a22; border-radius: var(--radius-s); background: #2a2416; color: var(--warn); font-size: 12px; }
.sb-list { position: fixed; z-index: 1500; width: 360px; max-height: 50vh; display: flex; flex-direction: column; background: var(--raised); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); font-size: 12px; }
.sb-list .sl-head { padding: 8px 10px; border-bottom: 1px solid var(--border); color: var(--text-2); font-weight: 600; }
.sb-list .sl-body { overflow-y: auto; padding: 6px 10px; font-family: var(--mono); color: var(--muted); white-space: pre; }
@media (max-width: 1100px) {
  .palette-col { width: 240px; }
  .properties { width: 260px; }
  .topbar .tb-brand { font-size: 12px; padding-right: 4px; }
  .topbar .tb-menu { padding: 0 8px; }
  .topbar .tb-centre { justify-content: flex-start; }
  .topbar .tb-build { display: none; }
  .statusbar { gap: 12px; }
  .statusbar .sb-credit { display: none; }
}
@media (pointer: coarse) {
  .rail { width: 56px; }
  .rail .rl-tool { width: 44px; height: 44px; }
  .topbar .tb-icon, .map-controls .mc-bar button { min-width: 44px; min-height: 44px; }
}

`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

export class Shell {
    readonly forkSelect: HTMLSelectElement;
    private readonly name: HTMLElement;
    private readonly dot: HTMLElement;
    private readonly undoBtn: HTMLButtonElement;
    private readonly redoBtn: HTMLButtonElement;
    private readonly saveBtn: HTMLButtonElement;
    private readonly options: OptionsBar;
    private readonly railButtons = new Map<string, HTMLButtonElement>();
    private readonly cursor: HTMLElement;
    private readonly hint: HTMLElement;
    private readonly measure: HTMLElement;
    private readonly counts: HTMLElement;
    private build: HTMLElement;
    private readonly buildLabel: HTMLElement;
    private readonly missingBtn: HTMLButtonElement;
    private readonly pct: HTMLElement;
    private readonly layersPanel: HTMLElement;
    private readonly layersToggle: HTMLButtonElement;
    private readonly networkPanel: HTMLElement;
    private readonly networkFilter: HTMLSelectElement;
    private readonly networkStatus: HTMLElement;
    private readonly layerBoxes = new Map<Layer, HTMLInputElement>();
    private readonly layerKeys = new Map<Layer, HTMLElement>();
    private missing: string[] = [];
    private missingList: HTMLElement | null = null;
    private last = { name: "", modified: false, canUndo: false, canRedo: false, open: false, tool: "", counts: "", pct: "", cursor: "", hint: "", networkStatus: "" };
    private forks: Fork[] = [];
    /** How long the open map took to load and draw, for the counts' tooltip. */
    loadInfo = "";

    constructor(
        root: { topbar: HTMLElement; optionsbar: HTMLElement; rail: HTMLElement; statusbar: HTMLElement; controls: HTMLElement },
        private readonly c: EditorController,
        private readonly keymap: Keymap,
        private readonly hooks: ShellHooks,
    ) {
        addStyle();
        const { topbar, optionsbar, rail, statusbar, controls } = root;

        // ---- top bar
        topbar.classList.add("topbar");
        const brand = h("div", "tb-brand");
        brand.append("SS14 Mapper");
        topbar.append(brand);
        const keys = (id: string) => keymap.bindings(id).map(describeChord)[0];
        const cmd = (label: string, id: string, disabled = false): MenuItem => ({ label, keys: keys(id), run: () => c.run(id), disabled });
        const menus: MenuDef[] = [
            {
                label: translate("File"),
                items: () => [
                    cmd(translate("New map…"), "file.new"),
                    cmd(translate("Open file…"), "file.open"),
                    { label: translate("Open recent"), sub: () => {
                        const list = hooks.recent();
                        return list.length ? list : [{ label: translate("No maps in this browser"), disabled: true }];
                    } },
                    "-",
                    { label: translate("Save"), keys: keys("file.save"), run: () => c.run("file.save"), disabled: !c.status.open },
                    cmd(translate("Save as…"), "file.saveAs", !c.status.open),
                    cmd(translate("Download .yml"), "file.download", !c.status.open),
                    "-",
                    { label: translate("Manage library…"), run: () => hooks.library() },
                    { label: translate("Change build"), disabled: !c.status.open, sub: () => this.forks.map((f) => ({ label: f.name, checked: f.id === this.forkSelect.value, run: () => this.chooseFork(f.id) })) },
                    ...(hooks.addBuild ? [{ label: translate("Add a build…"), run: () => hooks.addBuild?.() }] : []),
                ],
            },
            {
                label: translate("Edit"),
                items: () => {
                    const st = c.status, none = !c.options.selection, grids = c.gridList();
                    return [
                        cmd(translate("Undo"), "edit.undo", !st.canUndo),
                        cmd(translate("Redo"), "edit.redo", !st.canRedo),
                        "-",
                        cmd(translate("Cut"), "edit.cut", none),
                        cmd(translate("Copy"), "edit.copy", none),
                        cmd(translate("Paste"), "edit.paste", !st.open),
                        cmd(translate("Delete"), "edit.delete", none),
                        "-",
                        cmd(translate("Rotate clockwise"), "edit.rotateCw", !st.canRotate),
                        cmd(translate("Rotate counter-clockwise"), "edit.rotateCcw", !st.canRotate),
                        cmd(translate("Flip horizontally"), "edit.flipHorizontal", st.busy || (none && !c.options.pasting)),
                        cmd(translate("Flip vertically"), "edit.flipVertical", st.busy || (none && !c.options.pasting)),
                        "-",
                        cmd(translate("Select all"), "select.all", !st.open),
                        cmd(translate("Deselect"), "select.none", none),
                        "-",
                        { label: translate("Color pipe network…"), run: () => void c.editPipeNetworkColor(), disabled: !c.canColorPipeNetwork },
                        {
                            label: translate("Fix grid atmosphere…"),
                            disabled: !grids.length || st.busy,
                            ...(grids.length === 1
                                ? { run: () => void c.rebuildAtmosphere(grids[0]!.uid) }
                                : { sub: () => grids.map(({ uid, name }) => ({ label: name, note: translate("uid {{1}}", { 1: uid }), run: () => void c.rebuildAtmosphere(uid) })) }),
                        },
                        "-",
                        { label: translate("Map properties"), run: () => c.openMapProperties(), disabled: !st.open },
                        {
                            label: translate("Grid properties"),
                            disabled: !st.open || !grids.length,
                            sub: () => grids.map(({ uid, name }) => ({ label: name, note: translate("uid {{1}}", { 1: uid }), run: () => c.openProperties(uid) })),
                        },
                        "-",
                        { label: translate("Key bindings…"), run: () => hooks.settings() },
                    ];
                },
            },
            {
                label: translate("View"),
                items: () => [
                    { label: translate("Panels"), sub: () => hooks.panels() },
                    "-",
                    ...LAYER_DEFS.map(([l, label, id]): MenuItem => ({ label, keys: keys(id), checked: c.layer(l), run: () => c.setLayer(l, !c.layer(l)) })),
                    { label: translate("Animate parallax"), checked: c.parallaxAnimated, run: () => c.setParallaxAnimated(!c.parallaxAnimated) },
                    "-",
                    cmd(translate("Fit map"), "view.fit", !c.status.open),
                    cmd(translate("Zoom in"), "view.zoomIn", !c.status.open),
                    cmd(translate("Zoom out"), "view.zoomOut", !c.status.open),
                ],
            },
            {
                label: translate("Help"),
                items: () => [
                    { label: translate("Keyboard shortcuts"), keys: keys("help.shortcuts"), run: () => hooks.shortcuts() },
                    { label: translate("Language"), sub: () => languages.map(({ code, name }) => ({ label: name, checked: code === language(), run: () => hooks.setLanguage(code) })) },
                    ...(hooks.reportBug ? [{ label: translate("Send feedback…"), run: () => hooks.reportBug?.() }] : []),
                    "-",
                    { label: translate("About SS14 Mapper"), run: () => hooks.about() },
                ],
            },
        ];
        new MenuBar(topbar, menus);
        const mobileMenu = h("div", "mobile-menu");
        new MenuBar(mobileMenu, [{ label: translate("Menu"), items: () => menus.map(m => ({ label: m.label, sub: m.items })) }]);
        topbar.prepend(mobileMenu);
        const centre = h("div", "tb-centre");
        this.name = h("span", "tb-name");
        this.dot = h("span", "tb-dot");
        this.dot.title = translate("Unsaved changes");
        this.dot.hidden = true;
        // the build is fixed by the map: it is chosen when a map is opened or made, and File > Change build… switches it
        this.forkSelect = h("select", "tb-fork");
        this.forkSelect.id = "fork";
        this.forkSelect.hidden = true;
        this.buildLabel = h("span", "tb-build");
        this.buildLabel.title = translate("Build");
        centre.append(this.name, this.dot, this.buildLabel, this.forkSelect);
        this.undoBtn = button("tb-icon", icon(ICON.undo), "", () => c.run("edit.undo"));
        this.undoBtn.setAttribute("aria-label", translate("Undo"));
        this.redoBtn = button("tb-icon", icon(ICON.redo), "", () => c.run("edit.redo"));
        this.redoBtn.setAttribute("aria-label", translate("Redo"));
        this.saveBtn = button("tb-save", translate("Save"), "", () => c.run("file.save"));
        this.saveBtn.id = "save";
        topbar.append(centre, this.undoBtn, this.redoBtn, h("span", "tb-sep"), this.saveBtn);
        new MenuBar(topbar, [{ label: translate("Panels"), items: () => hooks.panels() }]);

        // ---- options bar
        this.options = new OptionsBar(optionsbar, c);

        // ---- tool rail
        rail.classList.add("rail");
        for (const t of TOOLS) {
            if (t.gapBefore) rail.append(h("span", "rl-gap"));
            const b = button("rl-tool", icon(t.icon, 18), "", () => c.run(t.action));
            b.setAttribute("aria-label", t.label);
            b.append(h("span", "mobile-tool-label", t.label));
            b.dataset.tool = t.id;
            if (t.flyout) {
                b.append(h("span", "rl-flyout"));
                const fly = () => this.flyout(t.id as "marquee" | "shapes", b);
                b.addEventListener("contextmenu", (e) => {
                    e.preventDefault();
                    fly();
                });
                let timer = 0;
                b.addEventListener("pointerdown", (e) => {
                    if (e.button === 0) timer = window.setTimeout(fly, 350);
                });
                for (const ev of ["pointerup", "pointerleave"]) b.addEventListener(ev, () => clearTimeout(timer));
            }
            this.railButtons.set(t.id, b);
            rail.append(b);
        }
        rail.append(h("p", "mobile-gesture-hint", translate("Two fingers move and zoom. Hold to choose an object.")));

        // ---- status bar
        statusbar.classList.add("statusbar");
        this.cursor = h("span", "sb-cursor");
        this.cursor.id = "cursor";
        this.cursor.title = translate("Cursor cell coordinates");
        this.measure = h("span", "sb-measure");
        this.measure.id = "selection-measure";
        this.measure.title = translate("Selection footprint: entity cells, tiles and decal bounds. Width × height in tiles.");
        this.hint = h("span", "sb-hint");
        this.hint.id = "info";
        this.counts = h("span");
        this.counts.id = "status";
        this.build = h("span", "sb-build");
        this.missingBtn = button("sb-missing", "", translate("Missing sprites"), (e) => {
            e.stopPropagation();
            this.toggleMissing();
        });
        this.missingBtn.hidden = true;
        statusbar.append(this.cursor, this.measure, this.hint, this.counts, this.build, this.missingBtn, creditLink("sb-credit"));

        // ---- layers and zoom on the map
        controls.classList.add("map-controls");
        this.layersPanel = h("div", "mc-layers");
        this.layersPanel.setAttribute("role", "dialog");
        this.layersPanel.setAttribute("aria-label", translate("View layers"));
        this.layersPanel.hidden = true;
        for (const [l, label] of LAYER_DEFS) {
            const row = h("label");
            const box = h("input");
            box.type = "checkbox";
            box.dataset.layer = l;
            box.addEventListener("change", () => {
                c.setLayer(l, box.checked);
                box.blur();
            });
            const key = h("span", "mc-key");
            row.append(box, label, key);
            this.layerBoxes.set(l, box);
            this.layerKeys.set(l, key);
            this.layersPanel.append(row);
        }
        this.networkPanel = h("div", "mc-networks");
        this.networkPanel.hidden = true;
        this.networkFilter = h("select");
        this.networkFilter.setAttribute("aria-label", translate("Filter node networks"));
        const filters: ReadonlyArray<[NetworkFilter, string]> = [["all", translate("All")], ["pipes", translate("Pipes")], ["hv", "HV"], ["mv", "MV"], ["lv", translate("LV / APC")]];
        for (const [id, label] of filters) this.networkFilter.add(new Option(label, id));
        this.networkFilter.addEventListener("change", () => c.setNetworkFilter(this.networkFilter.value as NetworkFilter));
        this.networkStatus = h("div", "mc-network-status");
        this.networkStatus.hidden = true;
        this.networkStatus.setAttribute("role", "status");
        const networkLabel = h("label", "", translate("Node networks"));
        networkLabel.append(this.networkFilter);
        this.networkPanel.append(networkLabel, this.networkStatus);
        const bar = h("div", "mc-bar");
        const pan = button("mc-pan", translate("Move view"), translate("Drag with one finger to move the map"), () => {
            c.touchNavigation = !c.touchNavigation;
            pan.setAttribute("aria-pressed", String(c.touchNavigation));
        });
        pan.setAttribute("aria-pressed", "false");
        this.layersToggle = button("mc-toggle", icon(ICON.layers, 16), translate("View layers"), () => this.toggleLayers());
        this.layersToggle.append(translate("Layers"));
        this.layersToggle.setAttribute("aria-expanded", "false");
        const out = button("mc-zoom", "−", "", () => c.run("view.zoomOut"));
        out.setAttribute("aria-label", translate("Zoom out"));
        const inn = button("mc-zoom", "+", "", () => c.run("view.zoomIn"));
        inn.setAttribute("aria-label", translate("Zoom in"));
        this.pct = h("span", "mc-pct");
        const fit = button("mc-fit", translate("Fit"), "", () => c.run("view.fit"));
        fit.dataset.fit = "";
        bar.append(pan, this.layersToggle, h("span", "mc-sep"), out, this.pct, inn, fit);
        controls.append(this.networkPanel, this.layersPanel, bar);
        // the controls are not part of the map: no map gestures start on them
        controls.addEventListener("wheel", (e) => e.stopPropagation());

        keymap.onChange(() => this.updateTitles());
        this.updateTitles();
        this.update();
    }

    /** Shows a loading message where the map counts go (until the next map is drawn). */
    loading(text: string): void {
        this.counts.textContent = text;
        this.last.counts = "";
    }

    setForks(forks: Fork[], current: string): void {
        this.forks = forks;
        this.forkSelect.replaceChildren(...forks.map((f) => new Option(f.name, f.id)));
        this.forkSelect.value = current;
    }

    private chooseFork(id: string): void {
        this.forkSelect.value = id;
        this.hooks.setFork(id);
    }

    /** Tooltips with the current bindings. */
    private updateTitles(): void {
        const keys = (id: string) => this.keymap.bindings(id).map(describeChord).join(", ");
        const tip = (el: HTMLElement, text: string, id: string) => {
            const k = keys(id);
            el.title = k ? `${text} (${k})` : text;
        };
        for (const t of TOOLS) {
            const b = this.railButtons.get(t.id)!;
            tip(b, t.label, t.action);
            if (t.flyout) b.title += translate(" (right-click for shapes)");
        }
        tip(this.undoBtn, translate("Undo"), "edit.undo");
        tip(this.redoBtn, translate("Redo"), "edit.redo");
        tip(this.saveBtn, translate("Save"), "file.save");
        for (const [l, , id] of LAYER_DEFS) this.layerKeys.get(l)!.textContent = this.keymap.bindings(id).map(describeChord)[0] ?? "";
        const fit = this.pct.parentElement?.querySelector<HTMLElement>("[data-fit]");
        if (fit) tip(fit, translate("Fit map"), "view.fit");
    }

    /** The shapes of the marquee or the Shapes tool, beside the rail button. */
    private flyout(tool: "marquee" | "shapes", b: HTMLElement): void {
        const r = b.getBoundingClientRect();
        const c = this.c, o = c.options;
        const keys = (id: string) => this.keymap.bindings(id).map(describeChord)[0];
        const items: MenuItem[] =
            tool === "marquee"
                ? MARQUEE_SHAPES.map(([v, label, d, id]) => ({ label, icon: d, keys: keys(id), checked: o.tool === "marquee" ? o.marquee === v : undefined, run: () => c.setMarquee(v) }))
                : SHAPE_KINDS.map(([v, label, d, id]) => ({ label, icon: d, keys: keys(id), checked: o.tool === "shapes" ? o.shape === v : undefined, run: () => c.setShapeKind(v) }));
        if (o.tool !== tool) for (const it of items) if (it !== "-") delete it.checked;
        popupMenu(items, r.right + 6, r.top);
    }

    toggleLayers(open = this.layersPanel.hidden): void {
        this.layersPanel.hidden = !open;
        this.layersToggle.setAttribute("aria-expanded", String(open));
        this.update();
    }

    private toggleMissing(): void {
        if (this.missingList) return this.closeMissing();
        const box = h("div", "sb-list");
        box.append(h("div", "sl-head", translate("Missing sprites ({{1}})", { 1: this.missing.length })));
        box.append(h("div", "sl-body", this.missing.join("\n")));
        document.body.append(box);
        const r = this.missingBtn.getBoundingClientRect();
        const w = box.getBoundingClientRect();
        box.style.left = `${Math.max(4, Math.min(r.right - w.width, window.innerWidth - w.width - 4))}px`;
        box.style.top = `${r.top - w.height - 6}px`;
        this.missingList = box;
        const away = (e: Event) => {
            if (box.contains(e.target as Node) || this.missingBtn.contains(e.target as Node)) return;
            this.closeMissing();
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            this.closeMissing();
        };
        window.addEventListener("pointerdown", away, true);
        window.addEventListener("keydown", esc, true);
        this.closeMissing = () => {
            window.removeEventListener("pointerdown", away, true);
            window.removeEventListener("keydown", esc, true);
            box.remove();
            this.missingList = null;
            this.closeMissing = () => {};
        };
    }

    private closeMissing: () => void = () => {};

    /** Brings everything up to date with the controller (called after each of its refreshes). */
    update(): void {
        const c = this.c, last = this.last;
        const s = c.current, st = c.status;
        const set = <K extends keyof typeof last>(k: K, v: (typeof last)[K]) => {
            if (last[k] === v) return false;
            last[k] = v;
            return true;
        };
        if (set("name", s?.name ?? "")) this.name.textContent = last.name;
        if (set("modified", st.modified)) this.dot.hidden = !st.modified;
        if (set("canUndo", st.canUndo)) this.undoBtn.disabled = !st.canUndo;
        if (set("canRedo", st.canRedo)) this.redoBtn.disabled = !st.canRedo;
        if (set("open", st.open)) this.saveBtn.disabled = !st.open;
        if (set("tool", c.activeTool)) {
            for (const [id, b] of this.railButtons) b.setAttribute("aria-pressed", String(id === c.activeTool));
            const current = document.querySelector(".mobile-current-tool");
            if (current) current.textContent = TOOLS.find(t => t.id === c.activeTool)?.label ?? "";
        }
        this.options.update();
        if (set("cursor", c.cursorText)) this.cursor.textContent = c.cursorText;
        const measure = c.selectionMeasure;
        const number = (v: number) => Number(v.toFixed(2)).toLocaleString(language());
        const measured = measure ? translate("Selection {{width}} × {{height}} tiles", { width: number(measure.width), height: number(measure.height) }) : "";
        if (this.measure.textContent !== measured) this.measure.textContent = measured;
        this.measure.hidden = !measure;
        if (measure) this.measure.title = translate("Selection footprint: entity cells, tiles and decal bounds. Width × height in tiles.") + " " + (measure.grid === null ? translate("World axes") : translate("Grid {{grid}}", { grid: measure.grid }));
        if (set("hint", c.hint)) {
            this.hint.textContent = c.hint;
            this.hint.title = c.hint;
        }
        const counts = s ? translate("{{1}} entities, {{2}} tiles, {{3}} decals", { 1: s.scene.entities.size, 2: s.scene.tiles.size, 3: s.scene.decals.size }) : "";
        if (set("counts", counts + (s?.pack.manifest.fork.commit ?? ""))) {
            this.counts.textContent = counts;
            this.counts.title = this.loadInfo;
            this.missing = s?.scene.missing ?? [];
            this.missingBtn.hidden = !this.missing.length;
            this.missingBtn.replaceChildren(icon(ICON.warning, 13), translate("{{1}} missing", { 1: this.missing.length }));
            const f = s?.pack.manifest.fork;
            const repo = (f?.repo || this.forks.find((x) => x.id === f?.id)?.repo || "").replace(/\.git$/, "").replace(/\/$/, "");
            const tag = f && repo ? "a" : "span";
            if (this.build.localName !== tag) {
                const build = h(tag, "sb-build");
                this.build.replaceWith(build);
                this.build = build;
            }
            this.build.textContent = f ? `${this.forks.find((x) => x.id === f.id)?.name ?? f.id} ${f.commit.slice(0, 7)}` : "";
            if (f && repo) {
                this.build.setAttribute("href", `${repo}/tree/${f.commit}`);
                this.build.setAttribute("target", "_blank");
                this.build.setAttribute("rel", "noopener noreferrer");
                this.build.title = translate("{{1}} at {{2}}", { 1: repo, 2: f.commit.slice(0, 7) });
            } else {
                this.build.title = f ? f.commit : "";
            }
        }
        this.buildLabel.textContent = this.forks.find((x) => x.id === this.forkSelect.value)?.name ?? this.forkSelect.value;
        if (set("pct", s ? `${Math.round(c.zoom * 100)}%` : "")) this.pct.textContent = last.pct;
        this.networkPanel.hidden = !c.layer("nodes");
        if (this.networkFilter.value !== c.networkFilter) this.networkFilter.value = c.networkFilter;
        const networkStatus = this.networkPanel.hidden ? "" : c.networkStatus;
        if (set("networkStatus", networkStatus)) {
            this.networkStatus.textContent = networkStatus;
            this.networkStatus.hidden = !networkStatus;
        }
        if (!this.layersPanel.hidden) for (const l of LAYERS) this.layerBoxes.get(l)!.checked = c.layer(l);
    }
}
