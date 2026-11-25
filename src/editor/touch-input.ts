import type { View } from "../render/canvas";

type Point = { x: number; y: number };

/** Keep the world point under the fingers fixed while translating and scaling. */
export function touchView(view: View, start: Point, end: Point, ratio: number): View {
    const scale = Math.min(8, Math.max(0.02, view.scale * ratio));
    const factor = scale / view.scale;
    return { scale, x: end.x - (start.x - view.x) * factor, y: end.y - (start.y - view.y) * factor };
}

interface TouchHooks {
    view(): View;
    setView(view: View): void;
    navigating(): boolean;
    down(event: PointerEvent): void;
    move(event: PointerEvent): void;
    up(event: PointerEvent): void;
    cancel(): void;
    menu(event: PointerEvent): void;
}

/** Touch arbitration: a second finger cancels the pending edit and starts navigation. */
export class TouchInput {
    private readonly points = new Map<number, Point>();
    private pending: PointerEvent | null = null;
    private editing = false;
    private navigation = false;
    private consumed = false;
    private timer = 0;
    private start: { center: Point; distance: number; view: View } | null = null;

    constructor(private readonly canvas: HTMLCanvasElement, private readonly hooks: TouchHooks) {}

    private point(e: PointerEvent): Point {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    private geometry(): { center: Point; distance: number } {
        const [a, b = a] = [...this.points.values()] as [Point, Point?];
        return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)) };
    }

    down(e: PointerEvent): boolean {
        if (e.pointerType !== "touch") return false;
        this.canvas.setPointerCapture(e.pointerId);
        this.points.set(e.pointerId, this.point(e));
        clearTimeout(this.timer);
        if (this.points.size > 1 || this.hooks.navigating()) {
            if (this.editing) this.hooks.cancel();
            this.editing = false;
            this.pending = null;
            this.navigation = true;
            this.start = { ...this.geometry(), view: { ...this.hooks.view() } };
        } else if (!this.consumed) {
            this.pending = e;
            this.timer = window.setTimeout(() => {
                if (!this.pending || this.navigation) return;
                const press = this.pending;
                this.pending = null;
                this.consumed = true;
                this.hooks.menu(press);
            }, 550);
        }
        return true;
    }

    move(e: PointerEvent): boolean {
        if (e.pointerType !== "touch") return false;
        if (!this.points.has(e.pointerId)) return true;
        this.points.set(e.pointerId, this.point(e));
        if (this.navigation && this.start) {
            const now = this.geometry();
            this.hooks.setView(touchView(this.start.view, this.start.center, now.center, this.points.size > 1 ? now.distance / this.start.distance : 1));
        } else if (!this.consumed) {
            if (this.pending && Math.hypot(e.clientX - this.pending.clientX, e.clientY - this.pending.clientY) >= 8) {
                clearTimeout(this.timer);
                this.hooks.down(this.pending);
                this.pending = null;
                this.editing = true;
            }
            if (this.editing) this.hooks.move(e);
        }
        return true;
    }

    up(e: PointerEvent, cancelled = false): boolean {
        if (e.pointerType !== "touch") return false;
        clearTimeout(this.timer);
        if (!this.points.has(e.pointerId)) return true;
        if (cancelled) {
            if (this.editing) this.hooks.cancel();
            this.pending = null;
            this.editing = false;
            this.consumed = true;
        } else if (!this.navigation && !this.consumed) {
            if (this.pending) this.hooks.down(this.pending);
            this.hooks.up(e);
            this.pending = null;
            this.editing = false;
        }
        this.points.delete(e.pointerId);
        if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
        if (!this.points.size) {
            this.navigation = this.consumed = false;
            this.start = null;
        } else if (this.navigation) {
            // The remaining finger can keep moving, but cannot resume painting.
            this.start = { ...this.geometry(), view: { ...this.hooks.view() } };
        }
        return true;
    }
}
