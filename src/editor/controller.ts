// Mouse and keyboard of the editor: turns input on the map canvas into editor operations, draws the selection,
// the placement ghost and the hovered tile on the overlay, and keeps the state the editor shell shows (tool
// options, status hint, view layers). The shell (src/ui/shell.ts) draws the bars and calls the commands here.
//
// Tools: Select (click, drag what is under it, drag a box elsewhere; repeated clicks at one spot step through what
// lies there), Marquee (rectangle, ellipse or lasso), Magic wand, Brush (places what the palette has chosen: an
// entity, a tile or a decal; choosing in the palette turns it on), Shapes (lines, rectangles and ellipses of the
// palette choice), Eraser (tiles, entities or decals), Eyedropper (makes what is under the cursor the brush) and
// Multitool. Right button: pan (a click without moving opens the menu of what lies under the cursor in Select
// mode; with the multitool it lists devices), erase with a tile brush, stop placing with an entity or a decal.
// Middle button or Space + left: pan (a middle click without moving runs its bound action, rotate by default).
// Wheel: zoom. Keys and extra mouse buttons are looked up in the `Keymap`, which maps them to action ids;
// handlers are registered per id.
//
// With a selection tool, Shift adds to the selection and Alt takes from it; the Select tool (or Ctrl with any
// selection tool) drags what is selected. With the brush, Alt+click samples what is under the cursor.
//
// Multitool (K by default): click a device to hold it, then another: a held configurator (air or fire alarm) adds
// the device to its list or takes it out, else the linking panel of the two opens in the Properties column
// (Shift+click links even where a device list would apply). Right click or Esc releases the held device. The
// links of the held entity, or of the one selected entity with other tools, are drawn on the overlay.
//
// Containers: dragging a palette row onto an entity with containers puts a new one inside (entity storage first,
// else a bag, else a slot), onto the floor places it; Ctrl+click with an entity brush puts it into the container
// under the cursor, and Ctrl held while dragging an entity drops it into the container under it. The target is
// outlined while hovering (green when it takes the item, red with the reason in the status line otherwise).
//
// The Properties column shows the linking panel (multitool), the selected decals, or the component inspector
// (one selected entity, or the held one); it is hidden when it has nothing to show.
//
// Copy, cut and paste go through the browser's clipboard events when bound to Ctrl+C/X/V, so the clipboard
// text reaches other tabs without asking for permission; other bindings use the Clipboard API, and an
// in-memory copy stands in when neither is available.
import type { DecalProps } from "../map/decals";
import type { MapDocument } from "../map/document";
import type { Frame, Pack } from "../pack/loader";
import type { MapCanvas } from "../render/canvas";
import { PPM, Scene, type DecalLayer, type SpriteLayer, type TileLayer } from "../render/scene";
import { splitColor } from "../ui/color";
import type { Inspector } from "../ui/inspector";
import type { LinkPanel } from "../ui/link-panel";
import { decalIcon, entityIcon, tileIcon, type Palette, type PaletteChoice } from "../ui/palette";
import { dragged, isOurs, setDragged } from "../ui/drag";
import { showToast } from "../ui/toast";
import { Contents, contentsKit } from "./contents";
import { chordOfKey, chordOfMouse, formatChord, type Keymap, type KeyStorage } from "./keymap";
import { loadPrefs, savePrefs } from "./prefs";
import { clipCounts, clipText, readClip, type Clip, type PasteKnown } from "./clipboard";
import { cellOf, FILTER_KINDS, type Combine, type Kind, type SelectFilter } from "./selection";
import { ClickCycle, describe, nextIndex, type StackItem, type StackKind, type StackOptions } from "./stack";
import { PickMenu } from "../ui/pick-menu";
import { decalCorners, drawArea, drawCellGhosts, drawGhostLayers, drawPasteGhost, outlineDecals, outlineEntities, outlineTiles, type GhostIcon, type OverlayContext } from "./selection-overlay";
import type { Area, Point, ShapeKind } from "./shapes";
import { MassCache, type MassMode } from "./mass-cache";
import { Editor, decalBrushDefaults, type Brush, type DecalSnap, type GridPoint } from "./tools";
import { layerForOffset, layerGuides, layerPrototypes } from "./pipe-layers";
export type { DecalSnap } from "./tools";
import { arrow, arrowLength, bounds, forwardOnScreen, GridMass, gridLineRanges } from "./view-aids";
import { boxEntities, drawLinkLines, LINK_COLORS } from "./link-overlay";
import { canHold, entityLabel, isConfigurator, linkable, linkLines, linkPanel, relations, secondClick, toggleDevice, type LinkLine } from "./multitool";
export type { SelectFilter } from "./selection";
export type { ShapeKind } from "./shapes";

/** An open map. */
export interface Session {
    name: string;
    doc: MapDocument;
    scene: Scene;
    pack: Pack;
}

export interface ControllerElements {
    canvas: HTMLCanvasElement;
    map: MapCanvas;
    palette: Palette;
    keymap: Keymap;
    /** Which centre of mass the Centre aid shows ("game", "entities" or "both"). */
    centreMode?: HTMLSelectElement;
    /** Properties column: one selected (or held) entity. */
    inspector?: Inspector;
    /** Properties column: the multitool's linking window. */
    linkPanel?: LinkPanel;
    /** Shows or hides the Properties column (it is shown only when it has something). */
    properties?: (shown: boolean) => void;
    /** Where tool choices that outlast a reload are kept (decal snap, Defaults). */
    prefs?: KeyStorage | null;
    /** The parallax background behind the map (the Parallax view layer). */
    parallax?: { readonly enabled: boolean; setEnabled(on: boolean): void; readonly animated: boolean; setAnimated(on: boolean): void };
    /** What goes above the components when the Properties column shows an entity (the parallax picker of the map). */
    propertiesTop?: (session: Session, uid: number) => HTMLElement | null;
}

/** The selected decals' fields for the options bar: the first one's values; `mixed` marks those that differ. */
export interface SelectedDecals {
    count: number;
    props: DecalProps;
    mixed: { color: boolean; alpha: boolean; angle: boolean; zIndex: boolean; cleanable: boolean };
}

/** The fields of some decals (at least one). */
export function decalFields(decals: readonly DecalProps[]): SelectedDecals | null {
    const first = decals[0];
    if (!first) return null;
    const differs = (f: (d: DecalProps) => unknown) => decals.some((d) => f(d) !== f(first));
    const { proto, color, angle, zIndex, cleanable } = first;
    return {
        count: decals.length,
        props: { proto, color, angle, zIndex, cleanable },
        mixed: {
            color: differs((d) => splitColor(d.color)[0]),
            alpha: differs((d) => splitColor(d.color)[1]),
            angle: differs((d) => d.angle),
            zIndex: differs((d) => d.zIndex),
            cleanable: differs((d) => d.cleanable),
        },
    };
}

/** Tools of the rail. */
export type Tool = "select" | "marquee" | "wand" | "brush" | "shapes" | "eraser" | "eyedropper" | "multitool";
export type MarqueeShape = "rect" | "ellipse" | "lasso";
export type EraseKind = "tiles" | "entities" | "decals";
export type SampleFrom = "any" | "entities" | "tiles" | "decals";

/** View layers: drawing options of the map and aids on the overlay. */
export type Layer = "subfloor" | "markers" | "powered" | "grid" | "centre" | "direction" | "links" | "decals" | "parallax";
export const LAYERS: readonly Layer[] = ["subfloor", "markers", "powered", "grid", "centre", "direction", "links", "decals", "parallax"];

/** View aids drawn on the overlay. */
export type Aid = "grid" | "centre" | "direction";

/** What the options bar of the active tool shows. */
export interface ToolOptions {
    tool: Tool;
    marquee: MarqueeShape;
    filter: SelectFilter;
    contiguous: boolean;
    choice: PaletteChoice;
    /** Degrees clockwise of entities placed. */
    rotation: number;
    /** Tile variant painted; null: a random one. */
    variant: number | null;
    /** Pipe layer of entities placed on one (0 primary, 1 secondary, 2 tertiary); null: the one under the cursor. */
    pipeLayer: number | null;
    decal: DecalProps;
    snap: DecalSnap;
    /** The snap was set by the picked decal's defaults (Defaults on), not chosen. */
    snapByDefaults: boolean;
    /** Picking a decal takes its default snap, cleanable and color. */
    auto: boolean;
    /**
     * The selected decals (selection tools): their shared fields, and which differ among them (shown as mixed);
     * null without selected decals.
     */
    decals: SelectedDecals | null;
    shape: ShapeKind;
    filled: boolean;
    erase: EraseKind;
    sample: SampleFrom;
    /** Label of the entity the multitool holds. */
    holding: string | null;
    /** What is selected ("3 entities, 12 tiles"), or null. */
    selection: string | null;
    pasting: boolean;
}

type Mode = "select" | "erase" | "place" | "paint" | "decal" | "link" | "shape" | "sample" | "idle";

/** Centres of mass the Centre aid draws. */
export type CentreMode = MassMode | "both";

/** Tools of the Select mode: pointer (click, drag what is under it, drag a box elsewhere), areas, wand. */
type SelectTool = "pointer" | "rect" | "ellipse" | "lasso" | "wand";

const FILTERS: readonly SelectFilter[] = ["all", "entities", "tiles", "decals"];

/** Clipboard bindings the browser turns into copy, cut and paste events. */
const NATIVE_CLIPBOARD: Record<string, string> = { "edit.copy": "Ctrl+KeyC", "edit.cut": "Ctrl+KeyX", "edit.paste": "Ctrl+KeyV" };

/** "3 entities, 12 tiles" (kinds with none left out). */
function counted(n: { entities: number; tiles: number; decals: number }): string {
    const part = (k: number, one: string, many: string) => (k ? `${k} ${k === 1 ? one : many}` : "");
    return [part(n.entities, "entity", "entities"), part(n.tiles, "tile", "tiles"), part(n.decals, "decal", "decals")].filter(Boolean).join(", ") || "nothing";
}
const MARQUEES: readonly MarqueeShape[] = ["rect", "ellipse", "lasso"];
const SHAPES: readonly ShapeKind[] = ["line", "rect", "ellipse"];
const SAMPLE_KINDS: Record<SampleFrom, StackKind[]> = { any: ["entity", "decal", "tile"], entities: ["entity"], tiles: ["tile"], decals: ["decal"] };
const CHOICE_KIND: Record<"entity" | "tile" | "decal", StackKind> = { entity: "entity", tile: "tile", decal: "decal" };
const PICK_FIRST = "Nothing chosen in the palette";
/** How long a message replaces the tool hint in the status bar. */
const MESSAGE_MS = 6000;

/** Pointer gesture in progress. */
type Gesture =
    | { kind: "pan"; x: number; y: number; view: { x: number; y: number; scale: number }; moved: boolean; then?: () => void }
    | { kind: "press"; uid: number; x: number; y: number }
    | { kind: "move" }
    | { kind: "place"; proto: string }
    | { kind: "paint"; tile: string }
    | { kind: "erase"; what: "entities" | "decals" }
    /** Placing decals: a click places one at `start`, a drag a line to `end`. */
    | { kind: "decal"; start: Point; end: Point; x: number; y: number; moved: boolean }
    /** Drawing an area with a selection tool; `click` runs instead when the pointer did not travel. */
    | { kind: "marquee"; tool: "rect" | "ellipse" | "lasso"; op: Combine; start: Point; end: Point; points: Point[]; x: number; y: number; moved: boolean; click: () => void; emptyBefore?: boolean }
    /** Pressed on the selection: a drag moves it, a click runs `click`. */
    | { kind: "pressGroup"; x: number; y: number; start: Point; click: () => void }
    /** Dragging the selection; ghosts of its layers when the map shows the move only once it is dropped. */
    | { kind: "groupMove"; ghosts: { sprites: SpriteLayer[]; tiles: TileLayer[]; decals: DecalLayer[] } | null }
    | { kind: "shape"; shape: ShapeKind; filled: boolean; brush: Brush; start: Point; end: Point; constrain: boolean };

