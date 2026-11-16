import type { Point } from "./shapes";
import type { OverlayContext } from "./selection-overlay";
import type { Scene } from "../render/scene";

export type RulerSnap = "centers" | "corners" | "free";
export interface RulerPoint {
    world: Point;
    grid: number | null;
}

type GridCoordinates = Pick<Scene, "gridAt" | "toLocal" | "toWorld">;

export function rulerPoint(scene: GridCoordinates, world: Point, snap: RulerSnap): RulerPoint {
    const grid = scene.gridAt(...world);
    if (snap === "free") return { world, grid };
    const [x, y] = grid === null ? world : scene.toLocal(grid, ...world);
    // Inverting a rotated grid transform can put an integer just below the cell boundary.
    const center = (n: number) => Math.floor(n + 1e-9) + 0.5;
    const at: Point = snap === "centers" ? [center(x), center(y)] : [Math.round(x), Math.round(y)];
    return { world: grid === null ? at : scene.toWorld(grid, ...at), grid };
}

export function rulerMeasurement(scene: Pick<Scene, "toLocal">, from: RulerPoint, to: RulerPoint) {
    const grid = from.grid === to.grid ? from.grid : null;
    const a = grid === null ? from.world : scene.toLocal(grid, ...from.world);
    const b = grid === null ? to.world : scene.toLocal(grid, ...to.world);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    return { grid, dx, dy, distance: Math.hypot(dx, dy) };
}

export function rulerLabel(scene: Pick<Scene, "toLocal">, from: RulerPoint, to: RulerPoint): string {
    const { grid, dx, dy, distance } = rulerMeasurement(scene, from, to);
    const number = (n: number) => Number(n.toFixed(2)).toString();
    return `${number(distance)} tiles · ΔX ${number(dx)} · ΔY ${number(dy)} · ${grid === null ? "World axes" : `Grid #${grid}`}`;
}

export function drawRuler(c: OverlayContext, from: RulerPoint, to: RulerPoint, fixed: boolean): void {
    const { g, map } = c;
    const a = map.screenAt(...from.world), b = map.screenAt(...to.world);
    g.save();
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(...a);
    g.lineTo(...b);
    g.lineWidth = 5;
    g.strokeStyle = "#142431";
    g.stroke();
    g.lineWidth = 2;
    g.strokeStyle = "#7ee2ff";
    if (!fixed) g.setLineDash([5, 4]);
    g.stroke();
    g.setLineDash([]);
    for (const point of [a, b]) {
        g.beginPath();
        g.arc(...point, 4, 0, Math.PI * 2);
        g.fillStyle = "#7ee2ff";
        g.fill();
        g.strokeStyle = "#142431";
        g.stroke();
    }
    g.font = "600 12px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const label = rulerLabel(c.scene, from, to);
    const half = Math.min(c.width / 2 - 4, g.measureText(label).width / 2 + 8);
    const x = Math.max(half + 4, Math.min(c.width - half - 4, (a[0] + b[0]) / 2));
    const y = Math.max(15, Math.min(c.height - 15, (a[1] + b[1]) / 2 - 17));
    g.fillStyle = "#142431";
    g.fillRect(x - half, y - 11, half * 2, 22);
    g.fillStyle = "#dcf7ff";
    if (half > 8) g.fillText(label, x, y, half * 2 - 16);
    g.restore();
}
