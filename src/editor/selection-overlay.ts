// Overlay drawing of the selection tools: outlines of selected tiles and entities, the area being drawn,
// ghosts of a selection being dragged and of a shape being drawn. Outlines are batched into a few paths of
// what is on screen; past a few thousand on screen, cached masks (a pixel per tile) show the selection instead,
// so tens of thousands of selected things stay cheap. Map chunks are never touched.
import type { Frame } from "../pack/loader";
import type { MapCanvas } from "../render/canvas";
import { PPM, type DecalLayer, type Scene, type SpriteLayer, type TileLayer } from "../render/scene";
import { cellKey, cellOf } from "./selection";
import type { Area, Cell, Point } from "./shapes";

export interface OverlayContext {
    g: CanvasRenderingContext2D;
    map: MapCanvas;
    scene: Scene;
    /** Canvas size in CSS px. */
    width: number;
    height: number;
}

const SELECTED = "#ffd24a";
const SHADOW = "rgba(0,0,0,0.7)";
/** Ghost layers drawn at most per frame (more are shown by the masks only). */
const MAX_GHOSTS = 4000;

/** Grid coordinates → screen, and the grid area on screen (with a tile of margin). */
function gridScreen(c: OverlayContext, grid: number) {
    const { map, scene } = c;
    const o = map.screenAt(...scene.toWorld(grid, 0, 0));
    const ux = map.screenAt(...scene.toWorld(grid, 1, 0)), uy = map.screenAt(...scene.toWorld(grid, 0, 1));
    const [ax, ay, bx, by] = [ux[0] - o[0], ux[1] - o[1], uy[0] - o[0], uy[1] - o[1]];
    const at = (lx: number, ly: number): Point => [o[0] + ax * lx + bx * ly, o[1] + ay * lx + by * ly];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [sx, sy] of [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]] as const) {
        const [lx, ly] = scene.toLocal(grid, ...(map.worldAt(sx, sy) ?? [0, 0]));
        x0 = Math.min(x0, lx);
        y0 = Math.min(y0, ly);
        x1 = Math.max(x1, lx);
        y1 = Math.max(y1, ly);
    }
    return { at, view: [Math.floor(x0) - 1, Math.floor(y0) - 1, Math.ceil(x1) + 1, Math.ceil(y1) + 1] as const };
}

// ---- masks: selected cells one pixel per tile, drawn through the grid's transform (cheap at any count)

interface CellMask {
    canvas: HTMLCanvasElement;
    x0: number;
    y0: number;
}

/** A mask of cells, or null when there are none (or the area is unreasonably large). */
function buildMask(cells: Iterable<[number, number]>): CellMask | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const list: Array<[number, number]> = [];
    for (const [x, y] of cells) {
        list.push([x, y]);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (!list.length || w * h > 4096 * 4096) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (const [x, y] of list) {
        const i = ((y - y0) * w + (x - x0)) * 4;
        img.data[i] = 255;
        img.data[i + 1] = 210;
        img.data[i + 2] = 74;
        img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas, x0, y0 };
}

/** Masks by grid, kept per owner (a selection's tile map or entity set) until its key changes. */
const masks = new WeakMap<object, { key: string; byGrid: Map<number, CellMask | null> }>();

function cachedMasks(owner: object, key: string, build: () => Map<number, Array<[number, number]>>): Map<number, CellMask | null> {
    const hit = masks.get(owner);
    if (hit?.key === key) return hit.byGrid;
    const byGrid = new Map<number, CellMask | null>();
    for (const [g, cells] of build()) byGrid.set(g, buildMask(cells));
    masks.set(owner, { key, byGrid });
    return byGrid;
}

/** Draws a grid's mask moved by whole tiles. */
function drawMask(c: OverlayContext, grid: number, mask: CellMask, [dx, dy]: [number, number], alpha: number): void {
    const { g, map, scene } = c;
    const o = map.screenAt(...scene.toWorld(grid, 0, 0));
    const ux = map.screenAt(...scene.toWorld(grid, 1, 0)), uy = map.screenAt(...scene.toWorld(grid, 0, 1));
    const [ax, ay, bx, by] = [ux[0] - o[0], ux[1] - o[1], uy[0] - o[0], uy[1] - o[1]];
    const X = mask.x0 + dx, Y = mask.y0 + dy;
    g.save();
    // mask pixel (i, j) is grid cell (X + i, Y + j)
    g.transform(ax, ay, bx, by, o[0] + ax * X + bx * Y, o[1] + ay * X + by * Y);
    g.imageSmoothingEnabled = false;
    g.globalAlpha = alpha;
    g.drawImage(mask.canvas, 0, 0);
    g.restore();
}