const KIND_OF: Record<Kind, StackKind> = { entities: "entity", tiles: "tile", decals: "decal" };
const ERASE_COLOR = "#ff6b6b";
const INTO_COLOR = "#7dff8a";
const DRAG_PX = 4; // pointer travel before a press becomes a drag
const PAN_SPEED = 900; // CSS px per second while a pan key is held
const PAN_BOOST = 3; // Shift multiplies it
const ALPHA_HIT = 24; // texture alpha (0..255) that counts as drawn for picking

/** Direction the view moves for each pan action (the map moves opposite to the way you look). */
const PAN_DIRECTION: Record<string, [number, number]> = {
    "view.panUp": [0, 1],
    "view.panDown": [0, -1],
    "view.panLeft": [1, 0],
    "view.panRight": [-1, 0],
};

/** Whether keyboard input goes to a text field (the palette search) rather than the editor. */
const typing = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !["checkbox", "radio", "button", "file"].includes(t.type)) || t instanceof HTMLSelectElement);

export class EditorController {
    private session: Session | null = null;
    private editor: Editor | null = null;
    private unsubscribe: (() => void) | null = null;
    private choice: PaletteChoice = null;
    private tool: Tool = "select";
    private marquee: MarqueeShape = "rect";
    /** The wand takes connected items only (Ctrl inverts it). */
    private contiguous = true;
    private shapeKind: ShapeKind = "rect";
    private filled = false;
    private eraseKind: EraseKind = "tiles";
    private sampleFrom: SampleFrom = "any";
    /** Tile variant the brush paints; null: random. */
    private variant: number | null = null;
    /** Pipe layer of entities placed in the AlignAtmosPipeLayers mode; null: picked by the cursor, as in the game. */
    private pipeLayer: number | null = null;
    private filter: SelectFilter = "all";
    /** Called after every refresh (the shell redraws what changed). */
    onRefresh: (() => void) | null = null;
    /** The page is being left after the user chose what to do with unsaved edits: no leave prompt. */
    leaving = false;
    /** The status hint and the tile under the cursor, as of the last refresh. */
    hint = "";
    cursorText = "";
    private messageTimer = 0;
    /** A clipboard being pasted: its ghost follows the cursor until a click places it. */
    private pasting: { clip: Clip; turns: number } | null = null;
    /** The last clipboard text copied here (used when the system clipboard cannot be read). */
    private clipMemory: string | null = null;
    /** Text for the browser's copy or cut event that follows a Ctrl+C or Ctrl+X. */
    private copied: string | null = null;
    /** Ctrl+V was pressed: the browser's paste event brings the text, or the fallback runs. */
    private pastePending = false;
    /** Rotation of entities being placed (R turns it). */
    private placeRotation = 0;
    private gesture: Gesture | null = null;
    private hover: [number, number] | null = null;
    /** The cursor in viewport pixels (where the pick menu opens for a key). */
    private hoverClient: [number, number] | null = null;
    /** The menu of what lies under the cursor, and the item its pointer is on (highlighted on the map). */
    private readonly menu = new PickMenu();
    private menuHover: StackItem | null = null;
    /** Repeated left clicks at one spot step through what lies there. */
    private readonly cycle = new ClickCycle();
    private spaceHeld = false;
    private message = "";
    private readonly handlers = new Map<string, () => void>();
    private readonly aids: Record<Aid, boolean> = { grid: false, centre: false, direction: false };
    /** Links of the held or selected entity drawn on the overlay. */
    private showLinks = true;
    /** Tile areas of the grids (for grid lines and arrow lengths). */
    private areas: GridMass | null = null;
    private mass: MassCache | null = null;
    private centreMode: CentreMode = "game";
    /** What the next decal placed looks like (the prototype is the palette's choice). */
    private decalBrush: DecalProps = { proto: "", color: "#FFFFFFFF", angle: 0, zIndex: 0, cleanable: false };
    private decalSnap: DecalSnap = "tile";
    /** The placer's "Auto": picking a decal takes its default snap, cleanable and colour use (off, as in the game). */
    private decalAuto = false;
    /** The decal snap came from the picked decal's defaults. */
    private snapByDefaults = false;
    /** The selected decals' fields as of a selection version and map change (for the options bar). */
    private selectedDecalsCache: { key: string; value: SelectedDecals | null } = { key: "", value: null };
    /** The colour chosen in the panel, applied by decals that use a custom colour by default. */
    private pickedColor = "#FFFFFFFF";
    /** What the side panel shows, so it is rebuilt only when that changes. */
    private side: { key: string; session: Session | null } = { key: "", session: null };
    /** The entity the inspector shows. */
    private inspected: number | null = null;
    /** An entity opened in the Properties column without selecting it (the map, a grid); dropped by a selection. */
    private propertiesOf: number | null = null;
    /** Pan keys held: key code → direction the view moves. */
    private readonly held = new Map<string, [number, number]>();
    private shiftHeld = false;
    private panFrame = 0;
    /** The entity the multitool holds (the first one clicked). */
    private holding: number | null = null;
    /** The two entities the linking panel shows. */
    private linkPair: { source: number; sink: number } | null = null;
    /** The device under the cursor with the multitool. */
    private hoverDevice: number | null = null;
    /** Lines of the entity whose links are drawn, kept until it or the map changes. */
    private lines: { key: string; lines: LinkLine[]; members: number[] } | null = null;
    /** Container edits with the pack's checks, once the pack's data is loaded. */
    private contents: Contents | null = null;
    /** The container a drop or a Ctrl+click would put into (outlined), and what the status line says of it. */
    private into: { uid: number; ok: boolean; text: string } | null = null;
    private ctrlHeld = false;

    constructor(private readonly el: ControllerElements) {
        const { canvas, map } = el;
        const prefs = loadPrefs(el.prefs ?? null);
        this.decalSnap = prefs.decalSnap;
        this.decalAuto = prefs.decalAuto;
        map.overlay = (g, tilePx) => this.paintOverlay(g, tilePx);
        el.palette.onChange = (choice) => this.setChoice(choice);

        this.menu.onHover = (item) => {
            this.menuHover = item;
            this.refresh();
        };
        canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
        canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
        canvas.addEventListener("pointerup", (e) => this.pointerUp(e));
        canvas.addEventListener("pointercancel", () => this.endGesture(false));
        canvas.addEventListener("pointerleave", () => {
            this.hover = null;
            this.refresh();
        });
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
        canvas.addEventListener("dragover", (e) => this.dragOver(e));
        canvas.addEventListener("dragleave", () => this.setInto(null));
        canvas.addEventListener("drop", (e) => this.drop(e));
        window.addEventListener("keydown", (e) => {
            this.ctrlKey(e);
            this.keyDown(e);
        });
        const give = (e: ClipboardEvent) => {
            if (this.copied === null || typing(e.target)) return;
            e.clipboardData?.setData("text/plain", this.copied);
            e.preventDefault();
            this.copied = null;
        };
        document.addEventListener("copy", give);
        document.addEventListener("cut", give);
        document.addEventListener("paste", (e) => {
            if (!this.pastePending || typing(e.target)) return;
            this.pastePending = false;
            e.preventDefault();
            this.startPaste(e.clipboardData?.getData("text/plain") ?? null);
        });
        window.addEventListener("keyup", (e) => {
            this.ctrlKey(e);
            this.shiftHeld = e.shiftKey;
            this.constrainShape(e.shiftKey);
            this.held.delete(e.code);
            if (e.code !== "Space") return;
            this.spaceHeld = false;
            this.refresh();
        });
        window.addEventListener("blur", () => {
            this.spaceHeld = false;
            this.held.clear();
        });
        window.addEventListener("beforeunload", (e) => {
            if (!this.session?.doc.modified || this.leaving) return;
            e.preventDefault();
            e.returnValue = "";
        });

        this.registerHandlers();
        el.centreMode?.addEventListener("change", () => {
            this.setCentreMode(el.centreMode!.value as CentreMode);
            el.centreMode!.blur();
        });
        if (el.linkPanel) {
            el.linkPanel.onEdit = (message) => this.say(message);
            el.linkPanel.onSwap = () => {
                const p = this.linkPair;
                if (p) this.linkPair = { source: p.sink, sink: p.source };
                this.refresh();
            };
            el.linkPanel.onClose = () => {
                this.linkPair = null;
                this.refresh();
            };
        }
        this.refresh();
    }

    /** Shows a map (a new one, or the same document drawn with another build). */
    open(session: Session): void {
        this.endGesture(false);
        this.unsubscribe?.();
        const { doc, scene } = session;
        const { map } = this.el;
        const keep = this.session?.doc === doc ? this.editor?.selected.clone() ?? null : null;
        this.session = session;
        this.editor = new Editor(doc, scene, session.pack, {
            visible: (s) => map.visible(s),
            tilesShown: () => map.options.tiles,
            decalsShown: () => map.options.decals,
            opaque: (frame, tx, ty) => (map.frameAlpha(frame, tx, ty) ?? 255) >= ALPHA_HIT,
        });
        this.editor.moveSnap = this.decalSnap;
        if (keep) this.editor.selected.assign(keep);
        this.editor.validate();
        this.areas = new GridMass(scene);
        const { pack } = session;
        this.editor.variant = (name) => this.tileVariant(name);
        this.mass = new MassCache(scene, {
            tileDensity: pack.prototypes.tileDensity ?? 1,
            tileMass: (name) => pack.tile(name)?.mass ?? 0,
            entityUids: () => scene.entities.keys(),
            body: (uid) => {
                const p = scene.placement(uid);
                const proto = scene.entities.get(uid)?.[0];
                const def = proto === undefined ? undefined : pack.prototypes.entities[proto];
                if (!p || p.grid === null || !def?.mass) return null;
                return { grid: p.grid, x: p.x, y: p.y, rot: p.rot, mass: def.mass, centre: def.massCentre };
            },
        });
        this.unsubscribe = doc.onChange((change) => {
            const areas = scene.apply(change);
            // a rebuilt scene may have other grids; tile and entity edits move the centres of mass
            if (areas === null) {
                this.areas?.invalidate();
                this.mass?.invalidate();
            } else {
                this.areas?.update(change.tiles);
                // children move with their parents (read only when the mass with entities is in use)
                this.mass?.update(change.tiles, (function* () {
                    for (const uid of change.entities) {
                        yield uid;
                        yield* doc.descendants(uid);
                    }
                })());
            }
            map.update(areas);
            this.editor?.validate();
            // undo or a deletion can take the held entities away
            const gone = (uid: number | null | undefined) => uid != null && doc.proto(uid) === undefined;
            if (gone(this.holding)) this.holding = null;
            if (gone(this.linkPair?.source) || gone(this.linkPair?.sink)) this.linkPair = null;
            if (gone(this.hoverDevice)) this.hoverDevice = null;
            this.refresh();
        });
        this.holding = this.linkPair = this.hoverDevice = null;
        this.contents = null;
        this.into = null;
        void contentsKit(pack).then(
            (kit) => {
                if (this.session !== session) return;
                this.contents = new Contents(doc, kit);
                // the first container edit would scan the map; done while the editor is idle
                setTimeout(() => this.session === session && doc.prepareContainers(), 500);
            },
            () => {},
        );
        if (!keep) this.propertiesOf = null;
        this.lines = null;
        this.message = "";
        this.refresh();
    }

    /** The map entity of the open file, or null (shuttle files have none). */
    get mapUid(): number | null {
        return this.session?.doc.mapEntities()[0] ?? null;
    }

    /** Grids of the open file: uid and name (MetaData), in file order. */
    gridList(): Array<{ uid: number; name: string }> {
        const doc = this.session?.doc;
        if (!doc) return [];
        return doc.listedGrids().filter((uid) => doc.proto(uid) !== undefined).map((uid) => {
            const name = doc.components(uid).find((c) => c.type === "MetaData")?.data.name;
            return { uid, name: typeof name === "string" && name ? name : `Grid ${uid}` };
        });
    }

