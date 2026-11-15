// Editor operations on world coordinates (no DOM): selecting, dragging, rotating, deleting and placing
// entities, painting tiles, drawing shapes. Gestures made of several steps (a drag, a brush stroke) are one
// undo step; so is every operation on a whole selection.
import type { Decal, DecalProps } from "../map/decals";
import type { MapDocument, TileEdit, Transform } from "../map/document";
import type { Pack } from "../pack/loader";
import { pipeNodesOverlap, pipeOverlapNodes, PPM, type Scene } from "../render/scene";
import { copyParts, pasteClip, pastePlan, snapAnchor, type Clip, type ClipDecal, type ClipTile, type CopyRoot, type PasteKnown, type PasteResult, type PasteTarget } from "./clipboard";
import { Group, type TileMap } from "./group";
import { entityAt, type OpaqueTest } from "./hit";
import type { DecalLayer } from "../render/scene";
import { decalSize, mirrorCopies, mirrorDecal, mirrorEntity, mirrorTileRotation, snapMirrorAxis, type Flip, type MirrorAxis, type MirrorMode } from "./mirror";
import { deleteDecalsOnSpace } from "./space-decals";
import { pickOf, stackAt, type StackItem, type StackOptions } from "./stack";
import { cellKey, cellOf, collectAll, collectArea, decalAt, FILTER_KINDS, Selection, wandDecals, wandEntities, wandTiles, type Combine, type PickView, type SelectFilter } from "./selection";
import { constrainEnd, shapeCells, type Area, type Cell, type Point, type ShapeKind } from "./shapes";
import { quarterTurn, snapsToTile, tileCenter, toPixel } from "./snap";

/** A point on a grid in its own coordinates (tile or entity position). */
export interface GridPoint {
    grid: number;
    x: number;
    y: number;
}

/** What the editor needs from the view: which layers are drawn and, optionally, which of their pixels. */
export interface EditorView extends PickView {
    opaque?: OpaqueTest;
}

/** What a shape is drawn with: a tile (painted), an entity prototype (one per tile) or a decal (one per tile). */
export type Brush = { kind: "tile" | "entity"; id: string } | { kind: "decal"; id: string; props: DecalProps };

/**
 * Where a decal lands for a cursor point (decals are placed by their bottom left corner, the cursor is their centre
 * for a one-tile decal). "tile": on the tile under the cursor, as the game's decal placer does with Snap on
 * (DecalPlacementSystem: Round(x - 0.5) + 0.5, then offset by -0.5); "corner": centred on the nearest tile corner;
 * "free": centred on the cursor (whole texture pixels), as the placer without Snap.
 */
export type DecalSnap = "tile" | "corner" | "free";

/** The decal prototype fields the brush defaults come from (`DecalPrototype.Default*`). */
export interface DecalDefaults {
    defaultSnap?: false;
    defaultCleanable?: true;
    defaultCustomColor?: true;
}

/**
 * The brush settings picking a decal sets with the placer's "Auto" on (DecalPlacerWindow.SelectDecal): cleanable,
 * colour use and snap come from the prototype. Colour use off places white, on the picked colour.
 */
export function decalBrushDefaults(def: DecalDefaults | undefined, pickedColor: string): { cleanable: boolean; color: string; snap: DecalSnap } {
    return {
        cleanable: def?.defaultCleanable === true,
        color: def?.defaultCustomColor === true ? pickedColor : "#FFFFFFFF",
        snap: def?.defaultSnap === false ? "free" : "tile",
    };
}

/** Rounds half away from zero, as .NET's MidpointRounding.AwayFromZero. */
const roundAway = (v: number) => Math.sign(v) * Math.round(Math.abs(v)) + 0; // + 0: no -0

/** A grid coordinate of a cursor point → the bottom left corner of a decal placed there. */
export function decalCorner(v: number, snap: DecalSnap): number {
    if (snap === "tile") return roundAway(v - 0.5);
    if (snap === "corner") return Math.round(v) - 0.5;
    return toPixel(v - 0.5);
}

/** Group drags up to this many entities and tiles edit the map live; bigger ones show a ghost until dropped. */
export const LIVE_LIMIT = 400;