/** Outlines drawn as paths only while this many things are on screen; beyond it, masks show them. */
const EDGE_LIMIT = 4000;
const BOX_LIMIT = 3000;

/**
 * Selected tiles: a light fill and, while few enough are on screen, the outline of the selected area (edges
 * between selected and other tiles); shifted on each grid by `offset` tiles. `version` keys the cached fill.
 */
export function outlineTiles(c: OverlayContext, tiles: ReadonlyMap<number, ReadonlySet<number>>, offset: (grid: number) => [number, number], version: number): void {
    const { g } = c;
    const byGrid = cachedMasks(tiles, String(version), () => new Map([...tiles].map(([grid, set]) => [grid, [...set].map(cellOf)])));
    for (const [grid, set] of tiles) {
        if (!set.size) continue;
        const [dx, dy] = offset(grid);
        const { at, view } = gridScreen(c, grid);
        const shown: number[] = [];
        for (const k of set) {
            const [x, y] = cellOf(k);
            const X = x + dx, Y = y + dy;
            if (X < view[0] || Y < view[1] || X > view[2] || Y > view[3]) continue;
            shown.push(k);
            if (shown.length > EDGE_LIMIT) break;
        }
        const mask = byGrid.get(grid);
        const edges = shown.length <= EDGE_LIMIT;
        if (mask) drawMask(c, grid, mask, [dx, dy], edges ? 0.16 : 0.3);
        if (!edges || !shown.length) continue;
        const path = new Path2D();
        const seg = (x0: number, y0: number, x1: number, y1: number) => {
            path.moveTo(...at(x0, y0));
            path.lineTo(...at(x1, y1));
        };
        for (const k of shown) {
            const [x, y] = cellOf(k);
            const X = x + dx, Y = y + dy;
            if (!set.has(cellKey(x - 1, y))) seg(X, Y, X, Y + 1);
            if (!set.has(cellKey(x + 1, y))) seg(X + 1, Y, X + 1, Y + 1);
            if (!set.has(cellKey(x, y - 1))) seg(X, Y, X + 1, Y);
            if (!set.has(cellKey(x, y + 1))) seg(X, Y + 1, X + 1, Y + 1);
        }
        g.lineWidth = 3;
        g.strokeStyle = SHADOW;
        g.stroke(path);
        g.lineWidth = 1.5;
        g.strokeStyle = SELECTED;
        g.stroke(path);
    }
}

/** Screen box around the drawn layers of an entity (its position when nothing of it is drawn), moved by a world vector. */
export function entityBox(c: OverlayContext, uid: number, [dx, dy]: Point): [number, number, number, number] | null {
    const { scene, map } = c;
    const k = map.view.scale; // CSS px per texture px
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of scene.layersOf(uid)) {
        if (!map.visible(l)) continue;
        const [, , , fw, fh] = scene.frames[l.frame]!;
        const [cx, cy] = map.screenAt(l.x + dx, l.y + dy);
        const cs = Math.cos(-l.rot), sn = Math.sin(-l.rot);
        const hw = (fw / 2) * Math.abs(l.scale?.[0] ?? 1) * k, hh = (fh / 2) * Math.abs(l.scale?.[1] ?? 1) * k;
        for (const [u, v] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
            const x = cx + cs * u - sn * v, y = cy + sn * u + cs * v;
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x);
            y1 = Math.max(y1, y);
        }
    }
    if (x0 === Infinity) {
        const w = scene.worldTransform(uid);
        if (!w) return null;
        const [cx, cy] = map.screenAt(w.x + dx, w.y + dy);
        const h = (PPM / 2) * k;
        return [cx - h, cy - h, cx + h, cy + h];
    }
    return [x0, y0, x1, y1];
}

/**
 * Selected entities: boxes around them while few enough are on screen (moved by a world vector), else their
 * tiles in a mask (moved on each grid by `offset` tiles). `key` keys the cached mask (selection and map changes).
 */