    /** Opens an entity (the map, a grid) in the Properties column; the selection is cleared. */
    openProperties(uid: number): void {
        const s = this.session, editor = this.editor;
        if (!s || !editor || s.doc.proto(uid) === undefined || editor.busy) return;
        this.endGesture(true);
        if (this.mode === "link") this.setTool("select");
        editor.deselect();
        this.propertiesOf = uid;
        this.refresh();
    }

    /** The map's properties: the map entity, or the first grid of a file without one. */
    openMapProperties(): void {
        const uid = this.mapUid ?? this.gridList()[0]?.uid;
        if (uid !== undefined) this.openProperties(uid);
    }

    /** Whether the open map has edits that are not saved. */
    get modified(): boolean {
        return !!this.session?.doc.modified;
    }

    /** The open map, or null. */
    get current(): Session | null {
        return this.session;
    }

    get mode(): Mode {
        switch (this.tool) {
            case "multitool": return "link";
            case "brush": return this.choice?.kind === "entity" ? "place" : this.choice?.kind === "tile" ? "paint" : this.choice?.kind === "decal" ? "decal" : "idle";
            case "shapes": return "shape";
            case "eraser": return "erase";
            case "eyedropper": return "sample";
            default: return "select";
        }
    }

    /** The active tool. */
    get activeTool(): Tool {
        return this.tool;
    }

    /** What the selection tools do on a press: the pointer of Select, a marquee shape or the wand. */
    private get selTool(): SelectTool {
        return this.tool === "marquee" ? this.marquee : this.tool === "wand" ? "wand" : "pointer";
    }

    /** The options bar of the active tool. */
    get options(): ToolOptions {
        const s = this.session, editor = this.editor;
        const sel = editor?.selected;
        return {
            tool: this.tool,
            marquee: this.marquee,
            filter: this.filter,
            contiguous: this.contiguous,
            choice: this.choice,
            rotation: Math.round((-this.placeRotation * 180) / Math.PI + 360) % 360,
            variant: this.variant,
            pipeLayer: this.pipeLayer,
            decal: this.decalBrush,
            snap: this.decalSnap,
            snapByDefaults: this.decalAuto && this.snapByDefaults,
            auto: this.decalAuto,
            decals: this.tool === "select" || this.tool === "marquee" || this.tool === "wand" ? this.selectedDecalFields() : null,
            shape: this.shapeKind,
            filled: this.filled,
            erase: this.eraseKind,
            sample: this.sampleFrom,
            holding: s && this.holding !== null ? entityLabel(s.doc, this.holding, s.pack) : null,
            selection: sel && !sel.isEmpty ? counted({ entities: sel.entities.size, tiles: sel.tileCount, decals: sel.decalCount }) : null,
            pasting: !!this.pasting,
        };
    }

    /** Switches tools; a gesture or a paste in progress is dropped. */
    setTool(tool: Tool): void {
        this.endGesture(true);
        this.pasting = null;
        if (tool !== "multitool" || this.tool !== "multitool") this.stopLinking();
        this.tool = tool;
        this.message = "";
        this.refresh();
    }

    setMarquee(shape: MarqueeShape): void {
        this.marquee = shape;
        if (this.tool !== "marquee") this.setTool("marquee");
        else this.refresh();
    }

    setContiguous(on: boolean): void {
        this.contiguous = on;
        this.refresh();
    }

    setShapeKind(shape: ShapeKind): void {
        this.shapeKind = shape;
        if (this.tool !== "shapes") this.setTool("shapes");
        else this.refresh();
    }

    setFilled(on: boolean): void {
        this.filled = on;
        this.refresh();
    }

    setEraseKind(kind: EraseKind): void {
        this.eraseKind = kind;
        if (this.tool !== "eraser") this.setTool("eraser");
        else this.refresh();
    }

    setSampleFrom(kind: SampleFrom): void {
        this.sampleFrom = kind;
        this.refresh();
    }

    setVariant(variant: number | null): void {
        this.variant = variant;
        this.refresh();
    }

    setPipeLayer(layer: number | null): void {
        this.pipeLayer = layer;
        this.refresh();
    }

    /**
     * The prototype placed for `proto` at a world point: for entities placed in the AlignAtmosPipeLayers mode, the
     * one of the chosen pipe layer, or of the layer the cursor points at within the tile.
     */
    private layered(proto: string, w: Point): string {
        const protos = this.session ? layerPrototypes(this.session.pack, proto) : null;
        return protos?.[this.pipeLayer ?? this.cursorLayer(proto, w)] ?? proto;
    }

    /** The pipe layer the game's placement picks for the cursor at a world point (AlignAtmosPipeLayers). */
    private cursorLayer(proto: string, w: Point): number {
        const t = this.editor?.placeTarget(proto, ...w);
        if (!t) return 0;
        const [cx, cy] = this.session!.scene.toWorld(t.grid, t.x, t.y);
        return layerForOffset(w[0] - cx, w[1] - cy);
    }

    /** A field of the decal brush changed (the options bar). */
    setDecalBrush(props: Partial<DecalProps>): void {
        this.decalBrush = { ...this.decalBrush, ...props };
        if (props.color) this.pickedColor = props.color;
        this.refresh();
    }

    /**
     * The decal snap, shared by the brush and the selection: where the brush places decals, and how selected
     * decals and free entities move (Tile: whole tiles, Corner: onto tile corners, Off: texture pixels).
     */
    setDecalSnap(snap: DecalSnap): void {
        this.decalSnap = snap;
        if (this.editor) this.editor.moveSnap = snap;
        this.snapByDefaults = false;
        this.savePrefs();
        this.refresh();
    }

    setDecalAuto(on: boolean): void {
        this.decalAuto = on;
        if (on) this.applyDecalDefaults();
        this.savePrefs();
        this.refresh();
    }

    /** Sets fields of every selected decal, as one undo step (the options bar). */
    setSelectedDecals(props: Partial<DecalProps> | ((d: DecalProps) => Partial<DecalProps>)): void {
        const n = this.editor?.setDecalProps(props) ?? 0;
        if (n) this.say(`Changed ${n} ${n === 1 ? "decal" : "decals"}`);
    }

    /** The selected decals' fields, from the first one, with those that differ marked. */
    private selectedDecalFields(): SelectedDecals | null {
        const editor = this.editor;
        if (!editor?.selected.decals.size) return null;
        const key = `${editor.selected.version}|${editor.changeCount}`;
        if (this.selectedDecalsCache.key !== key) this.selectedDecalsCache = { key, value: decalFields(editor.selectedDecals()) };
        return this.selectedDecalsCache.value;
    }

    /** Keeps the chosen snap (not one Defaults set) and Defaults. */
    private savePrefs(): void {
        const kept = loadPrefs(this.el.prefs ?? null);
        savePrefs(this.el.prefs ?? null, { decalSnap: this.snapByDefaults ? kept.decalSnap : this.decalSnap, decalAuto: this.decalAuto });
    }

    /** The variant of the next tile painted. */
    private tileVariant(name: string): number {
        const n = this.session?.pack.tile(name)?.variants ?? 1;
        if (this.variant === null) return n > 1 ? Math.floor(Math.random() * n) : 0;
        return this.variant < n ? this.variant : 0;
    }

    // ---- view layers and zoom

    layer(l: Layer): boolean {
        const o = this.el.map.options;
        switch (l) {
            case "subfloor": return o.subfloor;
            case "markers": return o.markers;
            case "powered": return o.powered;
            case "decals": return o.decals;
            case "links": return this.showLinks;
            case "parallax": return this.el.parallax?.enabled ?? false;
            default: return this.aids[l];
        }
    }

    setLayer(l: Layer, on: boolean): void {
        if (l === "subfloor" || l === "markers" || l === "powered" || l === "decals") this.el.map.setOptions({ [l]: on });
        else if (l === "links") this.showLinks = on;
        else if (l === "parallax") this.el.parallax?.setEnabled(on);
        else this.aids[l] = on;
        this.refresh();
    }

    /** Whether scrolling parallax layers drift (View > Animate parallax). */
    get parallaxAnimated(): boolean {
        return this.el.parallax?.animated ?? false;
    }

    setParallaxAnimated(on: boolean): void {
        this.el.parallax?.setAnimated(on);
        this.refresh();
    }

    /** CSS px per texture px. */
    get zoom(): number {
        return this.el.map.view.scale;
    }

    /** Zooms by a factor around the middle of the map view. */
    zoomBy(k: number): void {
        const c = this.el.canvas;
        this.zoomAt(c.clientWidth / 2, c.clientHeight / 2, k);
    }

    private zoomAt(px: number, py: number, k: number): void {
        const v = this.el.map.view;
        const scale = Math.min(8, Math.max(0.02, v.scale * k));
        const f = scale / v.scale;
        this.el.map.setView({ scale, x: px - (px - v.x) * f, y: py - (py - v.y) * f });
        this.notify();
    }

    /** Fits the whole map in the view. */
    fit(): void {
        const { map, canvas } = this.el;
        const { width, height } = map.size;
        const W = canvas.clientWidth, H = canvas.clientHeight;
        if (!width || !height || !W || !H) return;
        const scale = Math.min(W / width, H / height) * 0.9;
        map.setView({ x: (W - width * scale) / 2, y: (H - height * scale) / 2, scale });
        this.notify();
    }

    /** Selected entity uid, or null. */
    get selection(): number | null {
        return this.editor?.selection ?? null;
    }

    /** What the palette picked (the palette calls this). */
    setChoice(choice: PaletteChoice): void {
        this.endGesture(true);
        this.pasting = null;
        this.choice = choice;
        // choosing turns the brush on (the Shapes tool keeps drawing, with the new choice)
        if (choice && this.tool !== "brush" && this.tool !== "shapes") {
            this.stopLinking();
            this.tool = "brush";
        }
        this.message = "";
        // a decal brush keeps its colour, angle and the rest when another decal is picked, as the game's placer;
        // with Auto on it also takes the decal's defaults (DecalPlacerWindow.SelectDecal)
        if (choice?.kind === "decal") {
            this.decalBrush = { ...this.decalBrush, proto: choice.id };
            if (this.decalAuto) this.applyDecalDefaults();
        }
        this.placeRotation = 0;
        this.refresh();
    }

    /** Sets the brush's cleanable, colour and snap from the picked decal's prototype. */
    private applyDecalDefaults(): void {
        const proto = this.decalBrush.proto;
        const def = this.session?.pack.prototypes.decals[proto];
        if (!def) return;
        const d = decalBrushDefaults(def, this.pickedColor);
        this.decalBrush = { ...this.decalBrush, cleanable: d.cleanable, color: d.color };
        this.decalSnap = d.snap;
        if (this.editor) this.editor.moveSnap = d.snap;
        this.snapByDefaults = true;
    }

    /** Registers the handler of an action (later work adds its actions here or through `handle`). */
    handle(id: string, fn: () => void): void {
        this.handlers.set(id, fn);
    }

    /** Runs the handler of an action; false when there is none. */
    run(id: string): boolean {
        const fn = this.handlers.get(id);
        fn?.();
        return !!fn;
    }