/** Whether two rotations (radians) face the same way. */
const sameAngle = (a: number, b: number) => Math.abs((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) < 1e-6;

const SHAPE_LABELS: Record<ShapeKind, string> = { line: "Line", rect: "Rectangle", ellipse: "Ellipse" };

interface GroupDrag {
    group: Group;
    start: Point;
    /** World move so far (snapped). */
    delta: Point;
    live: boolean;
}

interface Drag {
    uid: number;
    /** World point where the drag started. */
    start: [number, number];
    /** Transform in the file when the drag started. */
    from: Transform;
    /** Anchored entities stay on tiles of their grid: the grid, the world position and tile where they started. */
    grid: number | null;
    world: [number, number];
    tile: [number, number];
}

export class Editor {
    mirrorMode: MirrorMode = "off";
    /** Axis positions are in each grid's own coordinates. */
    readonly mirrorAxes = new Map<number, Point>();

    mirrorCentre(grid: number): Point {
        const existing = this.mirrorAxes.get(grid);
        if (existing) return existing;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of this.scene.tileCells(grid)) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + 1);
            maxY = Math.max(maxY, y + 1);
        }
        const centre: Point = minX === Infinity ? [0, 0] : [(minX + maxX) / 2, (minY + maxY) / 2];
        this.mirrorAxes.set(grid, centre);
        return centre;
    }

    moveMirrorAxis(grid: number, axis: MirrorAxis, world: Point): void {
        const centre = this.mirrorCentre(grid);
        const [x, y] = this.scene.toLocal(grid, ...world);
        this.mirrorAxes.set(grid, axis === "horizontal" ? [snapMirrorAxis(x), centre[1]] : [centre[0], snapMirrorAxis(y)]);
    }

    private copies(grid: number, point: Point) {
        return mirrorCopies(point, this.mirrorMode === "off" ? point : this.mirrorCentre(grid), this.mirrorMode);
    }

    /** The original positions take precedence if the shape crosses its reflection. */
    private brushCopies(grid: number, points: readonly Point[]) {
        if (this.mirrorMode === "off") return points.map((at) => ({ at, source: at, flip: null }));
        const copies = points.map((at) => ({ at, source: at, flip: null as Flip | null }));
        const key = ([x, y]: Point) => `${x},${y}`;
        const seen = new Set(points.map(key));
        for (const point of points) {
            for (const copy of this.copies(grid, point)) {
                const k = key(copy.at);
                if (seen.has(k)) continue;
                seen.add(k);
                copies.push({ ...copy, source: point });
            }
        }
        return copies;
    }

    entityBrush(grid: number, points: readonly Point[], proto: string, angle: number) {
        const looks = new Map<Flip | null, { proto: string; angle: number }>([[null, { proto, angle }]]);
        return this.brushCopies(grid, points).flatMap(({ at: [x, y], flip }) => {
            if (this.scene.tileAt(grid, Math.floor(x), Math.floor(y)) === null) return [];
            let look = looks.get(flip);
            if (!look) looks.set(flip, (look = mirrorEntity(this.pack, proto, angle, flip!)));
            return [{ x, y, flip, ...look }];
        });
    }

    tileBrush(grid: number, cells: readonly Cell[]) {
        return this.brushCopies(grid, cells.map(([x, y]) => [x + 0.5, y + 0.5])).map(({ at: [x, y], source, flip }) => ({
            x: Math.floor(x), y: Math.floor(y),
            source,
            rotationMirroring: flip && this.doc.format >= 7 ? mirrorTileRotation(0, flip) : 0,
            flip,
        }));
    }

    decalBrush(grid: number, points: readonly Point[], props: DecalProps) {
        if (!points.length) return [];
        if (this.mirrorMode === "off") return this.decalSpots(grid, points).map(([x, y]) => ({ x, y, props, flip: null as Flip | null }));
        const [w, h] = decalSize(this.pack, props.proto);
        return this.brushCopies(grid, points.map(([x, y]) => [x + w / 2, y + h / 2])).flatMap(({ at: [cx, cy], flip }) => {
            const look = flip ? mirrorDecal(this.pack, props, flip) : props;
            const [width, height] = look.proto === props.proto ? [w, h] : decalSize(this.pack, look.proto);
            const x = cx - width / 2, y = cy - height / 2;
            return this.scene.tileAt(grid, Math.floor(x), Math.floor(y)) === null ? [] : [{ x, y, props: look, flip }];
        });
    }

    erasePoints(wx: number, wy: number): Array<{ at: Point; grid: number | null }> {
        const grid = this.mirrorMode === "off" ? null : this.scene.gridAt(wx, wy);
        if (grid === null) return [{ at: [wx, wy], grid }];
        return this.copies(grid, this.scene.toLocal(grid, wx, wy)).map(({ at, flip }) => ({
            at: flip ? this.scene.toWorld(grid, ...at) : [wx, wy],
            grid: flip ? grid : null,
        }));
    }

    /** Everything selected. A single entity is also `selection`. */
    readonly selected = new Selection();
    private drag: Drag | null = null;
    private groupDrag: GroupDrag | null = null;
    /** Set while a group operation edits the map: the selection is updated after it, not pruned during it. */
    private holding = false;
    /** Map changes seen (`validate` runs after each). */
    private changes = 0;
    /**
     * After a group operation: what the selection's tiles cover, valid while neither the map nor the selection
     * changed since. The next operation on the selection puts it back where the tiles leave.
     */
    private float: { under: TileMap; changes: number } | null = null;
    /** Tiles already done by the open stroke ("grid|x|y"). */
    private visited: Set<string> | null = null;
    /** The selection before and after each undo step made here, restored by `undo` and `redo`. */
    private readonly snapshots = new WeakMap<object, { before: Selection; after: Selection }>();
    private readonly flips = new WeakMap<object, { axis: MirrorAxis; selectionVersion: number; under: TileMap | null }>();
    /** The selection and the last undo step when the open gesture began. */
    private gestureStart: { before: Selection; top: object | null } | null = null;
    /** Variant of each tile painted (the brush's choice; 0 by default). */
    variant: (name: string) => number = () => 0;
    /** How selected decals and free entities move: the decal snap (tiles and anchored entities always go by tiles). */
    moveSnap: DecalSnap = "tile";

    constructor(
        readonly doc: MapDocument,
        readonly scene: Scene,
        readonly pack: Pack,
        private readonly view: EditorView,
    ) {}

    /** Whether a gesture (drag or stroke) is open in the document. */
    get busy(): boolean {
        return this.doc.journal.isOpen;
    }

    /** Topmost drawn entity at a world point, or null. */
    entityAt(wx: number, wy: number, accept?: (uid: number) => boolean): number | null {
        return entityAt(this.scene, wx, wy, (s) => this.view.visible(s), this.view.opaque, accept);
    }

    /** Topmost drawn entity `accept` takes at a world point: by its pixels, else by its sprite's frame (small devices). */
    pickAt(wx: number, wy: number, accept: (uid: number) => boolean): number | null {
        return this.entityAt(wx, wy, accept) ?? entityAt(this.scene, wx, wy, (s) => this.view.visible(s), undefined, accept);
    }

    /** How many map changes the editor has seen (`validate` counts them). */
    get changeCount(): number {
        return this.changes;
    }

    /** The selected entity when the selection is exactly one entity, else null. */
    get selection(): number | null {
        const s = this.selected;
        return s.entities.size === 1 && !s.tiles.size && !s.decals.size ? s.entities.values().next().value! : null;
    }

    /** Selects one entity (or nothing). */
    set selection(uid: number | null) {
        this.float = null;
        this.selected.clear();
        if (uid !== null) this.selected.addEntity(uid);
    }

    /** Selects the entity at a world point (or nothing there); returns the selection. */
    selectAt(wx: number, wy: number): number | null {
        return (this.selection = this.entityAt(wx, wy));
    }

    /** Drops what no longer exists from the selection (after undo, redo or delete). */
    validate(): void {
        this.changes++;
        this.prune();
    }

    private prune(): void {
        if (this.holding || this.groupDrag) return;
        // decals not drawn are looked up in the document, all decals of a grid at once (thousands go at an undo)
        const decalIds = new Map<number, Set<string>>();
        const decalExists = (g: number, id: string) => {
            if (this.scene.decalLayer(g, id)) return true;
            let ids = decalIds.get(g);
            if (!ids) decalIds.set(g, (ids = new Set(this.doc.decals(g).map((d) => d.id))));
            return ids.has(id);
        };
        this.selected.prune(
            (uid) => this.doc.proto(uid) !== undefined,
            (g, x, y) => this.scene.tileAt(g, x, y) !== null,
            decalExists,
        );
    }

    // ---- undo and redo, with the selection of each step

    /** Remembers the selection around the undo step an operation just made (when it made one). */
    private remember(before: Selection, top: object | null): void {
        const now = this.doc.lastEdit;
        if (now && now !== top) this.snapshots.set(now, { before, after: this.selected.clone() });
    }

    /** Runs an operation that may make an undo step, remembering the selection around it. */
    private tracked<T>(fn: () => T): T {
        const before = this.selected.clone(), top = this.doc.lastEdit;
        const result = fn();
        this.remember(before, top);
        return result;
    }

    /** Undoes the last step; the selection goes back to what it was before it (when the editor made it). */
    undo(): string | null {
        const step = this.doc.lastEdit;
        const label = this.doc.undo();
        const snap = step && this.snapshots.get(step);
        if (snap) this.restore(snap.before);
        return label;
    }

    /** Redoes the next step; the selection becomes what it was after it. */
    redo(): string | null {
        const step = this.doc.nextRedo;
        const label = this.doc.redo();
        const snap = step && this.snapshots.get(step);
        if (snap) this.restore(snap.after);
        return label;
    }

    private restore(selection: Selection): void {
        this.float = null;
        this.selected.assign(selection);
        this.prune();
    }

    /** Selects nothing. */
    deselect(): void {
        this.selection = null;
    }

    /** A group over the selection, floating when the last operation left it so. */
    private group(near: Point | null = null): Group {
        const f = this.float;
        return new Group(this.doc, this.scene, this.selected, near, f && f.changes === this.changes ? f.under : undefined, this.moveSnap);
    }

    /** After a group operation that changed the map: the selection floats. */
    private floatAfter(group: Group): void {
        this.float = { under: group.underAfter(), changes: this.changes };
    }

    /** Runs a group operation with the selection held still while the map changes under it. */
    private hold<T>(fn: () => T): T {
        this.holding = true;
        try {
            return fn();
        } finally {
            this.holding = false;
        }
    }

    // ---- selection tools

    /** The decal drawn on top at a world point (when decals are shown), or null. */
    decalAt(wx: number, wy: number): DecalLayer | null {
        return (this.view.decalsShown?.() ?? true) ? decalAt(this.scene, wx, wy, this.view.opaque) : null;
    }

    /**
     * A click with a selection tool: the entity under the cursor, else the decal there (when the filter takes
     * them), or, selecting tiles only, the tile there.
     */
    clickSelect(wx: number, wy: number, filter: SelectFilter, op: Combine): void {
        const pick = new Selection();
        const kinds = FILTER_KINDS[filter];
        const hit = kinds.includes("entities") ? this.entityAt(wx, wy) : null;
        const decal = hit === null && kinds.includes("decals") ? this.decalAt(wx, wy) : null;
        this.float = null;
        if (hit !== null) pick.entities.add(hit);
        else if (decal) pick.addDecal(decal.grid, decal.id);
        else if (filter === "tiles") {
            const t = this.tileTarget(wx, wy);
            if (t && this.scene.tileAt(t.grid, t.x, t.y) !== null) pick.addTile(t.grid, t.x, t.y);
        }
        this.selected.combine(pick, op);
    }

    /** Whether a tile lies under a world point. */
    tileUnder(wx: number, wy: number): boolean {
        const t = this.tileTarget(wx, wy);
        return !!t && this.scene.tileAt(t.grid, t.x, t.y) !== null;
    }

    /** Everything under a world point, topmost first (see `stackAt`). */
    stackAt(wx: number, wy: number, opts: Omit<StackOptions, "opaque"> = {}): StackItem[] {
        return stackAt(this.scene, this.view, wx, wy, { ...opts, opaque: this.view.opaque });
    }

    /** Picks one item of a stack: replaces the selection, adds to it or takes it out. */
    selectItem(item: StackItem, op: Combine): void {
        this.float = null;
        this.selected.combine(pickOf(item, new Selection()), op);
    }

    /** Selects what lies inside an area drawn with a selection tool. */
    selectArea(area: Area, filter: SelectFilter, op: Combine): void {
        this.float = null;
        this.selected.combine(collectArea(this.scene, this.view, area, filter), op);
    }

    /**
     * Magic wand: on an entity (when the filter takes entities), entities of its prototype, contiguous or
     * all over the map (`everywhere`); on a decal, decals of its prototype and colour, contiguous or all of its
     * grid; elsewhere the contiguous area of the tile under the cursor.
     */
    wand(wx: number, wy: number, filter: SelectFilter, op: Combine, everywhere = false): void {
        const kinds = FILTER_KINDS[filter];
        const hit = kinds.includes("entities") ? this.entityAt(wx, wy) : null;
        const decal = hit === null && kinds.includes("decals") ? this.decalAt(wx, wy) : null;
        let pick = new Selection();
        this.float = null;
        if (hit !== null) pick = wandEntities(this.scene, this.view, hit, !everywhere);
        else if (decal) pick = wandDecals(this.scene, decal, !everywhere);
        else if (kinds.includes("tiles") && (this.view.tilesShown?.() ?? true)) {
            const t = this.tileTarget(wx, wy);
            if (t) pick = wandTiles(this.scene, t.grid, t.x, t.y);
        }
        this.selected.combine(pick, op);
    }

    selectAll(filter: SelectFilter): void {
        this.float = null;
        this.selected.assign(collectAll(this.scene, this.view, filter));
    }

    /** Whether a world point is on the selection: a selected entity or decal under it, or a selected tile. */
    onSelection(wx: number, wy: number): boolean {
        const hit = this.entityAt(wx, wy);
        if (hit !== null && this.selected.entities.has(hit)) return true;
        const decal = this.selected.decals.size ? this.decalAt(wx, wy) : null;
        if (decal && this.selected.hasDecal(decal.grid, decal.id)) return true;
        const t = this.tileTarget(wx, wy);
        return !!t && this.selected.hasTile(t.grid, t.x, t.y);
    }

    // ---- moving

    /** Starts dragging an entity from a world point; `dragTo` moves it, `finish` makes the drag one undo step. */
    beginMove(uid: number, wx: number, wy: number): void {
        const from = this.doc.transform(uid);
        const p = this.scene.placement(uid);
        const w = this.scene.worldTransform(uid);
        if (from.parent === null || !w) return;
        const grid = p?.anchored && p.grid !== null ? p.grid : null;
        this.drag = {
            uid,
            start: [wx, wy],
            from,
            grid,
            world: [w.x, w.y],
            tile: p ? [Math.floor(p.x), Math.floor(p.y)] : [0, 0],
        };
        this.startGesture();
        this.doc.begin("Move");
    }

    /** The entity `beginMove` is dragging, or null. */
    get dragging(): number | null {
        return this.drag?.uid ?? null;
    }

    /** Moves the dragged entity by the distance from the drag's start to a world point. */
    dragTo(wx: number, wy: number): void {
        const d = this.drag;
        if (!d) return;
        const parent = d.from.parent!;
        const [dx, dy] = [wx - d.start[0], wy - d.start[1]];
        let x: number, y: number;
        if (d.grid !== null) {
            // anchored: onto the centre of the tile the entity is dragged to
            const [lx, ly] = this.scene.toLocal(d.grid, d.world[0] + dx, d.world[1] + dy);
            const tx = Math.floor(lx), ty = Math.floor(ly);
            if (tx === d.tile[0] && ty === d.tile[1]) [x, y] = [d.from.x, d.from.y];
            else if (parent === d.grid) [x, y] = [tileCenter(lx), tileCenter(ly)];
            else [x, y] = this.scene.toLocal(parent, ...this.scene.toWorld(d.grid, tileCenter(lx), tileCenter(ly)));
        } else {
            const [ax, ay] = this.scene.toLocal(parent, ...d.start);
            const [bx, by] = this.scene.toLocal(parent, wx, wy);
            [x, y] = [d.from.x + toPixel(bx - ax), d.from.y + toPixel(by - ay)];
        }
        const now = this.doc.transform(d.uid);
        if (now.x !== x || now.y !== y) this.doc.moveEntity(d.uid, x, y);
    }

    // ---- strokes (several edits as one undo step)

    /** Opens a stroke of placing or painting; `finish` closes it. */
    beginStroke(label: string): void {
        this.visited = new Set();
        this.startGesture();
        this.doc.begin(label);
    }

    private startGesture(): void {
        this.gestureStart = { before: this.selected.clone(), top: this.doc.lastEdit };
    }

    /** Closes the open drag or stroke; returns whether it changed the map. */
    finish(): boolean {
        const start = this.gestureStart;
        this.gestureStart = null;
        const done = this.finishGesture();
        if (done && start) this.remember(start.before, start.top);
        return done;
    }

    private finishGesture(): boolean {
        this.drag = null;
        this.visited = null;
        const gd = this.groupDrag;
        if (gd) {
            const { group, delta } = gd;
            this.hold(() => {
                if (gd.live && group.reverted) {
                    // steps that were put back would stay in the file as rewritten entries: replay the move from the start
                    this.doc.cancel();
                    this.doc.begin("Move");
                    group.reset();
                    group.moveBy(delta);
                } else if (!gd.live) group.moveBy(delta);
                if (this.busy) group.clearSpaceDecals();
            });
            this.groupDrag = null;
            const done = this.busy && this.doc.commit();
            if (done) {
                group.movedSelection(this.selected, delta);
                this.floatAfter(group);
            }
            this.prune();
            return done;
        }
        return this.busy ? this.doc.commit() : false;
    }

    /** Closes the open drag or stroke, reverting it. */
    cancel(): void {
        this.drag = null;
        this.visited = null;
        this.gestureStart = null;
        if (this.busy) this.hold(() => this.doc.cancel());
        this.groupDrag = null;
    }

    // ---- moving the selection

    /**
     * Starts dragging the whole selection from a world point; `groupDragTo` moves it, `finish` drops it. A live
     * drag edits the map at every step (small selections); otherwise the map changes once, when it is dropped.
     */
    beginGroupMove(wx: number, wy: number, live?: boolean): boolean {
        const group = this.group([wx, wy]);
        if (group.isEmpty) return false;
        live ??= group.movers.length + this.selected.tileCount + this.selected.decalCount <= LIVE_LIMIT;
        this.groupDrag = { group, start: [wx, wy], delta: [0, 0], live };
        this.startGesture();
        this.doc.begin("Move");
        return true;
    }

    /** Moves the dragged selection by the distance from the drag's start; returns whether its place changed. */
    groupDragTo(wx: number, wy: number): boolean {
        const gd = this.groupDrag;
        if (!gd) return false;
        const delta = gd.group.snapDelta([wx - gd.start[0], wy - gd.start[1]]);
        if (delta[0] === gd.delta[0] && delta[1] === gd.delta[1]) return false;
        gd.delta = delta;
        if (gd.live) this.hold(() => gd.group.moveBy(delta));
        return true;
    }

    /** The selection drag in progress: its world move, whether the map already shows it, and the group. */
    get groupMove(): Readonly<GroupDrag> | null {
        return this.groupDrag;
    }

    /**
     * Moves the selection one tile in a world direction (on the grid of its tiles, along the grid axis nearest
     * to that direction) as one undo step.
     */
    nudge(dx: number, dy: number): boolean {
        if (this.busy || this.selected.isEmpty) return false;
        const group = this.group();
        if (group.isEmpty) return false;
        let delta: Point = [dx, dy];
        if (group.ref !== null) {
            const [ox, oy] = this.scene.toLocal(group.ref, 0, 0);
            const [lx, ly] = this.scene.toLocal(group.ref, dx, dy);
            const [vx, vy] = [lx - ox, ly - oy];
            // a texture pixel with the snap Off when nothing in the selection keeps to tiles, else a tile
            const step = group.freeMoves && !group.keepsTiles ? 1 / PPM : 1;
            delta = Math.abs(vx) >= Math.abs(vy) ? group.tileStep(Math.sign(vx) * step, 0) : group.tileStep(0, Math.sign(vy) * step);
        }
        this.tracked(() => {
            this.hold(() =>
                this.doc.batch("Move", () => {
                    group.moveBy(delta);
                    group.clearSpaceDecals();
                }),
            );
            group.movedSelection(this.selected, delta);
        });
        this.floatAfter(group);
        return true;
    }

    // ---- rotating and deleting

    /** Turns the selection by quarter turns (positive: counter-clockwise): one entity in place, a group around its centre. */
    rotateSelection(turns: number): boolean {
        const one = this.selection;
        if (one !== null) {
            this.tracked(() => this.doc.rotateEntity(one, quarterTurn(this.doc.transform(one).rotation, turns)));
            return true;
        }
        if (this.selected.isEmpty) return false;
        const group = this.group();
        const turned = this.tracked(() => {
            const cellTo = this.hold(() => group.turn(turns));
            if (!cellTo) return false;
            this.selected.mapTiles(cellTo);
            this.selected.mapDecals((g, id) => group.decalIdOf(g, id));
            return true;
        });
        if (!turned) return false;
        this.floatAfter(group);
        return true;
    }

    flipSelection(axis: MirrorAxis): boolean {
        if (this.selected.isEmpty || this.busy) return false;
        const top = this.doc.lastEdit;
        const flip = top && this.flips.get(top);
        const previous = top && this.snapshots.get(top);
        const under = this.float?.changes === this.changes ? this.float.under : null;
        const flipped = this.tracked(() => {
            if (flip?.axis === axis && flip.selectionVersion === this.selected.version && previous) {
                if (!this.hold(() => this.doc.journal.reverseLast())) return false;
                this.restore(previous.before);
                this.float = flip.under && { under: flip.under, changes: this.changes };
                return true;
            }
            const group = this.group();
            const cellTo = this.hold(() => group.flip(axis, this.pack));
            if (!cellTo) return false;
            this.selected.mapTiles(cellTo);
            this.selected.mapDecals((g, id) => group.decalIdOf(g, id));
            this.floatAfter(group);
            return true;
        });
        const last = this.doc.lastEdit;
        if (flipped && last && last !== top) this.flips.set(last, { axis, selectionVersion: this.selected.version, under });
        return flipped;
    }

    /** Deletes the selection: entities with everything inside them, tiles become space; returns the deleted uids. */
    deleteSelection(): number[] {
        const one = this.selection;
        if (one !== null) {
            return this.tracked(() => {
                const removed = this.doc.deleteEntity(one);
                this.selection = null;
                return removed;
            });
        }
        if (this.selected.isEmpty) return [];
        return this.tracked(() => {
            const removed = this.hold(() => this.group().delete());
            this.deselect();
            return removed;
        });
    }

    // ---- placing

    /** Where an entity of `proto` would be placed for a world point: the grid there and its position on it. */
    placeTarget(proto: string, wx: number, wy: number, allowSpace = false): GridPoint | null {
        const grid = this.scene.gridAt(wx, wy);
        if (grid === null) return null;
        const [lx, ly] = this.scene.toLocal(grid, wx, wy);
        // nothing is placed over space
        if (!allowSpace && this.scene.tileAt(grid, Math.floor(lx), Math.floor(ly)) === null) return null;
        return snapsToTile(this.pack.prototypes.entities[proto])
            ? { grid, x: tileCenter(lx), y: tileCenter(ly) }
            : { grid, x: toPixel(lx), y: toPixel(ly) };
    }

    /**
     * Places an entity at a world point; returns its uid, or null when there is no grid, the tile already
     * has an anchored entity of that prototype, or (in a stroke) the stroke has already placed there.
     */
    place(proto: string, wx: number, wy: number, rotation = 0): number | null {
        const t = this.placeTarget(proto, wx, wy, this.mirrorMode !== "off");
        if (!t) return null;
        const tx = Math.floor(t.x), ty = Math.floor(t.y);
        const snaps = snapsToTile(this.pack.prototypes.entities[proto]);
        if (this.visited) {
            const key = `${t.grid}|${tx}|${ty}`;
            // free placement does not repeat while dragging
            if (this.visited.has(key) || (this.visited.size && !snaps)) return null;
            this.visited.add(key);
        }
        return this.doc.batch("Place", () => {
            let placed: number | null = null;
            for (const copy of this.entityBrush(t.grid, [[t.x, t.y]], proto, rotation)) {
                const x = Math.floor(copy.x), y = Math.floor(copy.y);
                if (copy.flip && this.visited) {
                    const key = `${t.grid}|${x}|${y}`;
                    if (snaps && this.visited.has(key)) continue;
                    this.visited.add(key);
                }
                const uid = this.placeAt(copy.proto, t.grid, copy.x, copy.y, copy.angle);
                placed ??= uid;
            }
            return placed;
        });
    }

    /**
     * Anchored entities on a tile that a new one of `proto`, turned by `rotation` on the grid, takes the place of; null
     * when it is not placed there (one of that prototype is already there, for pipes one turned the same way).
     * Pipes (PipeRestrictOverlap) share a tile when their nodes are on other layers or face other ways. A pipe whose
     * node shares a layer and a direction with one already there would stay unanchored in the game
     * (PipeRestrictOverlapSystem); here it takes that one's place, as one of the same key does.
     */
    private displaced(proto: string, grid: number, x: number, y: number, rotation: number, snaps: boolean): number[] | null {
        const here = this.scene.anchoredAt(grid, x, y);
        const id = this.pack.migrate(proto);
        const comps = id === null ? undefined : this.pack.prototypes.entities[id]?.components;
        const out = new Set(this.replacedBy(proto, grid, x, y));
        if (comps?.PipeRestrictOverlap) {
            if (snaps && here.some((u) => this.doc.proto(u) === proto && sameAngle(this.doc.transform(u).rotation, rotation))) return null;
            const nodes = pipeOverlapNodes(comps, rotation);
            for (const u of here) if (pipeNodesOverlap(nodes, this.scene.pipeOverlapNodes(u))) out.add(u);
        } else if (snaps && here.some((u) => this.doc.proto(u) === proto)) return null;
        return [...out];
    }

    /**
     * Anchored entities a new one of `proto` replaces on a tile, as the game's placement does (PlacementManager):
     * those of another prototype whose PlacementReplacement has the same key (airlocks and walls share "walls").
     */
    private replacedBy(proto: string, grid: number, x: number, y: number): number[] {
        const key = this.replacementKey(proto);
        if (key === null) return [];
        return this.scene.anchoredAt(grid, x, y).filter((u) => {
            const p = this.doc.proto(u);
            return p !== undefined && p !== proto && this.replacementKey(p) === key;
        });
    }

    private replacementKey(proto: string): string | null {
        const id = this.pack.migrate(proto);
        const key = id === null ? undefined : (this.pack.prototypes.entities[id]?.components.PlacementReplacement as { key?: unknown } | undefined)?.key;
        return typeof key === "string" && key !== "" ? key : null;
    }

    private placeAt(proto: string, grid: number, x: number, y: number, rotation: number): number | null {
        const replaced = this.displaced(proto, grid, Math.floor(x), Math.floor(y), rotation, snapsToTile(this.pack.prototypes.entities[proto]));
        if (replaced === null) return null;
        for (const u of replaced) if (this.doc.proto(u) !== undefined) this.doc.deleteEntity(u);
        return this.doc.addEntity(proto, grid, x, y, rotation);
    }

    // ---- decals

    /** Where a decal would be placed for a world point: the grid there and the decal's bottom left corner on it. */
    decalTarget(wx: number, wy: number, snap: DecalSnap): GridPoint | null {
        const grid = this.scene.gridAt(wx, wy);
        if (grid === null) return null;
        const [lx, ly] = this.scene.toLocal(grid, wx, wy);
        return { grid, x: decalCorner(lx, snap), y: decalCorner(ly, snap) };
    }

    /**
     * Decal corners of a line between two world points, on the grid under the first one: one per tile (on the snap
     * lattice), or one per tile of length without snapping.
     */
    decalLine(from: Point, to: Point, snap: DecalSnap): { grid: number; points: Point[] } | null {
        const a = this.decalTarget(...from, snap);
        if (!a) return null;
        const [lx, ly] = this.scene.toLocal(a.grid, ...to);
        const b: Point = [decalCorner(lx, snap), decalCorner(ly, snap)];
        if (snap === "free") {
            const n = Math.round(Math.hypot(b[0] - a.x, b[1] - a.y));
            const points: Point[] = [];
            for (let i = 0; i <= n; i++) points.push(n ? [toPixel(a.x + ((b[0] - a.x) * i) / n), toPixel(a.y + ((b[1] - a.y) * i) / n)] : [a.x, a.y]);
            return { grid: a.grid, points };
        }
        // the lattice of corners is that of tiles moved by half a tile
        const shift = snap === "corner" ? 0.5 : 0;
        const cells = shapeCells("line", false, [a.x + shift, a.y + shift], [b[0] + shift, b[1] + shift]);
        return { grid: a.grid, points: cells.map(([x, y]) => [x - shift, y - shift]) };
    }

    /** Corners where the game takes a decal: those on a tile (DecalSystem.TryAddDecal refuses space). */
    decalSpots(grid: number, points: readonly Point[]): Point[] {
        return points.filter(([x, y]) => this.scene.tileAt(grid, Math.floor(x), Math.floor(y)) !== null);
    }

    /** Places decals of one look at corners on a grid (those on tiles) as one undo step; returns their ids. */
    placeDecals(props: DecalProps, grid: number, points: readonly Point[]): string[] {
        const decals = this.decalBrush(grid, points, props).map(({ x, y, props: { proto, ...look } }) => ({ x, y, proto, props: look }));
        return decals.length ? this.tracked(() => this.doc.addDecals(grid, decals)) : [];
    }

    /**
     * The decal under a world point as the document has it (for the eyedropper), or null: the one whose pixels are
     * there, else the topmost one whose box is (outlines and corners are mostly empty).
     */
    pickDecal(wx: number, wy: number): (Decal & { grid: number }) | null {
        if (!(this.view.decalsShown?.() ?? true)) return null;
        const layer = decalAt(this.scene, wx, wy, this.view.opaque) ?? decalAt(this.scene, wx, wy);
        const d = layer && this.doc.decal(layer.grid, layer.id);
        return d ? { ...d, grid: layer.grid } : null;
    }

    /** The selected decals as the document has them. */
    selectedDecals(): Array<Decal & { grid: number }> {
        const out: Array<Decal & { grid: number }> = [];
        for (const [g, ids] of this.selected.decals) {
            const all = ids.size > 8 ? new Map(this.doc.decals(g).map((d) => [d.id, d])) : null;
            for (const id of ids) {
                const d = all ? all.get(id) : this.doc.decal(g, id);
                if (d) out.push({ ...d, grid: g });
            }
        }
        return out;
    }

    /**
     * Gives every selected decal the same prototype, colour, angle, z or cleanability (or each its own change from
     * a function) as one undo step.
     */
    setDecalProps(props: Partial<DecalProps> | ((d: DecalProps) => Partial<DecalProps>)): number {
        if (this.busy || !this.selected.decals.size) return 0;
        let n = 0;
        this.tracked(() =>
            this.hold(() =>
                this.doc.batch("Change decals", () => {
                    for (const [g, ids] of this.selected.decals) {
                        // a function gives each decal its own change (a new colour keeping each one's alpha)
                        const all = typeof props === "function" ? new Map(this.doc.decals(g).map((d) => [d.id, d])) : null;
                        this.doc.editDecals(g, [...ids].map((id) => {
                            const d = all?.get(id);
                            return { id, props: typeof props === "function" ? (d ? props(d) : {}) : props };
                        }));
                        n += ids.size;
                    }
                }),
            ),
        );
        return n;
    }

    // ---- shapes

    /**
     * Tiles a shape covers between two world points: on the grid under the first point. `constrain` (Shift)
     * keeps lines to 45° steps and makes rectangles squares and ellipses circles.
     */
    shapeTiles(kind: ShapeKind, filled: boolean, from: Point, to: Point, constrain = false): { grid: number; cells: Cell[] } | null {
        const a = this.tileTarget(...from);
        if (!a) return null;
        const [lx, ly] = this.scene.toLocal(a.grid, ...to);
        const start: Cell = [a.x, a.y];
        let end: Cell = [Math.floor(lx), Math.floor(ly)];
        if (constrain) end = constrainEnd(kind, start, end);
        return { grid: a.grid, cells: shapeCells(kind, filled, start, end) };
    }

    /**
     * Draws a shape with a brush as one undo step: tiles are painted, entities placed one per tile (tiles that
     * already have an anchored one of the prototype are skipped). Returns how many tiles changed.
     */
    drawShape(kind: ShapeKind, filled: boolean, brush: Brush, from: Point, to: Point, rotation = 0, constrain = false): number {
        const shape = this.shapeTiles(kind, filled, from, to, constrain);
        if (!shape) return 0;
        const { grid, cells } = shape;
        return this.doc.batch(SHAPE_LABELS[kind], () => {
            if (brush.kind === "decal") return this.placeDecals(brush.props, grid, cells).length;
            if (brush.kind === "tile") return this.paintCells(brush.id, grid, cells);
            let placed = 0;
            for (const copy of this.entityBrush(grid, cells.map(([x, y]) => [x + 0.5, y + 0.5]), brush.id, rotation)) {
                if (this.placeAt(copy.proto, grid, copy.x, copy.y, copy.angle) !== null) placed++;
            }
            return placed;
        });
    }

    // ---- clipboard

    /** The selection as a clipboard (positions relative to its centre), or null when nothing is selected. */
    copy(): Clip | null {
        if (this.selected.isEmpty) return null;
        const group = new Group(this.doc, this.scene, this.selected, null, undefined, this.moveSnap);
        if (group.isEmpty) return null;
        const c = group.centre() ?? [0, 0];
        const refRot = group.ref !== null ? this.scene.worldTransform(group.ref)?.rot ?? 0 : 0;
        const roots: CopyRoot[] = group.movers.map((m) => {
            const { from } = m;
            let at: Point, rot: number;
            if (from.parent === group.ref) [at, rot] = [[from.x, from.y], from.rotation];
            else {
                const w = this.scene.worldTransform(m.uid)!;
                [at, rot] = [group.toFrame([w.x, w.y]), w.rot - refRot];
            }
            return { uid: m.uid, x: at[0] - c[0], y: at[1] - c[1], rot };
        });
        const tiles: ClipTile[] = [];
        for (const [g, cells] of group.tiles) {
            for (const [k, t] of cells) {
                const [x, y] = cellOf(k);
                const at: Point = g === group.ref ? [x + 0.5, y + 0.5] : group.toFrame(this.scene.toWorld(g, x + 0.5, y + 0.5));
                tiles.push({ x: at[0] - c[0], y: at[1] - c[1], name: t.name, variant: t.variant, rot: t.rot });
            }
        }
        const decals: ClipDecal[] = group.decals.map((d) => {
            const centre: Point = [d.x + d.w / 2, d.y + d.h / 2];
            const at = d.grid === group.ref ? centre : group.toFrame(this.scene.toWorld(d.grid, ...centre));
            return { ...d.props, x: at[0] - c[0], y: at[1] - c[1], w: d.w, h: d.h };
        });
        const lattice = group.snaps ? (Number.isInteger(c[0]) ? "whole" : "half") : null;
        return copyParts(this.doc, { roots, tiles, decals, lattice });
    }

    /** Where a clipboard would land for a world point: the grid there and the anchor on it (snapped), or null. */
    pasteTarget(clip: Clip, wx: number, wy: number, turns: number): PasteTarget | null {
        const grid = this.scene.gridAt(wx, wy);
        if (grid === null) return null;
        return { grid, anchor: snapAnchor(clip, this.scene.toLocal(grid, wx, wy)), turns };
    }

    /** What a paste would put where (grid coordinates), for its ghost. */
    pastePreview(clip: Clip, target: PasteTarget) {
        return pastePlan(clip, target);
    }

    /** Pastes a clipboard at a world point as one undo step; the pasted things become the selection. */
    paste(clip: Clip, wx: number, wy: number, turns: number, known?: PasteKnown): PasteResult | null {
        if (this.busy) return null;
        const target = this.pasteTarget(clip, wx, wy, turns);
        if (!target) return null;
        return this.tracked(() => {
            const result = this.hold(() => pasteClip(this.doc, clip, target, known));
            const pick = new Selection();
            for (const uid of result.roots) pick.addEntity(uid);
            for (const [x, y] of result.tiles) pick.addTile(target.grid, x, y);
            for (const id of result.decals) pick.addDecal(target.grid, id);
            this.float = null;
            this.selected.assign(pick);
            return result;
        });
    }

    // ---- tiles

    /** Grid tile at a world point (on the grid there, else the nearest one). */
    tileTarget(wx: number, wy: number): GridPoint | null {
        const grid = this.scene.gridAt(wx, wy);
        if (grid === null) return null;
        const [lx, ly] = this.scene.toLocal(grid, wx, wy);
        return { grid, x: Math.floor(lx), y: Math.floor(ly) };
    }

    /** Paints the tile at a world point ("Space" erases); returns whether it changed. */
    paint(name: string, wx: number, wy: number): boolean {
        const t = this.tileTarget(wx, wy);
        if (!t || (this.mirrorMode !== "off" && this.visited?.has(`${t.grid}|${t.x}|${t.y}`))) return false;
        return this.doc.batch("Paint", () => this.paintCells(name, t.grid, [[t.x, t.y]])) > 0;
    }

    private paintCells(name: string, grid: number, cells: readonly Cell[]): number {
        const edits: TileEdit[] = [];
        const variants = new Map<Point, number>();
        for (const { x, y, source, flip, rotationMirroring } of this.tileBrush(grid, cells)) {
            if (this.mirrorMode !== "off") this.visited?.add(`${grid}|${x}|${y}`);
            const sameName = (this.scene.tileAt(grid, x, y) ?? "Space") === name;
            if (sameName && (!flip || name === "Space")) continue;
            let variant = variants.get(source);
            if (variant === undefined) {
                const sx = Math.floor(source[0]), sy = Math.floor(source[1]);
                variant = name === "Space" ? 0 : flip && this.scene.tileAt(grid, sx, sy) === name
                    ? this.doc.tile(grid, sx, sy).variant : this.variant(name);
                variants.set(source, variant);
            }
            if (sameName) {
                const tile = this.doc.tile(grid, x, y);
                if (tile.rotationMirroring === rotationMirroring && tile.variant === variant) continue;
            }
            edits.push({ x, y, name, variant, rotationMirroring });
        }
        if (edits.length) this.doc.setTiles(grid, edits);
        if (name === "Space" && edits.length) deleteDecalsOnSpace(this.doc, grid, edits.map((e) => cellKey(e.x, e.y)));
        return edits.length;
    }

    /** Erases the topmost drawn entity (with its contents) or decal at each brush point. */
    erase(kind: "entities" | "decals", wx: number, wy: number): boolean {
        const points = this.erasePoints(wx, wy);
        const entities = new Set<number>();
        const decals = new Map<number, Set<string>>();
        for (const { at, grid } of points) {
            if (kind === "entities") {
                const uid = this.entityAt(...at, grid === null ? undefined : (u) => this.scene.placement(u)?.grid === grid);
                if (uid !== null) entities.add(uid);
            } else {
                const d = this.decalUnder(...at, grid);
                if (!d) continue;
                let ids = decals.get(d.grid);
                if (!ids) decals.set(d.grid, (ids = new Set()));
                ids.add(d.id);
            }
        }
        return this.doc.batch(kind === "entities" ? "Delete" : "Erase", () => {
            for (const uid of entities) if (this.doc.proto(uid) !== undefined) this.doc.deleteEntity(uid);
            for (const [grid, ids] of decals) this.doc.deleteDecals(grid, ids);
            return entities.size > 0 || decals.size > 0;
        });
    }

    /** The decal under a world point: the one whose pixels are there, else the topmost whose box is (when shown). */
    decalUnder(wx: number, wy: number, grid: number | null = null): DecalLayer | null {
        if (!(this.view.decalsShown?.() ?? true)) return null;
        const accept = grid === null ? undefined : (d: DecalLayer) => d.grid === grid;
        return decalAt(this.scene, wx, wy, this.view.opaque, accept) ?? decalAt(this.scene, wx, wy, undefined, accept);
    }
}