export function outlineEntities(
    c: OverlayContext,
    uids: ReadonlySet<number>,
    delta: Point,
    offset: (grid: number) => [number, number],
    key: string,
    many = uids.size,
): void {
    const { g, map, scene } = c;
    const margin = 4 * PPM * map.view.scale;
    const shown: number[] = [];
    for (const uid of uids) {
        const w = scene.worldTransform(uid);
        if (!w) continue;
        const [sx, sy] = map.screenAt(w.x + delta[0], w.y + delta[1]);
        if (sx < -margin || sy < -margin || sx > c.width + margin || sy > c.height + margin) continue;
        shown.push(uid);
        if (shown.length > BOX_LIMIT) break;
    }
    if (shown.length > BOX_LIMIT) {
        const byGrid = cachedMasks(uids, key, () => {
            const cells = new Map<number, Array<[number, number]>>();
            for (const uid of uids) {
                const p = scene.placement(uid);
                if (!p || p.grid === null) continue;
                let list = cells.get(p.grid);
                if (!list) cells.set(p.grid, (list = []));
                list.push([Math.floor(p.x), Math.floor(p.y)]);
            }
            return cells;
        });
        for (const [grid, mask] of byGrid) if (mask) drawMask(c, grid, mask, offset(grid), 0.3);
        return;
    }
    const path = new Path2D();
    for (const uid of shown) {
        const b = entityBox(c, uid, delta);
        if (b) path.rect(b[0] - 1, b[1] - 1, b[2] - b[0] + 2, b[3] - b[1] + 2);
    }
    // one entity stands out; many get lighter boxes, so the tiles' outline still reads
    const light = many > 1;
    g.lineWidth = light ? 2 : 3;
    g.strokeStyle = light ? "rgba(0,0,0,0.45)" : SHADOW;
    g.stroke(path);
    g.lineWidth = light ? 1 : 1.5;
    g.strokeStyle = light ? "rgba(255,210,74,0.75)" : SELECTED;
    g.stroke(path);
}

