// The options bar: the active tool's name and settings (pick filter, marquee shape, what the brush places and how,
// shapes, eraser and eyedropper kinds, what the multitool holds), and for the selection tools the selection with
// Rotate, Copy and Delete. Rebuilt when the options change; not while one of its fields has the focus.
import { t as translate } from "../i18n";
import type { EditorController, EraseKind, MarqueeShape, SampleFrom, SelectedDecals, SelectFilter, ShapeKind, Tool, ToolOptions } from "../editor/controller";
import type { DecalSnap } from "../editor/tools";
import { layerPrototypes } from "../editor/pipe-layers";
import type { RulerSnap } from "../editor/ruler";
import type { DecalProps } from "../map/decals";
import type { Pack } from "../pack/loader";
import { joinColor, splitColor } from "./color";
import { button, h, ICON, spriteCanvas } from "./icons";
import { decalIcon, entityIcon, tileIcon } from "./palette";

export interface ToolDef {
    id: Tool;
    label: string;
    action: string;
    icon: string;
    /** Has a flyout of variants (marquee shapes, shapes). */
    flyout?: boolean;
    /** A divider goes before it in the rail. */
    gapBefore?: boolean;
}

export const TOOLS: readonly ToolDef[] = [
    { id: "select", label: translate("Select"), action: "tool.select", icon: ICON.select },
    { id: "marquee", label: translate("Marquee"), action: "tool.marquee", icon: ICON.marquee, flyout: true },
    { id: "wand", label: translate("Magic wand"), action: "tool.wand", icon: ICON.wand },
    { id: "brush", label: translate("Brush"), action: "tool.brush", icon: ICON.brush, gapBefore: true },
    { id: "shapes", label: translate("Shapes"), action: "tool.shapes", icon: ICON.shapes, flyout: true },
    { id: "eraser", label: translate("Eraser"), action: "tool.erase", icon: ICON.eraser },
    { id: "eyedropper", label: translate("Eyedropper"), action: "tool.eyedropper", icon: ICON.eyedropper },
    { id: "multitool", label: translate("Multitool"), action: "tool.multitool", icon: ICON.multitool, gapBefore: true },
    { id: "ruler", label: translate("Ruler"), action: "tool.ruler", icon: ICON.ruler },
];

export const MARQUEE_SHAPES: ReadonlyArray<[MarqueeShape, string, string, string]> = [
    ["rect", translate("Rectangle"), ICON.rect, "tool.selectRect"],
    ["ellipse", translate("Ellipse"), ICON.ellipse, "tool.selectEllipse"],
    ["lasso", translate("Lasso"), ICON.lasso, "tool.lasso"],
];

export const SHAPE_KINDS: ReadonlyArray<[ShapeKind, string, string, string]> = [
    ["line", translate("Line"), ICON.line, "tool.shapeLine"],
    ["rect", translate("Rectangle"), ICON.rect, "tool.shapeRect"],
    ["ellipse", translate("Ellipse"), ICON.ellipse, "tool.shapeEllipse"],
];

const FILTERS: ReadonlyArray<[SelectFilter, string]> = [["all", translate("All")], ["entities", translate("Entities")], ["tiles", translate("Tiles")], ["decals", translate("Decals")]];
const ERASE: ReadonlyArray<[EraseKind, string]> = [["tiles", translate("Tiles")], ["entities", translate("Entities")], ["decals", translate("Decals")]];
const SAMPLE: ReadonlyArray<[SampleFrom, string]> = [["any", translate("Any")], ["entities", translate("Entities")], ["tiles", translate("Tiles")], ["decals", translate("Decals")]];
const SNAPS: ReadonlyArray<[DecalSnap, string]> = [["tile", translate("Tile")], ["corner", translate("Corner")], ["free", translate("Off")]];
const RULER_SNAPS: ReadonlyArray<[RulerSnap, string]> = [["centers", translate("Centers")], ["corners", translate("Corners")], ["free", translate("Free")]];
const PIPE_LAYERS: ReadonlyArray<[string, string]> = [["auto", translate("Auto")], ["0", translate("Primary")], ["1", translate("Secondary")], ["2", translate("Tertiary")]];

