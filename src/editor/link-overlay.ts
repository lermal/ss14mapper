// Overlay of the multitool and of the selected entity's links: lines from sources to sinks and from
// configurators to the devices in their lists, arrowheads at the receiving end, the port pairs written along
// signal lines when there are few of them. Drawn for one entity at a time, so it stays cheap.
import type { LinkLine } from "./multitool";
import { entityBox, type OverlayContext } from "./selection-overlay";
import type { Point } from "./shapes";

export const LINK_COLORS = { signal: "#4fc3f7", device: "#9cff6b", held: "#ff6bd6", hover: "rgba(255,255,255,0.8)" } as const;

/** Pairs are written along the lines up to this many lines. */
const LABEL_LIMIT = 24;

export function drawLinkLines(c: OverlayContext, lines: readonly LinkLine[]): void {
    const { g } = c;
    // the middle of what is drawn of the entity (wall-mounted devices are drawn off their tile's centre)
    const at = (uid: number): Point | null => {
        const b = entityBox(c, uid, [0, 0]);
        return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
    };
    const drawn: Array<{ line: LinkLine; a: Point; b: Point }> = [];
    for (const line of lines) {
        const a = at(line.from), b = at(line.to);
        if (a && b) drawn.push({ line, a, b });
    }
    g.lineCap = g.lineJoin = "round";
    for (const pass of [0, 1]) {
        for (const { line, a, b } of drawn) {
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            g.beginPath();
            g.moveTo(...a);
            g.lineTo(...b);
            if (len > 12) {
                // arrowhead a little before the receiving entity's centre
                const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
                const tip: Point = [b[0] - ux * 6, b[1] - uy * 6];
                g.moveTo(tip[0] - ux * 9 - uy * 5, tip[1] - uy * 9 + ux * 5);
                g.lineTo(...tip);
                g.lineTo(tip[0] - ux * 9 + uy * 5, tip[1] - uy * 9 - ux * 5);
            }
            g.lineWidth = pass ? 2 : 4.5;
            g.strokeStyle = pass ? LINK_COLORS[line.kind] : "rgba(0,0,0,0.7)";
            if (line.kind === "device") g.setLineDash(pass ? [6, 4] : []);
            g.stroke();
            g.setLineDash([]);
        }
    }
    if (drawn.length > LABEL_LIMIT) return;
    g.font = "12px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const { line, a, b } of drawn) {
        if (!line.pairs.length) continue;
        const text = line.pairs.map(([s, k]) => `${s}→${k}`).join(", ");
        const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
        g.lineWidth = 3;
        g.strokeStyle = "rgba(0,0,0,0.85)";
        g.strokeText(text, x, y - 8);
        g.fillStyle = LINK_COLORS.signal;
        g.fillText(text, x, y - 8);
    }
}

/** Boxes around entities in one colour (the held entity, list members, the device under the cursor). */
export function boxEntities(c: OverlayContext, uids: Iterable<number>, color: string, width = 1.5): void {
    const path = new Path2D();
    let any = false;
    for (const uid of uids) {
        const b = entityBox(c, uid, [0, 0]);
        if (!b) continue;
        any = true;
        path.rect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4);
    }
    if (!any) return;
    c.g.lineWidth = width + 2;
    c.g.strokeStyle = "rgba(0,0,0,0.7)";
    c.g.stroke(path);
    c.g.lineWidth = width;
    c.g.strokeStyle = color;
    c.g.stroke(path);
}