/** Corners of a decal layer on screen, moved by a world vector. */
export function decalCorners(c: OverlayContext, d: DecalLayer, [dx, dy]: Point): Point[] {
    const { map, scene } = c;
    const [, , , fw, fh] = scene.frames[d.frame]!;
    const k = map.view.scale;
    const [cx, cy] = map.screenAt(d.x + dx, d.y + dy);
    const cs = Math.cos(-d.rot), sn = Math.sin(-d.rot);
    const hw = (fw / 2) * k, hh = (fh / 2) * k;
    return ([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const).map(([u, v]) => [cx + cs * u - sn * v, cy + sn * u + cs * v]);
}

/**
 * Selected decals: their outlines (turned with them) while few enough are on screen, moved by a world vector,
 * else their tiles in a mask. `key` keys the cached mask.
 */
export function outlineDecals(c: OverlayContext, decals: ReadonlyMap<number, ReadonlySet<string>>, delta: Point, offset: (grid: number) => [number, number], key: string): void {
    const { g, map, scene } = c;
    const margin = 4 * PPM * map.view.scale;
    const shown: DecalLayer[] = [];
    for (const [grid, ids] of decals) {
        for (const id of ids) {
            const d = scene.decalLayer(grid, id);
            if (!d) continue;
            const [sx, sy] = map.screenAt(d.x + delta[0], d.y + delta[1]);
            if (sx < -margin || sy < -margin || sx > c.width + margin || sy > c.height + margin) continue;
            shown.push(d);
            if (shown.length > BOX_LIMIT) break;
        }
    }
    if (shown.length > BOX_LIMIT) {
        const byGrid = cachedMasks(decals, key, () => {
            const cells = new Map<number, Array<[number, number]>>();
            for (const [grid, ids] of decals) {
                const list: Array<[number, number]> = [];
                for (const id of ids) {
                    const d = scene.decalLayer(grid, id);
                    if (!d) continue;
                    const [lx, ly] = scene.toLocal(grid, d.x, d.y);
                    list.push([Math.floor(lx), Math.floor(ly)]);
                }
                cells.set(grid, list);
            }
            return cells;
        });
        for (const [grid, mask] of byGrid) if (mask) drawMask(c, grid, mask, offset(grid), 0.3);
        return;
    }
    if (!shown.length) return;
    const path = new Path2D();
    for (const d of shown) {
        const pts = decalCorners(c, d, delta);
        pts.forEach((p, i) => (i ? path.lineTo(...p) : path.moveTo(...p)));
        path.closePath();
    }
    g.setLineDash([3, 2]);
    g.lineWidth = 2;
    g.strokeStyle = "rgba(0,0,0,0.5)";
    g.stroke(path);
    g.lineWidth = 1;
    g.strokeStyle = "rgba(127,255,212,0.9)";
    g.stroke(path);
    g.setLineDash([]);
}

/** A thing in a paste ghost: an icon at a grid point, turned (radians, on the grid). */
export interface GhostIcon {
    x: number;
    y: number;
    rot: number;
    frame: Frame | null;
    /** Scale the icon to a tile (tiles) rather than keeping texture pixels (entities). */
    fit: boolean;
}

/**
 * Ghost of a paste on a grid: icons of its tiles and entities, outlines of its decals (centre, size in tiles,
 * angle), and a dashed box round everything.
 */
export function drawPasteGhost(c: OverlayContext, grid: number, icons: readonly GhostIcon[], boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number; rot: number }>): void {
    const { g, map, scene } = c;
    const { at } = gridScreen(c, grid);
    const gridRot = scene.worldTransform(grid)?.rot ?? 0;
    const k = map.view.scale;
    const margin = 4 * PPM * k;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    g.save();
    const base = g.getTransform();
    g.globalAlpha = 0.7;
    g.imageSmoothingEnabled = false;
    let drawn = 0;
    for (const i of icons) {
        const [sx, sy] = at(i.x, i.y);
        x0 = Math.min(x0, sx);
        y0 = Math.min(y0, sy);
        x1 = Math.max(x1, sx);
        y1 = Math.max(y1, sy);
        if (!i.frame || drawn >= MAX_GHOSTS || sx < -margin || sy < -margin || sx > c.width + margin || sy > c.height + margin) continue;
        const img = map.pageImage(i.frame[0]);
        if (!img) continue;
        const [, fx, fy, fw, fh] = i.frame;
        const s = i.fit ? (PPM * k) / Math.max(fw, fh) : k;
        g.setTransform(base);
        g.translate(sx, sy);
        g.rotate(-(gridRot + i.rot));
        g.drawImage(img, fx, fy, fw, fh, (-fw / 2) * s, (-fh / 2) * s, fw * s, fh * s);
        drawn++;
    }
    g.setTransform(base);
    g.globalAlpha = 1;
    const path = new Path2D();
    for (const b of boxes) {
        const cs = Math.cos(b.rot), sn = Math.sin(b.rot);
        const pts = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([u, v]) => at(b.x + (cs * u * b.w - sn * v * b.h) / 2, b.y + (sn * u * b.w + cs * v * b.h) / 2));
        pts.forEach((p, i) => (i ? path.lineTo(...p) : path.moveTo(...p)));
        path.closePath();
        for (const [px, py] of pts) {
            x0 = Math.min(x0, px);
            y0 = Math.min(y0, py);
            x1 = Math.max(x1, px);
            y1 = Math.max(y1, py);
        }
    }
    g.lineWidth = 1;
    g.strokeStyle = "rgba(127,255,212,0.9)";
    g.stroke(path);
    if (x0 !== Infinity) {
        const pad = (PPM * k) / 2;
        g.setLineDash([6, 4]);
        g.lineWidth = 1.5;
        g.strokeStyle = "#ffffff";
        g.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
        g.setLineDash([]);
    }
    g.restore();
}

/** The area a selection tool is drawing: dashed, with a light fill. */
export function drawArea(c: OverlayContext, area: Area): void {
    const { g, map } = c;
    g.beginPath();
    if (area.kind === "polygon") {
        area.points.forEach((p, i) => (i ? g.lineTo(...map.screenAt(...p)) : g.moveTo(...map.screenAt(...p))));
        g.closePath();
    } else {
        const [ax, ay] = map.screenAt(...area.a), [bx, by] = map.screenAt(...area.b);
        if (area.kind === "rect") g.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
        else g.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, 2 * Math.PI);
    }
    g.fillStyle = "rgba(127,212,255,0.12)";
    g.fill();
    g.setLineDash([]);
    g.lineWidth = 3;
    g.strokeStyle = SHADOW;
    g.stroke();
    g.setLineDash([6, 4]);
    g.lineWidth = 1.5;
    g.strokeStyle = "#ffffff";
    g.stroke();
    g.setLineDash([]);
}

/**
 * Sprite and tile layers of a dragged selection, drawn moved by a world vector (what is on screen). Returns
 * false, drawing nothing, when too many are on screen (the masks then show the move).
 */
