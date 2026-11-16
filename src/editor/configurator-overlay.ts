import { t as translate } from "../i18n";
import type { MapDocument } from "../map/document";
import { toPlain } from "../map/yaml";
import type { Pack } from "../pack/loader";
import { segmentDistance, segmentVisible, type InspectionHint } from "./inspection-overlay";
import { entityLabel } from "./multitool";
import { entityBox, type OverlayContext } from "./selection-overlay";
import type { Point } from "./shapes";

/** The saved list owner is the source of each membership, including for devices shared by several lists. */
export class ConfiguratorLinks {
    readonly lists = new Map<number, number[]>();
    private readonly colors = new Map<number, string>();

    constructor(private readonly doc: Pick<MapDocument, "uids" | "deviceList">) {
        this.update(doc.uids());
    }

    update(uids: Iterable<number>): void {
        for (const uid of uids) {
            const members = this.doc.deviceList(uid);
            if (!members.length) {
                this.lists.delete(uid);
                continue;
            }
            this.lists.set(uid, [...new Set(members)]);
            if (!this.colors.has(uid)) this.colors.set(uid, `hsl(${(330 + this.colors.size * 137.508) % 360} 85% 70%)`);
        }
    }

    color(owner: number): string {
        return this.colors.get(owner)!;
    }
}

interface VisibleLink {
    owner: number;
    member: number;
    a: Point;
    b: Point;
}

export function drawConfiguratorLinks(c: OverlayContext, index: ConfiguratorLinks, doc: MapDocument, pack: Pack, cursor: Point | null): InspectionHint | null {
    const { g } = c;
    const points = new Map<number, Point | null>();
    const at = (uid: number): Point | null => {
        const saved = points.get(uid);
        if (saved !== undefined) return saved;
        const box = entityBox(c, uid, [0, 0]);
        const p: Point | null = box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : null;
        points.set(uid, p);
        return p;
    };
    const links: VisibleLink[] = [];
    let hover: VisibleLink | null = null, distance = 8;
    for (const [owner, members] of index.lists) {
        const start = at(owner);
        if (!start) continue;
        for (const member of members) {
            const end = at(member);
            if (!end || !segmentVisible(start, end, c.width, c.height)) continue;
            const link = { owner, member, a: start, b: end };
            links.push(link);
            if (!cursor) continue;
            const d = segmentDistance(cursor, start, end);
            if (d < distance) [hover, distance] = [link, d];
        }
    }
    g.save();
    g.lineCap = g.lineJoin = "round";
    for (const highlight of [false, true]) {
        for (const { owner, a, b } of links) {
            if ((owner === hover?.owner) !== highlight) continue;
            const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
            g.beginPath();
            if (len < 2) g.arc(...a, 4, 0, 2 * Math.PI);
            else {
                g.moveTo(...a);
                g.lineTo(...b);
                if (len > 18) {
                    const ux = dx / len, uy = dy / len;
                    const x = b[0] - ux * 5, y = b[1] - uy * 5;
                    g.moveTo(x - ux * 8 - uy * 4, y - uy * 8 + ux * 4);
                    g.lineTo(x, y);
                    g.lineTo(x - ux * 8 + uy * 4, y - uy * 8 - ux * 4);
                }
            }
            g.setLineDash([]);
            g.lineWidth = highlight ? 6 : 4;
            g.strokeStyle = "#17222e";
            g.stroke();
            g.setLineDash([6, 3]);
            g.lineWidth = highlight ? 3 : 1.6;
            g.strokeStyle = index.color(owner);
            g.stroke();
        }
    }
    g.restore();
    if (!hover || !cursor) return null;
    const { owner, member } = hover;
    const field = doc.componentField(owner, "DeviceList", "isAllowList");
    const proto = pack.migrate(doc.proto(owner) ?? "");
    const allowList = field ? toPlain(field) : pack.prototypes.entities[proto ?? ""]?.components.DeviceList?.isAllowList ?? true;
    const purpose = allowList === true ? translate("Allow list") : allowList === false ? translate("Deny list") : translate("Device list");
    return { at: cursor, lines: [`${entityLabel(doc, owner, pack)} → ${entityLabel(doc, member, pack)}`, purpose] };
}
