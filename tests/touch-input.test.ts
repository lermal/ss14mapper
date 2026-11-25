import { afterEach, describe, expect, it, vi } from "vitest";
import { TouchInput, touchView } from "../src/editor/touch-input";

const event = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: "touch", clientX: x, clientY: y, preventDefault: vi.fn() }) as unknown as PointerEvent;
function setup(navigating = false) {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    let view = { x: 10, y: 20, scale: 1 };
    const hooks = { view: () => view, setView: vi.fn(v => { view = v; }), navigating: () => navigating, down: vi.fn(), move: vi.fn(), up: vi.fn(), cancel: vi.fn(), menu: vi.fn() };
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() } as unknown as HTMLCanvasElement;
    return { input: new TouchInput(canvas, hooks), hooks };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("touch editing and navigation", () => {
    it("defers a tap, then sends one edit on release", () => {
        const { input, hooks } = setup();
        input.down(event(1, 30, 40));
        expect(hooks.down).not.toHaveBeenCalled();
        input.up(event(1, 30, 40));
        expect(hooks.down).toHaveBeenCalledTimes(1);
        expect(hooks.up).toHaveBeenCalledTimes(1);
    });
    it("two fingers never commit a pending edit or resume editing after one lifts", () => {
        const { input, hooks } = setup();
        input.down(event(1, 30, 40)); input.down(event(2, 60, 40));
        input.move(event(2, 90, 40));
        expect(hooks.view().scale).toBe(2);
        input.up(event(2, 90, 40)); input.move(event(1, 60, 40)); input.up(event(1, 60, 40));
        expect(hooks.down).not.toHaveBeenCalled(); expect(hooks.up).not.toHaveBeenCalled();
    });
    it("cancels a brush stroke when the second finger lands", () => {
        const { input, hooks } = setup();
        input.down(event(1, 30, 40)); input.move(event(1, 50, 40));
        expect(hooks.down).toHaveBeenCalledTimes(1);
        input.down(event(2, 80, 40));
        expect(hooks.cancel).toHaveBeenCalledTimes(1);
        input.up(event(1, 50, 40)); input.up(event(2, 80, 40));
        expect(hooks.up).not.toHaveBeenCalled();
    });
    it("long press opens a picker without placing anything", () => {
        const { input, hooks } = setup();
        input.down(event(1, 30, 40)); vi.advanceTimersByTime(550); input.up(event(1, 30, 40));
        expect(hooks.menu).toHaveBeenCalledTimes(1); expect(hooks.down).not.toHaveBeenCalled();
    });
    it("cancellation discards the pending tap and running stroke", () => {
        const { input, hooks } = setup();
        input.down(event(1, 30, 40)); input.up(event(1, 30, 40), true);
        expect(hooks.down).not.toHaveBeenCalled();
        input.down(event(2, 30, 40)); input.move(event(2, 60, 40)); input.up(event(2, 60, 40), true);
        expect(hooks.cancel).toHaveBeenCalledTimes(1); expect(hooks.up).not.toHaveBeenCalled();
    });
    it("one-finger navigation pans without editing", () => {
        const { input, hooks } = setup(true);
        input.down(event(1, 30, 40)); input.move(event(1, 70, 80)); input.up(event(1, 70, 80));
        expect(hooks.view()).toEqual({ x: 50, y: 60, scale: 1 }); expect(hooks.down).not.toHaveBeenCalled();
    });
    it("keeps the pinch anchor stable at zoom limits", () => {
        expect(touchView({ x: 10, y: 20, scale: 4 }, { x: 50, y: 60 }, { x: 60, y: 80 }, 10)).toEqual({ x: -20, y: 0, scale: 8 });
    });
});