export function drawGhostLayers(
    c: OverlayContext,
    sprites: readonly SpriteLayer[],
    tiles: readonly TileLayer[],
    decals: readonly DecalLayer[],
    [dx, dy]: Point,
    alpha: number,
): boolean {
    const { g, map, scene } = c;
    const k = map.view.scale;
    const margin = 4 * PPM * k;
    const onScreen = (x: number, y: number) => {
        const [sx, sy] = map.screenAt(x + dx, y + dy);
        return sx >= -margin && sy >= -margin && sx <= c.width + margin && sy <= c.height + margin;
    };
    const ts = tiles.filter((t) => onScreen(t.x, t.y));
    const ss = sprites.filter((s) => map.visible(s) && onScreen(s.x, s.y));
    const ds = decals.filter((d) => onScreen(d.x, d.y));
    if (ts.length + ss.length + ds.length > MAX_GHOSTS) return false;
    g.save();
    const base = g.getTransform();
    const draw = (x: number, y: number, frame: number, pre: (() => void) | null) => {
        const [page, fx, fy, fw, fh] = scene.frames[frame]!;
        const img = map.pageImage(page);
        if (!img) return;
        const [sx, sy] = map.screenAt(x + dx, y + dy);
        g.setTransform(base);
        g.translate(sx, sy);
        pre?.();
        g.drawImage(img, fx, fy, fw, fh, (-fw / 2) * k, (-fh / 2) * k, fw * k, fh * k);
    };
    g.globalAlpha = alpha;
    g.imageSmoothingEnabled = false;
    for (const t of ts) {
        draw(t.x, t.y, t.frame, () => {
            if (t.gridRot) g.rotate(-t.gridRot);
            if (t.rotMirror > 3) g.scale(-1, 1);
            if (t.rotMirror % 4) g.rotate((-(t.rotMirror % 4) * Math.PI) / 2);
        });
    }
    for (const d of ds) draw(d.x, d.y, d.frame, d.rot ? () => g.rotate(-d.rot) : null);
    for (const s of ss) {
        draw(s.x, s.y, s.frame, s.rot || s.scale ? () => {
            if (s.rot) g.rotate(-s.rot);
            if (s.scale) g.scale(s.scale[0], s.scale[1]);
        } : null);
    }
    g.setTransform(base);
    g.restore();
    return true;
}

/**
 * Ghost of a shape being drawn: the brush's icon on each of its tiles (on screen) and the tiles' outlines.
 * `fit` scales the icon to a tile (tile icons) or keeps texture pixels (entities, 0).
 */
export function drawCellGhosts(c: OverlayContext, grid: number, cells: readonly Cell[], frame: Frame | null, rotation: number, fit: boolean, color: string): void {
    const { g, map, scene } = c;
    const { at, view } = gridScreen(c, grid);
    const gridRot = scene.worldTransform(grid)?.rot ?? 0;
    const k = map.view.scale;
    const img = frame ? map.pageImage(frame[0]) : null;
    const outline = new Path2D();
    let drawn = 0;
    g.save();
    const base = g.getTransform();
    g.globalAlpha = 0.6;
    g.imageSmoothingEnabled = false;
    for (const [x, y] of cells) {
        if (x < view[0] || y < view[1] || x > view[2] || y > view[3]) continue;
        outline.moveTo(...at(x, y));
        outline.lineTo(...at(x + 1, y));
        outline.lineTo(...at(x + 1, y + 1));
        outline.lineTo(...at(x, y + 1));
        outline.closePath();
        if (!img || !frame || drawn >= MAX_GHOSTS) continue;
        const [, fx, fy, fw, fh] = frame;
        const s = fit ? (PPM * k) / Math.max(fw, fh) : k;
        const [sx, sy] = at(x + 0.5, y + 0.5);
        g.setTransform(base);
        g.translate(sx, sy);
        g.rotate(-(gridRot + rotation));
        g.drawImage(img, fx, fy, fw, fh, (-fw / 2) * s, (-fh / 2) * s, fw * s, fh * s);
        drawn++;
    }
    g.setTransform(base);
    g.globalAlpha = 1;
    g.lineWidth = 2.5;
    g.strokeStyle = SHADOW;
    g.stroke(outline);
    g.lineWidth = 1;
    g.strokeStyle = color;
    g.stroke(outline);
    g.restore();
}