    private registerHandlers(): void {
        this.handle("tool.select", () => this.setTool("select"));
        this.handle("tool.marquee", () => (this.tool === "marquee" ? this.setMarquee(MARQUEES[(MARQUEES.indexOf(this.marquee) + 1) % MARQUEES.length]!) : this.setTool("marquee")));
        this.handle("tool.selectRect", () => this.setMarquee("rect"));
        this.handle("tool.selectEllipse", () => this.setMarquee("ellipse"));
        this.handle("tool.lasso", () => this.setMarquee("lasso"));
        this.handle("tool.wand", () => this.setTool("wand"));
        this.handle("tool.brush", () => this.setTool("brush"));
        this.handle("tool.shapes", () => (this.tool === "shapes" ? this.setShapeKind(SHAPES[(SHAPES.indexOf(this.shapeKind) + 1) % SHAPES.length]!) : this.setTool("shapes")));
        this.handle("tool.shapeLine", () => this.setShapeKind("line"));
        this.handle("tool.shapeRect", () => this.setShapeKind("rect"));
        this.handle("tool.shapeEllipse", () => this.setShapeKind("ellipse"));
        this.handle("tool.shapeFill", () => {
            this.filled = !this.filled;
            this.say(this.filled ? "Filled shapes" : "Outlined shapes");
        });
        this.handle("tool.erase", () => this.setTool("eraser"));
        this.handle("tool.eyedropper", () => this.setTool("eyedropper"));
        this.handle("tool.multitool", () => this.setTool("multitool"));
        this.handle("select.all", () => {
            if (!this.editor || this.editor.busy) return;
            this.editor.selectAll(this.filter);
            this.say("");
        });
        this.handle("select.none", () => {
            if (this.gesture) return;
            this.propertiesOf = null;
            this.editor?.deselect();
            this.say("");
        });
        this.handle("select.filter", () => this.setFilter(FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length]!));
        this.handle("edit.nudgeUp", () => this.nudge(0, 1));
        this.handle("edit.nudgeDown", () => this.nudge(0, -1));
        this.handle("edit.nudgeLeft", () => this.nudge(-1, 0));
        this.handle("edit.nudgeRight", () => this.nudge(1, 0));
        this.handle("edit.rotateCw", () => this.rotate(-1));
        this.handle("edit.rotateCcw", () => this.rotate(1));
        this.handle("edit.delete", () => this.remove());
        this.handle("edit.undo", () => this.undo());
        this.handle("edit.redo", () => this.redo());
        this.handle("edit.copy", () => this.copy(false));
        this.handle("edit.cut", () => this.copy(true));
        this.handle("edit.paste", () => {
            // without the browser's paste event: the Clipboard API, else what was copied here
            const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
            if (read) read().then((t) => this.startPaste(t), () => this.startPaste(null));
            else this.startPaste(null);
        });
        this.handle("edit.cancel", () => {
            if (this.gesture) return this.endGesture(true);
            if (this.pasting) {
                this.pasting = null;
                return this.say("");
            }
            if (this.tool === "multitool" && (this.holding !== null || this.linkPair)) return this.release();
            this.propertiesOf = null;
            this.editor?.deselect();
            this.message = "";
            // the selection tools stay; the others give way to Select
            if (this.tool === "select" || this.tool === "marquee" || this.tool === "wand") this.refresh();
            else this.setTool("select");
        });
        this.handle("file.download", () => this.download());
        this.handle("view.zoomIn", () => this.zoomBy(1.25));
        this.handle("view.zoomOut", () => this.zoomBy(0.8));
        this.handle("view.fit", () => this.fit());
        const toggle = (id: string, l: Layer) => this.handle(id, () => this.setLayer(l, !this.layer(l)));
        toggle("view.subfloor", "subfloor");
        toggle("view.markers", "markers");
        toggle("view.powered", "powered");
        toggle("view.grid", "grid");
        toggle("view.centre", "centre");
        toggle("view.direction", "direction");
        toggle("view.links", "links");
        toggle("view.decals", "decals");
        toggle("view.parallax", "parallax");
    }

    /** Which centre of mass the Centre aid shows. */
    setCentreMode(mode: CentreMode): void {
        this.centreMode = mode;
        if (this.el.centreMode) this.el.centreMode.value = mode;
        this.refresh();
    }

    /**
     * The eyedropper: makes what lies under a world point the brush (the topmost of the kinds asked for). Several
     * decals there, sampling decals only: the menu asks which one.
     */
    private sample(w: Point, at: [number, number] | null, kinds: StackKind[] = SAMPLE_KINDS[this.sampleFrom]): void {
        const editor = this.editor;
        if (!editor) return;
        if (at && kinds.length === 1 && kinds[0] === "decal" && editor.stackAt(...w, { kinds }).length > 1) {
            this.openMenu(at, w, { kinds }, (item) => this.sampleItem(item));
            return;
        }
        const item = editor.stackAt(...w, { kinds })[0];
        if (!item) return this.say("Nothing to sample");
        this.sampleItem(item);
    }

    /** Right click with the eyedropper: the menu of what can be sampled under the cursor. */
    private sampleMenu(at: [number, number], w: Point): void {
        this.openMenu(at, w, { kinds: SAMPLE_KINDS[this.sampleFrom] }, (item) => this.sampleItem(item));
    }

    /** Makes an item on the map the brush: an entity's prototype and rotation, a tile, a decal's look. */
    private sampleItem(item: StackItem): void {
        const s = this.session;
        if (!s) return;
        if (item.kind === "decal") {
            const d = s.doc.decal(item.grid, item.id);
            if (d) this.takeDecal(d);
            return;
        }
        if (item.kind === "tile") {
            this.el.palette.select({ kind: "tile", id: item.id });
            return this.say(`Picked ${item.id}`);
        }
        const proto = s.doc.proto(item.uid);
        const id = proto ? s.pack.migrate(proto) : null;
        if (!id) return this.say("Nothing to pick");
        const rot = s.doc.transform(item.uid).rotation;
        this.el.palette.select({ kind: "entity", id });
        this.placeRotation = rot;
        this.say(`Picked ${id}`);
    }

    /** Makes a decal's look the brush. */
    private takeDecal(d: Pick<DecalProps, "proto" | "color" | "angle" | "zIndex" | "cleanable">): void {
        this.endGesture(true);
        this.pasting = null;
        this.el.palette.select({ kind: "decal", id: d.proto });
        this.decalBrush = { proto: d.proto, color: d.color, angle: d.angle, zIndex: d.zIndex, cleanable: d.cleanable };
        this.say(`Picked ${d.proto}`);
    }

    setFilter(filter: SelectFilter): void {
        this.filter = filter;
        this.refresh();
    }

    // -----------------------------------------------------------------------------------------
    // Commands

    rotate(turns: number): void {
        if (!this.editor || this.editor.busy) return;
        if (this.pasting) {
            this.pasting.turns = (this.pasting.turns + turns + 4) % 4;
            this.refresh();
        } else if (this.choice?.kind === "entity" && (this.tool === "brush" || this.tool === "shapes")) {
            this.placeRotation = (this.placeRotation + (turns * Math.PI) / 2) % (2 * Math.PI);
            this.refresh();
        } else if (this.choice?.kind === "decal" && (this.tool === "brush" || this.tool === "shapes")) {
            // whole degrees from 0 to 359, as the game's placer turns them (Angle.FromDegrees)
            const deg = (this.decalBrush.angle * 180) / Math.PI + turns * 90;
            const norm = ((deg % 360) + 360) % 360;
            this.decalBrush = { ...this.decalBrush, angle: (norm * Math.PI) / 180 };
            this.refresh();
        } else if (this.editor.rotateSelection(turns)) this.say(turns < 0 ? "Rotated clockwise" : "Rotated counter-clockwise");
    }

    remove(): void {
        if (!this.editor || this.editor.busy) return;
        const tiles = this.editor.selection === null ? this.editor.selected.tileCount : 0;
        const decals = this.editor.selection === null ? this.editor.selected.decalCount : 0;
        const removed = this.editor.deleteSelection();
        const parts = [
            removed.length > 1 ? `${removed.length} entities (with contents)` : removed.length ? "1 entity" : "",
            tiles ? `${tiles} tiles` : "",
            decals ? `${decals} ${decals === 1 ? "decal" : "decals"}` : "",
        ].filter(Boolean);
        if (parts.length) this.say(`Deleted ${parts.join(" and ")}`);
    }

    // -----------------------------------------------------------------------------------------
    // Multitool

    /** Lets go of everything the multitool holds. */
    private stopLinking(): void {
        this.holding = this.linkPair = this.hoverDevice = null;
    }

    /** Lets go of the held entity and closes the linking panel. */
    private release(): void {
        const had = this.holding !== null || !!this.linkPair;
        this.holding = this.linkPair = null;
        this.say(had ? "Released" : "");
    }

    /** Devices the multitool picks: entities with signal ports, a device list or on a network. */
    private deviceAt(w: Point): number | null {
        const s = this.session, editor = this.editor;
        if (!s || !editor) return null;
        return editor.pickAt(...w, (uid) => linkable(s.doc, uid, s.pack));
    }

    /** Kinds the selection filter takes, as stack kinds. */
    private stackKinds(): StackKind[] {
        return FILTER_KINDS[this.filter].map((k) => KIND_OF[k]);
    }

    /**
     * A left press at the spot of the last one steps to the next of the things there (entities, then decals),
     * wrapping around. Returns whether it did; the first press at a spot only notes it.
     */
    private cycleSelect(e: PointerEvent, w: Point): boolean {
        const editor = this.editor!, pack = this.session!.pack;
        const again = this.cycle.repeats(e.clientX, e.clientY);
        this.cycle.mark(e.clientX, e.clientY);
        if (!again) return false;
        const items = editor.stackAt(...w, { kinds: this.stackKinds().filter((k) => k !== "tile") });
        if (items.length < 2) return false;
        const i = nextIndex(items, editor.selected);
        editor.selectItem(items[i]!, "replace");
        this.message = `${i + 1} of ${items.length}: ${describe(items[i]!, pack).name}`;
        return true;
    }

    /** Opens the pick menu at a viewport point with what lies under a world point; false when nothing does. */
    private openMenu(at: [number, number], w: Point, opts: StackOptions, choose: (item: StackItem, e: MouseEvent | KeyboardEvent) => void): boolean {
        const items = this.editor?.stackAt(...w, opts) ?? [];
        if (!items.length) {
            this.say("Nothing here");
            return false;
        }
        this.menu.onChoose = choose;
        this.menu.open(at[0], at[1], items, this.session!.pack);
        return true;
    }

    /** Right click in Select mode: the menu of everything the filter takes under the cursor. */
    private selectMenu(at: [number, number], w: Point): void {
        const editor = this.editor!, pack = this.session!.pack;
        this.openMenu(at, w, { kinds: this.stackKinds() }, (item, e) => {
            editor.selectItem(item, e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");
            this.say(describe(item, pack).name);
        });
    }

    /** Right click with the multitool: releases what is held, else lists the devices under the cursor. */
    private linkRightClick(at: [number, number], w: Point): void {
        if (this.holding !== null || this.linkPair) return this.release();
        const { doc, pack } = this.session!;
        this.openMenu(at, w, { kinds: ["entity"], accept: (uid) => linkable(doc, uid, pack) }, (item) => {
            if (item.kind !== "entity") return;
            const c = canHold(doc, item.uid, pack);
            if (!c.ok) return this.say(c.reason);
            this.holding = item.uid;
            this.linkPair = null;
            this.say("");
        });
    }

    /** A left click with the multitool: hold a device, or act on a second one. */
    private multitoolClick(w: Point, preferLink: boolean): void {
        const { doc, pack } = this.session!;
        const uid = this.deviceAt(w);
        const label = (u: number) => entityLabel(doc, u, pack);
        if (uid === null) {
            this.message = "No device here";
            return;
        }
        if (this.holding === null) {
            const c = canHold(doc, uid, pack);
            if (!c.ok) return void (this.message = c.reason);
            this.holding = uid;
            this.linkPair = null;
            this.message = "";
            return;
        }
        const r = secondClick(doc, this.holding, uid, pack, preferLink);
        if (r.kind === "release") this.release();
        else if (r.kind === "refuse") this.message = r.reason;
        else if (r.kind === "list") {
            const t = toggleDevice(doc, r.config, r.device, pack);
            this.message = "reason" in t ? t.reason : `${t.done === "added" ? "Added" : "Removed"} ${label(r.device)} ${t.done === "added" ? "to" : "from"} ${label(r.config)}`;
        } else {
            this.linkPair = { source: r.source, sink: r.sink };
            const blocked = linkPanel(doc, r.source, r.sink, pack).blocked;
            this.message = blocked ?? `Linking ${label(r.source)} → ${label(r.sink)}`;
        }
    }

    /** The entity whose links the overlay draws (the held one, else the one selected), with its lines. */
    private focusLines(): { uid: number; lines: LinkLine[]; members: number[] } | null {
        const s = this.session, editor = this.editor;
        if (!s || !editor) return null;
        if (!this.showLinks) return null;
        const uid = this.mode === "link" ? this.holding : editor.selection;
        if (uid === null || s.doc.proto(uid) === undefined) return null;
        const key = `${uid}:${editor.changeCount}`;
        if (this.lines?.key !== key) {
            const r = relations(s.doc, uid);
            this.lines = { key, lines: linkLines(r, uid), members: r.devices };
        }
        return { uid, lines: this.lines.lines, members: this.lines.members };
    }

    // -----------------------------------------------------------------------------------------
    // Clipboard

    /** Copies (or cuts: copies and deletes as one undo step) the selection; returns the clipboard text. */
    private copy(cut: boolean): string | null {
        const editor = this.editor;
        if (!editor || editor.busy) return null;
        const clip = editor.copy();
        if (!clip) {
            this.say("Nothing selected");
            return null;
        }
        const text = clipText(clip);
        this.clipMemory = this.copied = text;
        try {
            void navigator.clipboard?.writeText(text).catch(() => {});
        } catch {
            // no Clipboard API: the copy event and the memory carry it
        }
        if (cut) editor.deleteSelection();
        this.say(`${cut ? "Cut" : "Copied"} ${counted(clipCounts(clip))}`);
        return text;
    }

    /** Starts pasting clipboard text (or what was copied here when it is not a map selection). */
    private startPaste(text: string | null): void {
        if (!this.editor) return;
        const clip = readClip(text) ?? readClip(this.clipMemory);
        if (!clip) return this.say("Clipboard is empty");
        // what is pasted becomes the selection: a selection tool takes it from there
        if (this.tool !== "select" && this.tool !== "marquee" && this.tool !== "wand") this.setTool("select");
        this.endGesture(true);
        this.pasting = { clip, turns: 0 };
        this.say("");
    }

    /** Places the clipboard being pasted at a world point. */
    private placePaste(w: Point): void {
        const p = this.pasting, editor = this.editor, s = this.session;
        if (!p || !editor || !s) return;
        const { pack } = s;
        const known: PasteKnown = {
            entity: (proto) => {
                const id = pack.migrate(proto);
                return id !== null && !!pack.prototypes.entities[id];
            },
            tile: (name) => !!pack.tile(name),
            decal: (proto) => !!pack.prototypes.decals[proto],
        };
        const r = editor.paste(p.clip, ...w, p.turns, known);
        if (!r) return this.say("No grid to paste on");
        this.pasting = null;
        const parts = [`Pasted ${counted({ entities: r.entities.length, tiles: r.tiles.length, decals: r.decals.length })}`];
        if (r.missing.length) parts.push(`${r.missing.length} missing in this build: ${r.missing.slice(0, 6).join(", ")}${r.missing.length > 6 ? ", …" : ""}`);
        if (r.onSpace) parts.push(`${r.onSpace} ${r.onSpace === 1 ? "decal" : "decals"} on space skipped`);
        if (r.entitiesOnSpace) parts.push(`${r.entitiesOnSpace} not pasted: no tile under ${r.entitiesOnSpace === 1 ? "it" : "them"}`);
        if (r.dropped) parts.push(`${r.dropped} ${r.dropped === 1 ? "link" : "links"} dropped`);
        this.say(parts.join(", "));
    }

    /** Moves the selection a tile in a screen direction (as the world goes: y up). */
    nudge(dx: number, dy: number): void {
        if (!this.editor || this.editor.busy || this.gesture) return;
        if (this.editor.nudge(dx, dy)) this.say("Moved");
    }

    undo(): void {
        if (!this.editor) return;
        if (this.editor.busy) return this.endGesture(true);
        const label = this.editor.undo();
        if (label) this.say(`Undid ${label.toLowerCase()}`);
    }

    redo(): void {
        if (!this.editor || this.editor.busy) return;
        const label = this.editor.redo();
        if (label) this.say(`Redid ${label.toLowerCase()}`);
    }

    /**
     * Downloads the map as a file under its name. The map's saved state is the browser library's (Save), so this
     * does not mark it saved.
     */
    download(): void {
        if (!this.session) return;
        this.endGesture(false);
        const { doc, name } = this.session;
        const blob = new Blob([doc.serialize()], { type: "text/yaml" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        this.say(`Downloaded ${name}`);
    }

    /** The open map's text as it would be saved now (an open gesture is closed first), or null. */
    text(): string | null {
        if (!this.session) return null;
        this.endGesture(false);
        return this.session.doc.serialize();
    }

    /** Gives the open map another name (Save as). */
    rename(name: string): void {
        if (!this.session) return;
        this.session.name = name;
        this.refresh();
    }

    /** Shows a message in the status bar in place of the tool hint, for a few seconds or until the next one. */
    say(message: string): void {
        this.message = message;
        clearTimeout(this.messageTimer);
        if (message) {
            this.messageTimer = window.setTimeout(() => {
                if (this.message !== message) return;
                this.message = "";
                this.refresh();
            }, MESSAGE_MS);
        }
        this.refresh();
    }

    // -----------------------------------------------------------------------------------------
    // Containers

    /** Display name of an entity: its MetaData name, else its prototype's, else the id. */
    private nameOf(uid: number): string {
        const s = this.session!;
        const meta = s.doc.components(uid).find((c) => c.type === "MetaData")?.data.name;
        if (typeof meta === "string" && meta) return meta;
        return this.protoName(s.doc.proto(uid) ?? String(uid));
    }

    private protoName(proto: string): string {
        const pack = this.session!.pack;
        return pack.prototypes.entities[pack.migrate(proto) ?? proto]?.name || proto;
    }

    /** The topmost entity with containers at a world point, other than `item` and what it holds. */
    private containerAt(w: Point, item: number | null): number | null {
        const c = this.contents, editor = this.editor;
        if (!c || !editor) return null;
        const inside = item === null ? null : new Set(c.doc.descendants(item));
        return editor.pickAt(...w, (u) => u !== item && !inside?.has(u) && c.hasContainers(u));
    }

    /** The container under a world point that an item would go into, or why it would not; null without one. */
    private intoAt(w: Point | null, item: number | { proto: string } | null): { uid: number; ok: boolean; text: string } | null {
        const c = this.contents;
        if (!w || item === null || !c) return null;
        const owner = this.containerAt(w, typeof item === "number" ? item : null);
        if (owner === null) return null;
        const t = c.target(owner, item);
        const name = typeof item === "number" ? this.nameOf(item) : this.protoName(item.proto);
        return "id" in t ? { uid: owner, ok: true, text: `Put ${name} in ${this.nameOf(owner)}` } : { uid: owner, ok: false, text: t.reason };
    }

    /** The Ctrl target of the pointer: the brush's entity or the dragged one, over a container. */
    private pointerInto(): { uid: number; ok: boolean; text: string } | null {
        if (!this.ctrlHeld || !this.hover || !this.editor) return null;
        const g = this.gesture;
        if (g?.kind === "move") return this.intoAt(this.hover, this.editor.dragging);
        if (!g && this.mode === "place" && this.choice) return this.intoAt(this.hover, { proto: this.choice.id });
        return null;
    }

    /** Ctrl pressed or released: the target outline follows without moving the pointer. */
    private ctrlKey(e: KeyboardEvent): void {
        if (e.key !== "Control" && e.key !== "Meta") return;
        const held = e.type === "keydown";
        if (held === this.ctrlHeld) return;
        this.ctrlHeld = held;
        this.setInto(this.pointerInto());
    }

    private setInto(into: { uid: number; ok: boolean; text: string } | null): void {
        const was = this.into;
        if (was?.uid === into?.uid && was?.ok === into?.ok && was?.text === into?.text) return;
        this.into = into;
        this.refresh();
    }

    /** Puts an item into the container it fits in best (one undo step) and says so; false when refused. */
    private putInto(owner: number, item: number | { proto: string }): boolean {
        const c = this.contents;
        if (!c) return false;
        const name = typeof item === "number" ? this.nameOf(item) : this.protoName(item.proto);
        const t = c.target(owner, item);
        const r = "id" in t ? c.put(owner, t.id, item) : { ok: false as const, reason: t.reason };
        if (!r.ok) {
            this.say(r.reason);
            showToast(r.reason, undefined, 4000);
            return false;
        }
        const text = `Put ${name} in ${this.nameOf(owner)}`;
        this.say(text);
        showToast(text, { label: "Undo", run: () => this.undo() }, 4000);
        return true;
    }

    /** What is dragged onto the map: a palette entity or a stored entity (from the Contents section). */
    private draggedItem(): number | { proto: string } | null {
        const d = dragged();
        if (d?.kind === "uid") return this.session?.doc.proto(d.uid) !== undefined ? d.uid : null;
        return d?.kind === "entry" && d.entry.kind === "entity" ? { proto: d.entry.id } : null;
    }

    private dragOver(e: DragEvent): void {
        const item = this.draggedItem();
        const editor = this.editor, s = this.session;
        if (!isOurs(e) || item === null || !editor || !s || editor.busy) return;
        const w = this.worldAt(e);
        this.hover = w;
        const into = this.intoAt(w, item);
        const proto = typeof item === "number" ? s.doc.proto(item)! : item.proto;
        if (!into && !(w && editor.placeTarget(proto, ...w))) {
            if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
            return this.setInto(null);
        }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = typeof item === "number" ? "move" : "copy";
        this.setInto(into);
    }

    /** A drop on the map: into the container under it, else onto the floor (placed, or taken out there). */
    private drop(e: DragEvent): void {
        const item = this.draggedItem();
        const editor = this.editor, s = this.session;
        if (!isOurs(e) || item === null || !editor || !s || editor.busy) return;
        e.preventDefault();
        e.stopPropagation();
        setDragged(null);
        this.into = null;
        const w = this.worldAt(e);
        const into = this.intoAt(w, item);
        if (into) this.putInto(into.uid, item);
        else if (w) {
            const proto = typeof item === "number" ? s.doc.proto(item)! : this.layered(item.proto, w);
            const t = editor.placeTarget(proto, ...w);
            if (!t) this.message = "Needs a tile";
            else if (typeof item === "number") {
                if (s.doc.containerOf(item)) {
                    s.doc.removeFromContainer(item, { grid: t.grid, x: t.x, y: t.y }, this.contents?.kit.pack);
                    this.message = `Took out ${this.nameOf(item)}`;
                }
            } else if (editor.place(proto, ...w, this.placeRotation) !== null) this.message = `Placed ${this.protoName(proto)}`;
            else this.message = `${proto} is already there`;
        }
        this.refresh();
    }

    // -----------------------------------------------------------------------------------------
    // Pointer

    private worldAt(e: MouseEvent): [number, number] | null {
        const r = this.el.canvas.getBoundingClientRect();
        return this.el.map.worldAt(e.clientX - r.left, e.clientY - r.top);
    }

    private pointerDown(e: PointerEvent): void {
        const editor = this.editor;
        if (!editor || this.gesture) return;
        const w = this.worldAt(e);
        if (!w) return;
        this.el.canvas.setPointerCapture(e.pointerId);
        const pan = (then?: () => void): Gesture => ({ kind: "pan", x: e.clientX, y: e.clientY, view: { ...this.el.map.view }, moved: false, then });
        const mode = this.mode;
        if (e.button !== 0 || mode !== "select") this.cycle.reset();
        const bound = e.button === 0 || e.button === 2 ? null : this.el.keymap.lookup(chordOfMouse(e));
        if (e.button === 1) {
            e.preventDefault(); // no autoscroll
            // a click without moving runs the bound action, a drag pans
            this.gesture = pan(bound && !bound.boost ? () => this.run(bound.action.id) : undefined);
        } else if (bound && !bound.boost) this.run(bound.action.id);
        else if (e.button === 0 && this.spaceHeld) this.gesture = pan();
        else if (e.button === 2) {
            if (this.pasting) {
                this.pasting = null;
                this.message = "";
            } else if (mode === "shape" && this.choice?.kind === "tile") this.startShape(this.shapeKind, { kind: "tile", id: "Space" }, w);
            else if (mode === "paint") this.startPaint("Space", w);
            // right click stops placing (with the multitool: releases the held device); a right drag pans
            else {
                const at: [number, number] = [e.clientX, e.clientY];
                this.gesture = pan(
                    mode === "place" || mode === "decal" ? () => this.setTool("select")
                    : mode === "link" ? () => this.linkRightClick(at, w)
                    : mode === "select" ? () => this.selectMenu(at, w)
                    : mode === "sample" ? () => this.sampleMenu(at, w)
                    : undefined,
                );
            }
        } else if (e.button === 0) {
            const at: [number, number] = [e.clientX, e.clientY];
            if (this.pasting) this.placePaste(w);
            else if (mode === "link") this.multitoolClick(w, e.shiftKey);
            else if (mode === "sample") this.sample(w, at);
            else if (e.altKey && this.choice && (mode === "place" || mode === "paint" || mode === "decal")) this.sample(w, at, [CHOICE_KIND[this.choice.kind]]);
            else if ((e.ctrlKey || e.metaKey) && mode === "place" && this.choice) {
                const item = { proto: this.choice.id };
                const into = this.intoAt(w, item);
                if (into) this.putInto(into.uid, item);
                else this.message = this.contents ? "No container here" : "Loading container data";
            }
            else if (mode === "shape") {
                const brush = this.brush();
                if (brush) this.startShape(this.shapeKind, brush.kind === "entity" ? { ...brush, id: this.layered(brush.id, w) } : brush, w);
                else this.message = PICK_FIRST;
            } else if (mode === "decal") {
                this.gesture = { kind: "decal", start: w, end: w, x: e.clientX, y: e.clientY, moved: false };
                this.message = "";
            } else if (mode === "select") {
                this.message = "";
                this.selectPress(e, w);
            } else if (mode === "place" && this.choice) {
                // a drag keeps the pipe layer of its first tile, as the game's line placement
                const proto = this.layered(this.choice.id, w);
                this.gesture = { kind: "place", proto };
                this.message = "";
                editor.beginStroke("Place");
                if (editor.place(proto, ...w, this.placeRotation) === null) {
                    this.message = editor.placeTarget(proto, ...w) ? `${proto} is already there` : "Needs a tile";
                }
            } else if (mode === "paint" && this.choice) this.startPaint(this.choice.id, w);
            else if (mode === "erase") {
                if (this.eraseKind === "tiles") this.startPaint("Space", w);
                else this.startErase(this.eraseKind, w);
            } else if (mode === "idle") this.message = PICK_FIRST;
        }
        this.refresh();
    }

    /**
     * Left press in Select mode, by tool: select, start an area, run the wand or pick up the selection. The
     * area tools always draw a new area; the selection is dragged with the Select tool, or with Ctrl held
     * (as the Move tool in image editors).
     */
    private selectPress(e: PointerEvent, w: Point): void {
        const editor = this.editor!;
        const emptyBefore = editor.selected.isEmpty;
        const op: Combine = e.shiftKey ? "add" : e.altKey ? "subtract" : "replace";
        const ctrl = e.ctrlKey || e.metaKey;
        const filter = this.filter, wand = this.tool === "wand", tool = this.selTool;
        if (op !== "replace" || wand || ctrl) this.cycle.reset();
        else if (this.cycleSelect(e, w)) return;
        const everywhere = this.contiguous ? ctrl : !ctrl;
        const click = () => (wand ? editor.wand(...w, filter, op, everywhere) : editor.clickSelect(...w, filter, op));
        if (op === "replace" && (tool === "pointer" || ctrl) && !editor.selected.isEmpty && editor.onSelection(...w)) {
            this.gesture = { kind: "pressGroup", x: e.clientX, y: e.clientY, start: w, click };
            return;
        }
        if (wand) return click();
        if (tool === "pointer" && op === "replace") {
            const uid = this.filter === "tiles" ? null : editor.selectAt(...w);
            if (uid !== null) {
                this.gesture = { kind: "press", uid, x: e.clientX, y: e.clientY };
                return;
            }
        }
        this.gesture = { kind: "marquee", tool: tool === "pointer" ? "rect" : (tool as MarqueeShape), op, start: w, end: w, points: [w], x: e.clientX, y: e.clientY, moved: false, click, emptyBefore };
    }

    /** What shapes are drawn with: the palette choice (a decal with the brush's look), or null. */
    private brush(): Brush | null {
        const c = this.choice;
        if (!c) return null;
        return c.kind === "decal" ? { kind: "decal", id: c.id, props: { ...this.decalBrush } } : c;
    }

    /** Places the decal click or line of a gesture. */
    private placeDecalGesture(g: Extract<Gesture, { kind: "decal" }>): void {
        const editor = this.editor!;
        const line = g.moved ? editor.decalLine(g.start, g.end, this.decalSnap) : null;
        const one = line ? null : editor.decalTarget(...g.start, this.decalSnap);
        const grid = line?.grid ?? one?.grid;
        if (grid === undefined) return void (this.message = "No grid to place on");
        const ids = editor.placeDecals(this.decalBrush, grid, line ? line.points : [[one!.x, one!.y]]);
        this.message = !ids.length ? "Decals need a tile" : ids.length > 1 ? `Placed ${ids.length} ${this.decalBrush.proto}` : "";
    }

    /** Shift pressed or let go while a shape is drawn: the preview follows at once. */
    private constrainShape(shift: boolean): void {
        const g = this.gesture;
        if (g?.kind !== "shape" || g.constrain === shift) return;
        g.constrain = shift;
        this.el.map.drawOverlay();
    }

    private startShape(shape: ShapeKind, brush: Brush, w: Point): void {
        this.gesture = { kind: "shape", shape, filled: this.filled, brush, start: w, end: w, constrain: this.shiftHeld };
        this.message = "";
    }

    private areaOf(g: Extract<Gesture, { kind: "marquee" }>): Area {
        return g.tool === "lasso" ? { kind: "polygon", points: g.points } : { kind: g.tool, a: g.start, b: g.end };
    }

    /** Layers of the selection being dragged, drawn moved until it is dropped. */
    private ghostsOfDrag(): { sprites: SpriteLayer[]; tiles: TileLayer[]; decals: DecalLayer[] } {
        const { scene, doc } = this.session!;
        const group = this.editor!.groupMove!.group;
        const sprites: SpriteLayer[] = [];
        for (const m of group.movers) {
            for (const u of [m.uid, ...doc.descendants(m.uid)]) for (const l of scene.layersOf(u)) if (this.el.map.visible(l)) sprites.push(l);
        }
        const tiles: TileLayer[] = [];
        for (const [g, cells] of group.tiles) {
            for (const k of cells.keys()) {
                const [x, y] = cellOf(k);
                const [wx, wy] = scene.toWorld(g, x + 0.5, y + 0.5);
                const t = scene.tiles.query(wx, wy, wx, wy).find((t) => t.grid === g && Math.abs(t.x - wx) < 1e-3 && Math.abs(t.y - wy) < 1e-3);
                if (t) tiles.push(t);
            }
        }
        const decals = group.decals.map((d) => scene.decalLayer(d.grid, d.id)).filter((d): d is DecalLayer => !!d).sort((a, b) => a.z - b.z || a.seq - b.seq);
        return { sprites: Scene.sortSprites(sprites), tiles, decals };
    }

    private startErase(what: "entities" | "decals", w: Point): void {
        this.gesture = { kind: "erase", what };
        this.editor!.beginStroke("Erase");
        this.editor!.erase(what, ...w);
    }

    private startPaint(tile: string, w: [number, number]): void {
        this.gesture = { kind: "paint", tile };
        this.editor!.beginStroke(tile === "Space" ? "Erase" : "Paint");
        this.editor!.paint(tile, ...w);
    }

    private pointerMove(e: PointerEvent): void {
        const w = this.worldAt(e);
        this.hover = w;
        this.ctrlHeld = e.ctrlKey || e.metaKey;
        this.hoverClient = [e.clientX, e.clientY];
        const g = this.gesture, editor = this.editor;
        if (this.mode === "link") this.hoverDevice = !g && w ? this.deviceAt(w) : null;
        if (g && editor && w) {
            if (g.kind === "pan") {
                if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= DRAG_PX) g.moved = true;
                this.el.map.setView({ ...g.view, x: g.view.x + e.clientX - g.x, y: g.view.y + e.clientY - g.y });
            } else if (g.kind === "press") {
                if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= DRAG_PX) {
                    this.cycle.reset();
                    // the move starts where the press was, so the entity keeps its offset from the cursor
                    const r = this.el.canvas.getBoundingClientRect();
                    const start = this.el.map.worldAt(g.x - r.left, g.y - r.top)!;
                    editor.beginMove(g.uid, ...start);
                    this.gesture = { kind: "move" };
                    editor.dragTo(...w);
                }
            } else if (g.kind === "marquee") {
                if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= DRAG_PX) {
                    g.moved = true;
                    this.cycle.reset();
                }
                g.end = w;
                const last = this.el.map.screenAt(...g.points.at(-1)!), now = this.el.map.screenAt(...w);
                if (g.tool === "lasso" && Math.hypot(now[0] - last[0], now[1] - last[1]) >= 3) g.points.push(w);
            } else if (g.kind === "pressGroup") {
                if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= DRAG_PX) {
                    const one = editor.selection;
                    if (one !== null) {
                        editor.beginMove(one, ...g.start);
                        this.gesture = { kind: "move" };
                        editor.dragTo(...w);
                    } else if (editor.beginGroupMove(...g.start)) {
                        this.gesture = { kind: "groupMove", ghosts: editor.groupMove!.live ? null : this.ghostsOfDrag() };
                        editor.groupDragTo(...w);
                    } else this.gesture = null;
                }
            } else if (g.kind === "groupMove") editor.groupDragTo(...w);
            else if (g.kind === "shape") {
                g.end = w;
                g.constrain = e.shiftKey;
            }
            else if (g.kind === "decal") {
                if (Math.hypot(e.clientX - g.x, e.clientY - g.y) >= DRAG_PX) g.moved = true;
                g.end = w;
            }
            else if (g.kind === "move") editor.dragTo(...w);
            else if (g.kind === "place") editor.place(g.proto, ...w, this.placeRotation);
            else if (g.kind === "paint") editor.paint(g.tile, ...w);
            else if (g.kind === "erase") editor.erase(g.what, ...w);
        }
        this.into = this.pointerInto();
        this.refresh();
    }

    private pointerUp(e: PointerEvent): void {
        if (this.el.canvas.hasPointerCapture(e.pointerId)) this.el.canvas.releasePointerCapture(e.pointerId);
        this.ctrlHeld = e.ctrlKey || e.metaKey;
        this.endGesture(false);
    }

    /** Ends the gesture in progress: committed as one undo step, or reverted with `revert`. */
    private endGesture(revert: boolean): void {
        const g = this.gesture;
        this.gesture = null;
        if (g?.kind === "pan" && !g.moved && !revert) g.then?.();
        const editor = this.editor;
        if (editor && !revert) {
            if (g?.kind === "marquee") {
                if (g.moved) editor.selectArea(this.areaOf(g), this.filter, g.op);
                else {
                    g.click();
                    // a click on empty space (no entity, decal or tile) with nothing selected opens the map's properties
                    if (g.emptyBefore && editor.selected.isEmpty && g.op === "replace" && this.selTool === "pointer" && this.tool === "select" && !editor.tileUnder(...g.start)) this.openMapProperties();
                }
            } else if (g?.kind === "pressGroup") g.click();
            else if (g?.kind === "decal") this.placeDecalGesture(g);
            else if (g?.kind === "shape") {
                const n = editor.drawShape(g.shape, g.filled, g.brush, g.start, g.end, this.placeRotation, g.constrain);
                const what = g.brush.kind !== "tile" ? `Placed ${n} ${g.brush.id}` : g.brush.id === "Space" ? `Erased ${n} tiles` : `Painted ${n} tiles`;
                this.message = n ? what : "Nothing changed";
            }
        }
        // Ctrl held on the drop: into the container under the cursor instead
        const into = this.into;
        this.into = null;
        if (editor && !revert && g?.kind === "move" && into?.ok && this.ctrlHeld && editor.dragging !== null) {
            const uid = editor.dragging;
            editor.cancel();
            if (this.putInto(into.uid, uid)) editor.selection = into.uid;
        }
        if (editor?.busy) {
            if (revert) editor.cancel();
            else if (editor.finish() && (g?.kind === "move" || g?.kind === "groupMove")) this.message = "Moved";
        }
        this.refresh();
    }

    private wheel(e: WheelEvent): void {
        e.preventDefault();
        const r = this.el.canvas.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
    }

    // -----------------------------------------------------------------------------------------
    // Keyboard (by key position, so shortcuts work with any layout)

    private keyDown(e: KeyboardEvent): void {
        this.shiftHeld = e.shiftKey;
        this.constrainShape(e.shiftKey);
        const chord = chordOfKey(e);
        const found = chord ? this.el.keymap.lookup(chord) : null;
        // Escape stops a gesture even from a text field
        if (found?.action.id === "edit.cancel" && this.gesture) return this.endGesture(true);
        if (typing(e.target)) return;
        if (found && chord && NATIVE_CLIPBOARD[found.action.id] === formatChord(chord)) {
            // the browser's copy, cut and paste events follow: they carry the text across tabs
            if (found.action.id === "edit.paste") {
                this.pastePending = true;
                setTimeout(() => {
                    if (!this.pastePending) return;
                    this.pastePending = false;
                    this.run("edit.paste");
                });
            } else if (!e.repeat) this.run(found.action.id);
        } else if (found) {
            e.preventDefault();
            if (found.action.hold) {
                const dir = PAN_DIRECTION[found.action.id];
                if (dir) {
                    this.held.set(e.code, dir);
                    this.startPan();
                }
            } else if (!(e.repeat && /^(view|tool|file|select)\./.test(found.action.id))) this.run(found.action.id);
        } else if (e.code === "Space" && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            if (!this.spaceHeld) {
                this.spaceHeld = true;
                this.refresh();
            }
        }
    }

    /** Moves the view while pan keys are held, at a constant screen speed. */
    private startPan(): void {
        if (this.panFrame) return;
        let last = performance.now();
        const tick = (now: number) => {
            if (!this.held.size) {
                this.panFrame = 0;
                return;
            }
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            let dx = 0, dy = 0;
            for (const [x, y] of this.held.values()) {
                dx += x;
                dy += y;
            }
            const len = Math.hypot(dx, dy);
            if (len > 0) {
                const step = (PAN_SPEED * (this.shiftHeld ? PAN_BOOST : 1) * dt) / len;
                const v = this.el.map.view;
                this.el.map.setView({ ...v, x: v.x + dx * step, y: v.y + dy * step });
            }
            this.panFrame = requestAnimationFrame(tick);
        };
        this.panFrame = requestAnimationFrame(tick);
    }

    // -----------------------------------------------------------------------------------------
    // Toolbar, status line and overlay

    private refresh(): void {
        const { canvas, map } = this.el;
        const editor = this.editor;
        const mode = this.mode;
        const g = this.gesture;
        canvas.style.cursor =
            g?.kind === "pan" ? "grabbing"
            : this.spaceHeld ? "grab"
            : g?.kind === "move" || g?.kind === "groupMove" ? "move"
            : mode === "select" && this.selTool === "pointer" && g?.kind !== "marquee" && !this.pasting ? "default"
            : mode === "link" ? (this.hoverDevice !== null ? "pointer" : "default")
            : mode === "idle" ? "not-allowed"
            : "crosshair";

        this.hint = this.into?.text ?? this.message;
        const t = this.hover && editor ? editor.tileTarget(...this.hover) : null;
        this.cursorText = t ? `${t.x}, ${t.y}  grid ${t.grid}` : "";
        map.drawOverlay();
        this.refreshSide();
        this.notify();
    }

    /** Tells the shell to redraw what changed. */
    private notify(): void {
        this.onRefresh?.();
    }

    /** Whether undo, redo and save have something to do; whether a gesture is open. */
    get status(): { open: boolean; canUndo: boolean; canRedo: boolean; modified: boolean; busy: boolean; canRotate: boolean } {
        const s = this.session, editor = this.editor;
        const busy = !!editor?.busy;
        const brushTurns = !!this.choice && this.choice.kind !== "tile" && (this.tool === "brush" || this.tool === "shapes");
        return {
            open: !!s,
            canUndo: !!s && (busy || s.doc.canUndo),
            canRedo: !!s && !busy && s.doc.canRedo,
            modified: !!s?.doc.modified,
            busy,
            canRotate: !!s && !busy && (brushTurns || !!this.pasting || !editor!.selected.isEmpty),
        };
    }

    /**
     * The Properties column: the linking panel or the held entity's inspector with the multitool, else the inspector
     * for exactly one selected entity (hidden otherwise; the selected decals' fields are in the options bar).
     * Rebuilt only when what it shows changed.
     */
    private refreshSide(): void {
        const { inspector, linkPanel } = this.el;
        const s = this.session, editor = this.editor;
        let key = "none";
        if (s && editor) {
            if (this.mode === "link") key = this.linkPair && linkPanel ? `link|${this.linkPair.source}|${this.linkPair.sink}` : this.holding !== null ? `entity|${this.holding}` : "none";
            else if (editor.selection !== null) key = `entity|${editor.selection}`;
            if (!editor.selected.isEmpty) this.propertiesOf = null;
            else if (this.propertiesOf !== null && s.doc.proto(this.propertiesOf) === undefined) this.propertiesOf = null;
            if (key === "none" && this.mode !== "link" && this.propertiesOf !== null) key = `entity|${this.propertiesOf}`;
        }
        if (key === this.side.key && s === this.side.session) return;
        const session = this.side.session;
        this.side = { key, session: s };
        const kind = key.split("|")[0];
        linkPanel?.show(kind === "link" && s ? { doc: s.doc, pack: s.pack, ...this.linkPair! } : null);
        if (inspector) {
            inspector.container.hidden = kind !== "entity";
            const uid = kind === "entity" ? Number(key.split("|")[1]) : null;
            if (uid !== this.inspected || s !== session) inspector.show(uid !== null && s ? { doc: s.doc, pack: s.pack, uid, scene: s.scene, top: this.el.propertiesTop?.(s, uid) ?? null } : null);
            this.inspected = uid;
        }
        this.el.properties?.(kind !== "none");
    }


    private paintOverlay(g: CanvasRenderingContext2D, tilePx: number): void {
        const s = this.session, editor = this.editor;
        if (!s || !editor) return;
        const mode = this.mode;
        g.imageSmoothingEnabled = false;
        this.drawAids(g, tilePx);
        const c: OverlayContext = { g, map: this.el.map, scene: s.scene, width: this.el.canvas.clientWidth, height: this.el.canvas.clientHeight };
        this.drawSelection(c);
        this.drawLinks(c);
        this.drawMenuHover(c);
        if (this.into) boxEntities(c, [this.into.uid], this.into.ok ? INTO_COLOR : ERASE_COLOR, 2.5);
        const gesture = this.gesture;
        if (gesture?.kind === "marquee" && gesture.moved) return drawArea(c, this.areaOf(gesture));
        if (gesture?.kind === "shape") return this.drawShapeGhost(c, gesture);
        if (gesture?.kind === "decal") return this.drawDecalGhost(c, gesture.start, gesture.moved ? gesture.end : null);
        if (this.pasting && this.hover && !gesture) return this.drawPasteGhost(c, this.pasting, this.hover);
        if (!this.hover || gesture?.kind === "pan" || gesture?.kind === "move" || gesture?.kind === "groupMove") return;
        if (mode === "decal") return this.drawDecalGhost(c, this.hover, null);
        if (mode === "place" && this.choice) {
            if (this.into) return;
            const t = editor.placeTarget(this.choice.id, ...this.hover);
            if (!t) return;
            const proto = this.layered(this.choice.id, this.hover);
            const gridRot = s.scene.worldTransform(t.grid)!.rot;
            this.outlineTile(g, { grid: t.grid, x: Math.floor(t.x), y: Math.floor(t.y) }, "rgba(255,255,255,0.5)", null);
            // the game draws the guides of the pipe layers under the ghost
            if (this.pipeLayer === null && layerPrototypes(s.pack, this.choice.id)) this.drawLayerGuides(g, t, gridRot, this.cursorLayer(this.choice.id, this.hover));
            // the entity as it would look placed; its icon when it draws nothing
            const layers = s.scene.preview(proto, t.grid, t.x, t.y, this.placeRotation);
            const frame = layers.length ? null : entityIcon(s.pack, proto);
            if (layers.length) this.el.map.drawSprites(g, layers, [0, 0], 0.6);
            else if (frame) this.drawFrame(g, frame, s.scene.toWorld(t.grid, t.x, t.y), this.placeRotation + gridRot, tilePx / PPM, 0.6);
        } else if (mode === "erase" && this.eraseKind === "entities") {
            const uid = editor.entityAt(...this.hover);
            if (uid !== null) boxEntities(c, [uid], ERASE_COLOR, 2);
        } else if (mode === "erase" && this.eraseKind === "decals") {
            const d = editor.decalUnder(...this.hover);
            if (d) this.outlineDecal(c, d, ERASE_COLOR);
        } else if (mode === "paint" || mode === "erase") {
            const t = editor.tileTarget(...this.hover);
            if (!t) return;
            const tile = mode === "paint" ? this.choice?.id : undefined;
            const frame = tile ? tileIcon(s.pack, tile) : null;
            if (frame) {
                const fit = tilePx / Math.max(frame[3], frame[4]);
                this.drawFrame(g, frame, s.scene.toWorld(t.grid, t.x + 0.5, t.y + 0.5), s.scene.worldTransform(t.grid)!.rot, fit, 0.7);
            }
            this.outlineTile(g, t, mode === "erase" ? "#ff6b6b" : "#7fd4ff", mode === "erase" ? "rgba(255,80,80,0.25)" : null);
        }
    }

    /** Grid lines, centres and directions of the grids. */
    private drawAids(g: CanvasRenderingContext2D, tilePx: number): void {
        const s = this.session, mass = this.mass, areas = this.areas;
        if (!s || !mass || !areas || !(this.aids.grid || this.aids.centre || this.aids.direction)) return;
        const { scene } = s, map = this.el.map;
        const W = this.el.canvas.clientWidth, H = this.el.canvas.clientHeight;
        for (const grid of scene.grids) {
            const area = areas.area(grid);
            const tr = scene.worldTransform(grid);
            if (!area || !tr) continue;
            // grid coordinates → screen: origin and the screen vectors of one tile along x and y
            const o = map.screenAt(...scene.toWorld(grid, 0, 0));
            const ux = map.screenAt(...scene.toWorld(grid, 1, 0)), uy = map.screenAt(...scene.toWorld(grid, 0, 1));
            const [ax, ay, bx, by] = [ux[0] - o[0], ux[1] - o[1], uy[0] - o[0], uy[1] - o[1]];
            const at = (lx: number, ly: number): [number, number] => [o[0] + ax * lx + bx * ly, o[1] + ay * lx + by * ly];
            if (this.aids.grid) {
                const corners = ([[0, 0], [W, 0], [W, H], [0, H]] as const).map(([x, y]) => scene.toLocal(grid, ...(map.worldAt(x, y) ?? [0, 0])));
                const r = gridLineRanges(area, bounds(corners), tilePx);
                if (r) {
                    g.beginPath();
                    for (let x = r.xs[0]; x <= r.xs[1]; x++) {
                        g.moveTo(...at(x, r.ys[0]));
                        g.lineTo(...at(x, r.ys[1]));
                    }
                    for (let y = r.ys[0]; y <= r.ys[1]; y++) {
                        g.moveTo(...at(r.xs[0], y));
                        g.lineTo(...at(r.xs[1], y));
                    }
                    g.lineWidth = 1;
                    g.strokeStyle = "rgba(255,255,255,0.3)";
                    g.stroke();
                }
            }
            const modes: MassMode[] = this.centreMode === "both" ? ["game", "entities"] : [this.centreMode];
            const centres = modes.map((m) => mass.centre(grid, m));
            const c = centres[0] ?? centres[1];
            if (!c) continue;
            const com = at(...c);
            if (this.aids.direction) {
                const a = arrow(com, forwardOnScreen(tr.rot), arrowLength(area[3] - area[1], tilePx));
                g.beginPath();
                g.moveTo(...com);
                g.lineTo(...a.tip);
                g.moveTo(...a.left);
                g.lineTo(...a.tip);
                g.lineTo(...a.right);
                g.lineJoin = g.lineCap = "round";
                g.lineWidth = 5;
                g.strokeStyle = "rgba(0,0,0,0.65)";
                g.stroke();
                g.lineWidth = 2.5;
                g.strokeStyle = "#7dff8a";
                g.stroke();
            }
            if (this.aids.centre) {
                const origin = at(0, 0);
                // grid origin: a cross
                g.beginPath();
                g.moveTo(origin[0] - 7, origin[1]);
                g.lineTo(origin[0] + 7, origin[1]);
                g.moveTo(origin[0], origin[1] - 7);
                g.lineTo(origin[0], origin[1] + 7);
                g.lineWidth = 4;
                g.strokeStyle = "rgba(0,0,0,0.65)";
                g.stroke();
                g.lineWidth = 2;
                g.strokeStyle = "#7fd4ff";
                g.stroke();
                modes.forEach((m, i) => {
                    const p = centres[i];
                    if (!p) return;
                    const [x, y] = at(...p);
                    g.beginPath();
                    if (m === "game") {
                        // as the game computes it: a dot
                        g.arc(x, y, 5, 0, 2 * Math.PI);
                        g.fillStyle = "#ffb347";
                    } else {
                        // with entities: a diamond
                        g.moveTo(x, y - 7);
                        g.lineTo(x + 7, y);
                        g.lineTo(x, y + 7);
                        g.lineTo(x - 7, y);
                        g.closePath();
                        g.fillStyle = "#e07bff";
                    }
                    g.fill();
                    g.lineWidth = 2;
                    g.strokeStyle = "rgba(0,0,0,0.8)";
                    g.stroke();
                });
            }
        }
    }

    /**
     * Outlines of the selected tiles and entities. While the selection is dragged: tiles shifted by the move
     * (the map already shows a live move), and when the move waits for the drop, ghosts of what moves.
     */
    private drawSelection(c: OverlayContext): void {
        const editor = this.editor!;
        const sel = editor.selected;
        if (sel.isEmpty) return;
        const gm = editor.groupMove;
        let moved: Point = [0, 0];
        if (gm && !gm.live) {
            moved = gm.delta;
            const ghosts = this.gesture?.kind === "groupMove" ? this.gesture.ghosts : null;
            if (ghosts && (moved[0] || moved[1])) drawGhostLayers(c, ghosts.sprites, ghosts.tiles, ghosts.decals, moved, 0.85);
        }
        const tileOffset = (grid: number): [number, number] => (gm ? gm.group.gridOffset(grid, gm.delta) : [0, 0]);
        outlineTiles(c, sel.tiles, tileOffset, sel.version);
        const entityOffset = gm && !gm.live ? tileOffset : (): [number, number] => [0, 0];
        const key = `${sel.version}:${editor.changeCount}`;
        outlineEntities(c, sel.entities, moved, entityOffset, key, sel.size);
        outlineDecals(c, sel.decals, moved, entityOffset, key);
    }

    /**
     * Links of the held or selected entity; with the multitool also the held entity, the members of its device
     * list, the other end of the linking panel and the device under the cursor.
     */
    private drawLinks(c: OverlayContext): void {
        const f = this.focusLines();
        if (f) drawLinkLines(c, f.lines);
        if (this.mode !== "link") return;
        if (f) boxEntities(c, f.members, LINK_COLORS.device);
        const p = this.linkPair;
        if (p) boxEntities(c, [p.source === this.holding ? p.sink : p.source], LINK_COLORS.signal, 2);
        if (this.holding !== null) boxEntities(c, [this.holding], LINK_COLORS.held, 2.5);
        if (this.hoverDevice !== null && this.hoverDevice !== this.holding) boxEntities(c, [this.hoverDevice], LINK_COLORS.hover, 1);
    }

    /** The item the pick menu points at: a box, a decal outline or a tile. */
    private drawMenuHover(c: OverlayContext): void {
        const item = this.menuHover;
        if (!item) return;
        const COLOR = "#4fd1ff";
        if (item.kind === "entity") return boxEntities(c, [item.uid], COLOR, 2.5);
        if (item.kind === "tile") return this.outlineTile(c.g, item, COLOR, "rgba(79,209,255,0.25)");
        const d = c.scene.decalLayer(item.grid, item.id);
        if (d) this.outlineDecal(c, d, COLOR);
    }

    /** A decal's outline in a color, on a dark edge. */
    private outlineDecal(c: OverlayContext, d: DecalLayer, color: string): void {
        const path = new Path2D();
        decalCorners(c, d, [0, 0]).forEach((p, i) => (i ? path.lineTo(...p) : path.moveTo(...p)));
        path.closePath();
        c.g.lineWidth = 4.5;
        c.g.strokeStyle = "rgba(0,0,0,0.7)";
        c.g.stroke(path);
        c.g.lineWidth = 2.5;
        c.g.strokeStyle = color;
        c.g.stroke(path);
    }

    /** The clipboard being pasted, where a click would place it. */
    private drawPasteGhost(c: OverlayContext, p: { clip: Clip; turns: number }, at: Point): void {
        const s = this.session!, editor = this.editor!;
        const target = editor.pasteTarget(p.clip, ...at, p.turns);
        if (!target) return;
        const plan = editor.pastePreview(p.clip, target);
        const icons: GhostIcon[] = [
            ...plan.tiles.map((t) => ({ x: t.x + 0.5, y: t.y + 0.5, rot: 0, frame: tileIcon(s.pack, t.tile.name), fit: true })),
            ...plan.entities.map((e) => ({ x: e.at[0], y: e.at[1], rot: e.rot, frame: entityIcon(s.pack, e.entity.proto), fit: false })),
        ];
        const boxes = plan.decals.map((d) => ({ x: d.at[0], y: d.at[1], w: d.decal.w, h: d.decal.h, rot: d.angle }));
        drawPasteGhost(c, target.grid, icons, boxes);
    }

    /** The shape being drawn: its tiles with the brush's icon. */
    private drawShapeGhost(c: OverlayContext, g: Extract<Gesture, { kind: "shape" }>): void {
        const s = this.session!;
        const shape = this.editor!.shapeTiles(g.shape, g.filled, g.start, g.end, g.constrain);
        if (!shape) return;
        const { brush } = g;
        const frame =
            brush.kind === "entity" ? entityIcon(s.pack, brush.id) : brush.kind === "decal" ? decalIcon(s.pack, brush.id) : brush.id === "Space" ? null : tileIcon(s.pack, brush.id);
        const color = brush.kind === "tile" && brush.id === "Space" ? "#ff6b6b" : "#7fd4ff";
        const rotation = brush.kind === "entity" ? this.placeRotation : brush.kind === "decal" ? brush.props.angle : 0;
        // entities as they would look placed, moved from one tile to each
        const layers = brush.kind === "entity" ? s.scene.preview(brush.id, shape.grid, 0.5, 0.5, rotation) : [];
        const [ox, oy] = s.scene.toWorld(shape.grid, 0.5, 0.5);
        const drawAt = layers.length
            ? (x: number, y: number) => {
                  const [wx, wy] = s.scene.toWorld(shape.grid, x + 0.5, y + 0.5);
                  this.el.map.drawSprites(c.g, layers, [wx - ox, wy - oy], 0.6);
              }
            : null;
        drawCellGhosts(c, shape.grid, shape.cells, frame, rotation, brush.kind !== "entity", color, drawAt);
    }

    /** Decals the brush would place: at a point, or along a line to `end`. */
    private drawDecalGhost(c: OverlayContext, start: Point, end: Point | null): void {
        const s = this.session!, editor = this.editor!;
        const b = this.decalBrush;
        const line = end ? editor.decalLine(start, end, this.decalSnap) : null;
        const one = line ? null : editor.decalTarget(...start, this.decalSnap);
        const grid = line?.grid ?? one?.grid;
        if (grid === undefined) return;
        const frame = decalIcon(s.pack, b.proto);
        const [w, h] = frame ? [frame[3] / PPM, frame[4] / PPM] : [1, 1];
        const points = editor.decalSpots(grid, line ? line.points : [[one!.x, one!.y]]);
        const icons: GhostIcon[] = points.map(([x, y]) => ({ x: x + w / 2, y: y + h / 2, rot: b.angle, frame, fit: false }));
        drawPasteGhost(c, grid, icons, points.map(([x, y]) => ({ x: x + w / 2, y: y + h / 2, w, h, rot: b.angle })));
    }

    /** The game's guide circles of the pipe layers in a tile, the one the cursor picks filled. */
    private drawLayerGuides(g: CanvasRenderingContext2D, t: GridPoint, gridRot: number, picked: number): void {
        const [cx, cy] = this.session!.scene.toWorld(t.grid, t.x, t.y);
        const r = Math.max(2, 0.1 * PPM * this.el.map.view.scale);
        g.save();
        for (const { dx, dy, layer } of layerGuides(gridRot)) {
            const [x, y] = this.el.map.screenAt(cx + dx, cy + dy);
            g.beginPath();
            g.arc(x, y, r, 0, 2 * Math.PI);
            g.fillStyle = layer === picked ? "#7fd4ff" : "rgba(0,0,0,0.45)";
            g.fill();
            g.lineWidth = 1.5;
            g.strokeStyle = layer === picked ? "rgba(0,0,0,0.8)" : "rgba(255,255,255,0.7)";
            g.stroke();
        }
        g.restore();
    }

    /** A grid tile's outline (follows the grid's rotation). */
    private outlineTile(g: CanvasRenderingContext2D, t: GridPoint, stroke: string, fill: string | null): void {
        const { scene } = this.session!;
        g.beginPath();
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
            const [x, y] = this.el.map.screenAt(...scene.toWorld(t.grid, t.x + dx, t.y + dy));
            if (dx === 0 && dy === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
        }
        g.closePath();
        if (fill) {
            g.fillStyle = fill;
            g.fill();
        }
        g.lineWidth = 1.5;
        g.strokeStyle = stroke;
        g.stroke();
    }

    /** A texture frame centred at a world point, turned by `rot` (radians, counter-clockwise), `k` CSS px per texture px. */
    private drawFrame(g: CanvasRenderingContext2D, frame: Frame, at: [number, number], rot: number, k: number, alpha: number): void {
        const [page, fx, fy, fw, fh] = frame;
        const img = this.el.map.pageImage(page);
        if (!img) return;
        const [x, y] = this.el.map.screenAt(...at);
        g.save();
        g.globalAlpha = alpha;
        g.translate(x, y);
        g.rotate(-rot);
        g.drawImage(img, fx, fy, fw, fh, (-fw / 2) * k, (-fh / 2) * k, fw * k, fh * k);
        g.restore();
    }
}
