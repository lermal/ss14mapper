import type { DecalProps } from "../map/decals";
import type { Pack } from "../pack/loader";
import { pipeConnectionsAtRotation, PPM } from "../render/scene";
import { layerPrototypes } from "./pipe-layers";
import type { Point } from "./shapes";

export type MirrorMode = "off" | "horizontal" | "vertical" | "both";
export type Flip = Exclude<MirrorMode, "off">;
export type MirrorAxis = Exclude<Flip, "both">;

const QUARTER = Math.PI / 2;
const TAU = 2 * Math.PI;

export function snapMirrorAxis(value: number): number {
    return Math.round(value * 2) / 2;
}

export function mirrorPoint([x, y]: Point, [cx, cy]: Point, flip: Flip): Point {
    return [flip === "vertical" ? x : 2 * cx - x, flip === "horizontal" ? y : 2 * cy - y];
}

export function mirrorCopies(point: Point, centre: Point, mode: MirrorMode): Array<{ at: Point; flip: Flip | null }> {
    const copies: Array<{ at: Point; flip: Flip | null }> = [{ at: point, flip: null }];
    const flips: Flip[] = mode === "both" ? ["horizontal", "vertical", "both"] : mode === "off" ? [] : [mode];
    for (const flip of flips) {
        const at = mirrorPoint(point, centre, flip);
        if (!copies.some(({ at: [x, y] }) => x === at[0] && y === at[1])) copies.push({ at, flip });
    }
    return copies;
}

function nearAngle(angle: number, original: number): number {
    return angle + TAU * Math.round((original - angle) / TAU);
}

// Angle zero faces south.
export function mirrorAngle(angle: number, flip: Flip): number {
    if (flip === "horizontal") return -angle;
    return nearAngle(flip === "vertical" ? Math.PI - angle : angle + Math.PI, angle);
}

// The renderer rotates first, then mirrors the tile's X coordinate in its grid.
export function mirrorTileRotation(rot: number, flip: Flip): number {
    const turn = (rot + (flip === "horizontal" ? 0 : 2)) & 3;
    return (rot & 4) ^ (flip === "both" ? 0 : 4) ^ turn;
}

function mirrorPipeMask(mask: number, flip: Flip): number {
    const ns = flip === "horizontal" ? mask & 3 : ((mask & 1) << 1) | ((mask & 2) >> 1);
    const ew = flip === "vertical" ? mask & 12 : ((mask & 4) << 1) | ((mask & 8) >> 1);
    return ns | ew;
}

export function mirrorEntity(pack: Pack, proto: string, angle: number, flip: Flip) {
    const current = pack.migrate(proto) ?? proto;
    const c = pack.prototypes.entities[current]?.components;
    if (c?.CableVisualizer) return { proto, angle };
    const facing = mirrorAngle(angle, flip);
    const nodes = c ? pipeConnectionsAtRotation(c, angle) : [];
    if (!nodes.length) return { proto, angle: facing };

    const wanted = nodes.map(([group, layer, mask]) => [group, layer, mirrorPipeMask(mask, flip)] as const);
    const turns = [0, 1, -1, 2].map((turn) => nearAngle(angle + turn * QUARTER, facing));
    turns.sort((a, b) => Math.abs(a - facing) - Math.abs(b - facing));
    const rotation = turns.find((turn) => {
        const remaining = pipeConnectionsAtRotation(c, turn);
        return wanted.every(([group, layer, mask]) => {
            const i = remaining.findIndex((node) => node[0] === group && node[1] === layer && node[2] === mask);
            if (i < 0) return false;
            remaining.splice(i, 1);
            return true;
        });
    }) ?? facing;
    const variants = layerPrototypes(pack, current);
    const layer = variants?.indexOf(current) ?? -1;
    if (variants && layer > 0) {
        // In the pipe sprites, secondary vertical runs are offset east and horizontal runs north.
        // For junctions with an equal number of arms on each axis, either side is equally close.
        const mask = nodes.reduce((mask, node) => mask | node[2], 0);
        const vertical = Number(!!(mask & 1)) + Number(!!(mask & 2));
        const horizontal = Number(!!(mask & 4)) + Number(!!(mask & 8));
        const swap = flip === "both" || (flip === "horizontal" ? vertical > horizontal : horizontal > vertical);
        if (swap) proto = variants[3 - layer]!;
    }
    return { proto, angle: rotation };
}

const HORIZONTAL: Record<string, string> = { E: "W", W: "E", NE: "NW", NW: "NE", SE: "SW", SW: "SE", Left: "Right", Right: "Left", East: "West", West: "East" };
const VERTICAL: Record<string, string> = { N: "S", S: "N", NE: "SE", SE: "NE", NW: "SW", SW: "NW", Top: "Bottom", Bottom: "Top", Up: "Down", Down: "Up", North: "South", South: "North" };
const DIRECTION = /Left|Right|Top|Bottom|Up|Down|North|South|East|West|[NS][EWew](?![a-z])|[NSEW](?![a-z])/g;

export function mirrorDecal(pack: Pack, props: DecalProps, flip: Flip): DecalProps {
    if (flip === "both") return { ...props, angle: mirrorAngle(props.angle, flip) };
    const names = flip === "horizontal" ? HORIZONTAL : VERTICAL;
    const proto = props.proto.replace(DIRECTION, (dir) => {
        if (dir.length !== 2) return names[dir] ?? dir;
        const mapped = names[dir.toUpperCase()];
        return mapped && /[a-z]$/.test(dir) ? mapped[0]! + mapped[1]!.toLowerCase() : mapped ?? dir;
    });
    if (proto !== props.proto && Object.hasOwn(pack.prototypes.decals, proto)) {
        return { ...props, proto, angle: -props.angle };
    }
    return { ...props, angle: mirrorAngle(props.angle, flip) };
}

export function decalSize(pack: Pack, proto: string): Point {
    const sprite = pack.prototypes.decals[proto]?.sprite;
    const frame = sprite && ("texture" in sprite ? pack.texture(sprite.texture) : pack.rsiFrame(sprite.rsi, sprite.state, 0));
    return frame ? [frame[3] / PPM, frame[4] / PPM] : [1, 1];
}