const STYLE = `
.optionsbar { display: flex; flex-direction: column; flex: none; min-height: 36px; background: var(--panel); border-bottom: 1px solid var(--border); }
.optionsbar .ob-line { display: flex; align-items: center; gap: 8px; min-height: 35px; padding: 0 12px; box-sizing: border-box; overflow-x: auto; scrollbar-width: thin; white-space: nowrap; }
.optionsbar .ob-details { border-top: 1px solid var(--border); background: var(--panel-2); }
.optionsbar .ob-details .ob-group:first-child { border: 0; padding-inline-start: 0; margin-inline-start: 0; }
.optionsbar .ob-group.ob-actions { gap: 2px; flex: 0 1 auto; min-width: 0; }
.optionsbar .ob-selection-count { min-width: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; margin-inline-end: 8px; }
.optionsbar .ob-material.ob-leading { border: 0; padding-inline-start: 0; margin-inline-start: 0; }
.optionsbar .ob-material .ob-muted { flex: none; }
.optionsbar .ob-holding { max-width: 280px; overflow: hidden; text-overflow: ellipsis; }

.optionsbar .ob-name { font-weight: 600; color: var(--text-2); min-width: 80px; flex: none; }
.optionsbar .ob-sep { width: 1px; height: 20px; background: var(--border); flex: none; }
.optionsbar .ob-muted { color: var(--muted); }
.optionsbar .ob-grow { flex: 1; }
.optionsbar .ob-group { display: flex; align-items: center; gap: 8px; flex: none; padding-inline-start: 12px; margin-inline-start: 4px; border-inline-start: 1px solid var(--border); }
.optionsbar .ob-material { min-width: 0; max-width: 260px; }
.optionsbar .ob-material canvas { flex: none; }
.optionsbar .ob-material-name { overflow: hidden; text-overflow: ellipsis; }
.optionsbar .ob-fill { min-height: 26px; }
.optionsbar .ob-fill:has(input:disabled) { color: var(--faint); }
.optionsbar .ob-setting { color: var(--muted); }
.optionsbar .ob-setting select { max-width: 160px; padding-inline: 6px; }
.optionsbar .seg { display: flex; gap: 2px; flex: none; }
.optionsbar .seg button { height: 26px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; border-radius: 2px 2px 0 0; background: transparent; color: var(--muted); }
.optionsbar .seg button[aria-pressed="true"] { background: var(--accent-soft); border-bottom-color: var(--accent-text); color: var(--text); }
.optionsbar .seg button:hover:not(:disabled) { background: var(--raised); color: var(--text); }
.optionsbar .seg button:disabled { color: var(--faint); cursor: default; }
.optionsbar .btn { height: 28px; padding: 0 10px; border: 0; border-radius: 2px; background: transparent; color: var(--text); flex: none; }
.optionsbar .btn.small { height: 26px; }
.optionsbar .btn:hover:not(:disabled) { background: var(--raised); color: var(--text); }
.optionsbar .btn:disabled { color: var(--faint); cursor: default; }
.optionsbar .btn.danger:not(:disabled):hover { background: var(--danger-bg); color: var(--danger-text); }
.optionsbar label { display: flex; align-items: center; gap: 6px; flex: none; }
.optionsbar input[type=text] { width: 46px; height: 24px; box-sizing: border-box; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--raised); color: var(--text); }
.optionsbar input[type=color] { width: 30px; height: 24px; padding: 0; border: 1px solid var(--border); background: var(--raised); }
.optionsbar input[type=text].mixed { width: 58px; }
.optionsbar input[type=text].mixed::placeholder { color: var(--warn); }
.optionsbar .ob-mixed { color: var(--warn); font-size: 12px; }
.optionsbar select { height: 26px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--raised); color: var(--text); }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

const toDegrees = (rad: number) => Math.round(((rad * 180) / Math.PI) * 1e4) / 1e4;

export class OptionsBar {
    private key = "";

    constructor(private readonly container: HTMLElement, private readonly c: EditorController) {
        addStyle();
        container.classList.add("optionsbar");
        // a rebuild waits while a field is being edited
        container.addEventListener("focusout", () => setTimeout(() => this.update()));
    }

    update(): void {
        const o = this.c.options;
        const pack = this.c.current?.pack ?? null;
        const key = JSON.stringify(o) + (pack?.manifest.fork.commit ?? "");
        if (key === this.key) return;
        const focused = document.activeElement;
        if (focused && this.container.contains(focused) && (focused instanceof HTMLInputElement || focused instanceof HTMLSelectElement)) return;
        this.key = key;
        this.render(o, pack);
    }

    private render(o: ToolOptions, pack: Pack | null): void {
        const c = this.c;
        const bar = this.container;
        const def = TOOLS.find((t) => t.id === o.tool)!;
        const details: Node[] = [];
        const parts: Node[] = [h("span", "ob-name", def.label), h("span", "ob-sep")];
        const muted = (t: string) => h("span", "ob-muted", t);
        const selectionTool = o.tool === "select" || o.tool === "marquee" || o.tool === "wand";
        if (selectionTool) parts.push(choose(translate("Pick"), FILTERS, o.filter, (f) => c.setFilter(f)));
        // the selected decals: the brush's fields, set on all of them; Snap also says how they move
        if (selectionTool && o.decals) details.push(...this.decalFields(o, o.decals, true));
        if (o.tool === "marquee") {
            const shape = group(seg(translate("Marquee shape"), MARQUEE_SHAPES.map(([v, l]) => [v, l]), o.marquee, (m) => c.setMarquee(m)));
            shape.title = translate("Shift: add, Alt: subtract");
            parts.push(shape);
        }
        if (o.tool === "wand") parts.push(group(check(translate("Contiguous"), o.contiguous, (on) => c.setContiguous(on), translate("Ctrl+click inverts"))));
        if (o.tool === "brush") {
            parts.push(...this.brush(o, pack));
            if (o.choice?.kind === "decal" && pack) {
                details.push(...this.decalFields(o, { count: 1, props: o.decal, mixed: NOT_MIXED }, false));
                details.push(group(check(translate("Defaults"), o.auto, (on) => c.setDecalAuto(on), translate("Use the decal's default snap, color and cleanable"))));
            }
        }
        if (o.tool === "shapes") {
            parts.push(seg(translate("Shape"), SHAPE_KINDS.map(([v, l]) => [v, l]), o.shape, (k) => c.setShapeKind(k)));
            const fill = check(translate("Filled"), o.filled, (on) => c.setFilled(on));
            fill.classList.add("ob-group", "ob-fill");
            fill.querySelector("input")!.disabled = o.shape === "line";
            parts.push(fill);
            parts.push(material(o.choice, pack));
        }
        if (o.tool === "eraser") parts.push(choose(translate("Erase"), ERASE, o.erase, (k) => c.setEraseKind(k)));
        if (o.tool === "eyedropper") parts.push(choose(translate("Sample from"), SAMPLE, o.sample, (k) => c.setSampleFrom(k)));
        if (o.tool === "ruler") parts.push(choose(translate("Snap"), RULER_SNAPS, o.rulerSnap, (snap) => c.setRulerSnap(snap)));
        if (o.tool === "multitool") {
            const holding = h("span", "ob-holding", o.holding ?? translate("nothing"));
            holding.title = o.holding ?? translate("nothing");
            parts.push(muted(translate("Holding")), holding);
            parts.push(group(check(translate("Show links"), c.layer("links"), (on) => c.setLayer("links", on))));
        }
        if (o.tool === "brush" || o.tool === "eraser" || o.tool === "shapes") {
            const modes = [["off", translate("Off")], ["horizontal", translate("Left–right")], ["vertical", translate("Top–bottom")], ["both", translate("Both")]] as const;
            parts.push(group(choose(translate("Mirror"), modes, o.mirror, (mode) => c.setMirrorMode(mode))));
        }
        parts.push(h("span", "ob-grow"));
        if (selectionTool) {
            const none = !o.selection;
            const count = h("span", "ob-muted ob-selection-count", o.selection ?? translate("Nothing selected"));
            count.title = count.textContent!;
            const rot = button("btn", translate("Rotate"), translate("Rotate clockwise"), () => c.run("edit.rotateCw"));
            const copy = button("btn", translate("Copy"), translate("Copy"), () => c.run("edit.copy"));
            const del = button("btn danger", translate("Delete"), translate("Delete"), () => c.run("edit.delete"));
            rot.disabled = copy.disabled = del.disabled = none;
            const actions = group(count, rot, copy, del);
            actions.classList.add("ob-actions");
            actions.setAttribute("role", "group");
            actions.setAttribute("aria-label", translate("Selection"));
            parts.push(actions);
        }
        const primary = h("div", "ob-line");
        primary.append(...parts);
        bar.replaceChildren(primary);
        if (details.length) {
            const row = h("div", "ob-line ob-details");
            row.setAttribute("role", "group");
            row.setAttribute("aria-label", translate("Decals"));
            row.append(...details);
            bar.append(row);
        }
    }

    /** The brush's options: what the palette has chosen and how it is placed. */
    private brush(o: ToolOptions, pack: Pack | null): Node[] {
        const c = this.c;
        const ch = o.choice;
        if (!ch || !pack) return [h("span", "ob-muted", translate("Nothing chosen"))];
        const chip = material(ch, pack);
        chip.classList.add("ob-leading");
        if (ch.kind === "entity") {
            chip.title += "\n" + translate("Ctrl+click a container: put inside");
            const rotation = labelled(translate("Rotation"), button("btn small", `${o.rotation}°`, translate("Rotate clockwise (R)"), () => c.run("edit.rotateCw")));
            const parts: Node[] = [chip, group(rotation)];
            // The automatic pipe layer follows the cursor's position within the tile.
            if (layerPrototypes(pack, ch.id)) {
                const layer = choose(translate("Pipe layer"), PIPE_LAYERS, o.pipeLayer === null ? "auto" : String(o.pipeLayer), (v) => c.setPipeLayer(v === "auto" ? null : Number(v)));
                layer.title = translate("By cursor position in the tile");
                parts.push(group(layer));
            }
            return parts;
        }
        if (ch.kind === "tile") {
            const n = pack.tile(ch.id)?.variants ?? 1;
            const sel = h("select");
            sel.setAttribute("aria-label", translate("Variant"));
            sel.add(new Option(translate("Random"), "random"));
            for (let i = 0; i < Math.max(1, n); i++) sel.add(new Option(String(i + 1), String(i)));
            sel.value = o.variant === null ? "random" : String(Math.min(o.variant, n - 1));
            sel.disabled = n <= 1;
            sel.addEventListener("change", () => {
                c.setVariant(sel.value === "random" ? null : Number(sel.value));
                sel.blur();
            });
            return [chip, group(labelled(translate("Variant"), sel))];
        }
        return [chip];
    }

    /**
     * The decal fields, the same for the brush and for selected decals: Color, Alpha, Angle, Z, Snap, Cleanable.
     * For a selection a field sets every selected decal (one undo step) and fields that differ show as mixed.
     */
    private decalFields(o: ToolOptions, v: SelectedDecals, selection: boolean): Node[] {
        const c = this.c;
        const { props: d, mixed } = v;
        const set = (p: Partial<DecalProps> | ((d: DecalProps) => Partial<DecalProps>)) => {
            if (selection) c.setSelectedDecals(p);
            else if (typeof p !== "function") c.setDecalBrush(p);
        };
        const [rgb, a] = splitColor(d.color);
        const color = h("input");
        color.type = "color";
        color.value = rgb;
        color.title = mixed.color ? translate("Mixed") : translate("Color");
        const alpha = textField(mixed.alpha ? "" : String(a), translate("Alpha (0-255)"), mixed.alpha);
        // a new colour keeps each decal's alpha, a new alpha each decal's colour
        color.addEventListener("change", () => {
            const value = color.value;
            if (selection) set((x) => ({ color: joinColor(value, splitColor(x.color)[1]) }));
            else set({ color: joinColor(value, Number(alpha.value)) });
            color.blur();
        });
        alpha.addEventListener("change", () => {
            const n = Math.round(Number(alpha.value));
            if (alpha.value.trim() === "" || !Number.isFinite(n)) return;
            if (selection) set((x) => ({ color: joinColor(splitColor(x.color)[0], n) }));
            else set({ color: joinColor(color.value, n) });
        });
        const angle = textField(mixed.angle ? "" : String(toDegrees(d.angle)), translate("Angle in degrees"), mixed.angle);
        angle.addEventListener("change", () => {
            const deg = Number(angle.value);
            if (angle.value.trim() !== "" && Number.isFinite(deg)) set({ angle: (deg * Math.PI) / 180 });
        });
        const z = textField(mixed.zIndex ? "" : String(d.zIndex), translate("Draw order"), mixed.zIndex);
        z.addEventListener("change", () => {
            const n = Math.round(Number(z.value));
            if (z.value.trim() !== "" && Number.isFinite(n)) set({ zIndex: n });
        });
        const snap = h("select");
        for (const [val, l] of SNAPS) snap.add(new Option(l, val));
        snap.value = o.snap;
        snap.title = selection
            ? translate("Snap")
            : translate("Snap");
        snap.addEventListener("change", () => {
            c.setDecalSnap(snap.value as DecalSnap);
            snap.blur();
        });
        const snapField = labelled(translate("Snap"), snap);
        if (o.snapByDefaults) {
            // Defaults took the snap from the decal's prototype (defaultSnap: false gives Off), as the game does
            snapField.title = translate("Snap from the decal prototype");
            snapField.append(h("span", "ob-muted", translate("default")));
        }
        const clean = check(translate("Cleanable"), d.cleanable, (on) => set({ cleanable: on }));
        const box = clean.querySelector("input")!;
        box.indeterminate = mixed.cleanable;
        if (mixed.cleanable) clean.title = translate("Mixed");
        const colorField = labelled(translate("Color"), color);
        if (mixed.color) colorField.append(h("span", "ob-mixed", translate("mixed")));
        return [
            group(colorField, labelled(translate("Alpha"), alpha)),
            group(labelled(translate("Angle"), angle), labelled("Z", z)),
            group(snapField, clean),
        ];
    }
}

const NOT_MIXED: SelectedDecals["mixed"] = { color: false, alpha: false, angle: false, zIndex: false, cleanable: false };

/** Independent settings are separated as groups; their controls keep their native labels. */
function group(...nodes: Node[]): HTMLElement {
    const el = h("div", "ob-group");
    el.append(...nodes);
    return el;
}

function choose<T extends string>(label: string, options: ReadonlyArray<readonly [T, string]>, current: T, pick: (value: T) => void): HTMLElement {
    const select = h("select");
    for (const [value, text] of options) select.add(new Option(text, value));
    select.value = current;
    select.addEventListener("change", () => {
        pick(select.value as T);
        select.blur();
    });
    const field = labelled(label, select);
    field.classList.add("ob-setting");
    return field;
}

function material(choice: ToolOptions["choice"], pack: Pack | null): HTMLElement {
    const el = h("span", "ob-group ob-material");
    if (!choice || !pack) {
        el.append(h("span", "ob-muted", translate("Nothing chosen")));
        return el;
    }
    const name = choiceName(choice, pack);
    const kind = choice.kind === "entity" ? "Entity" : choice.kind === "tile" ? "Tile" : "Decal";
    el.title = `${translate(kind)}: ${name} (${choice.id})`;
    if (choice.kind === "entity") {
        const description = pack.entityText(choice.id).description;
        if (description) el.title += "\n" + description;
    }
    el.append(h("span", "ob-muted", translate(kind)), spriteCanvas(pack, choiceIcon(choice, pack), 20), h("span", "ob-material-name", name));
    return el;
}

/** A segmented control: one pressed button of several. */
function seg<T extends string>(label: string, options: ReadonlyArray<readonly [T, string]>, current: T, pick: (v: T) => void, disabled = false): HTMLElement {
    const g = h("div", "seg");
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", label);
    for (const [v, l] of options) {
        const b = button("", l, "", () => pick(v));
        b.setAttribute("aria-pressed", String(v === current && !disabled));
        b.disabled = disabled;
        g.append(b);
    }
    return g;
}

function check(label: string, on: boolean, set: (on: boolean) => void, title = ""): HTMLElement {
    const l = h("label");
    const box = h("input");
    box.type = "checkbox";
    box.checked = on;
    box.addEventListener("change", () => {
        set(box.checked);
        box.blur();
    });
    l.append(box, label);
    if (title) l.title = title;
    return l;
}

function labelled(text: string, field: HTMLElement): HTMLElement {
    const l = h("label");
    l.append(text, field);
    return l;
}

/** A short text field that hands the keys back to the map on Enter; `mixed`: empty, marked as mixed. */
function textField(value: string, title: string, mixed = false): HTMLInputElement {
    const i = h("input");
    i.type = "text";
    i.value = value;
    i.title = mixed ? translate("{{1}}. Mixed: the selected decals differ", { 1: title }) : title;
    if (mixed) {
        i.placeholder = translate("mixed");
        i.classList.add("mixed");
    }
    i.spellcheck = false;
    i.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") i.blur();
    });
    return i;
}

function choiceIcon(ch: NonNullable<ToolOptions["choice"]>, pack: Pack) {
    return ch.kind === "entity" ? entityIcon(pack, ch.id) : ch.kind === "tile" ? tileIcon(pack, ch.id) : decalIcon(pack, ch.id);
}

function choiceName(ch: NonNullable<ToolOptions["choice"]>, pack: Pack): string {
    if (ch.kind === "entity") {
        const { name, suffix } = pack.entityText(ch.id);
        return suffix ? `${name} (${suffix})` : name;
    }
    if (ch.kind === "tile") return pack.tileName(ch.id);
    return ch.id;
}
