import type { OverlayContext } from "./selection-overlay";
import type { Point } from "./shapes";

/** Test the segment itself, including lines with both ends outside the viewport. */
export function segmentVisible([ax, ay]: Point, [bx, by]: Point, width: number, height: number, margin = 6): boolean {
    let enter = 0, exit = 1;
    for (const [start, end, limit] of [[ax, bx, width], [ay, by, height]] as const) {
        const delta = end - start;
        if (!delta) {
            if (start < -margin || start > limit + margin) return false;
            continue;
        }
        const a = (-margin - start) / delta, b = (limit + margin - start) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit) return false;
    }
    return true;
}

export function segmentDistance([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): number {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

export interface InspectionHint {
    at: Point;
    lines: string[];
}

export function drawInspectionHint(c: OverlayContext, { at: [x, y], lines }: InspectionHint): void {
    const { g } = c;
    g.save();
    g.font = "12px system-ui, sans-serif";
    g.textBaseline = "top";
    g.textAlign = "left";
    const width = Math.min(c.width - 8, Math.max(...lines.map((line) => g.measureText(line).width)) + 16);
    const height = 16 * lines.length + 12;
    const left = Math.max(4, Math.min(x + 14, c.width - width - 4));
    const top = Math.max(4, Math.min(y + 14, c.height - height - 4));
    if (width > 16) {
        g.fillStyle = "#17222e";
        g.fillRect(left, top, width, height);
        g.strokeStyle = "#536578";
        g.lineWidth = 1;
        g.strokeRect(left, top, width, height);
        g.fillStyle = "#e9f4ff";
        lines.forEach((line, i) => g.fillText(line, left + 8, top + 6 + 16 * i, width - 16));
    }
    g.restore();
}
