import { describe, expect, it } from "vitest";
import type { ParallaxLayer } from "../src/pack/format";
import { advanceClock, animateDefault, hasScrolling, layerOrigin, scrolled, shouldAnimate } from "../src/render/parallax-math";

function layer(over: Partial<ParallaxLayer>): ParallaxLayer {
    return {
        texture: { kind: "image", path: "/Textures/x.png" },
        file: null,
        size: [320, 320],
        scale: [1, 1],
        tiled: true,
        slowness: 0.5,
        scrolling: [0, 0],
        worldHomePosition: [0, 0],
        worldAdjustPosition: [0, 0],
        controlHomePosition: [0, 0],
        shader: "unshaded",
        ...over,
    };
}

describe("scrolling offset", () => {
    it("is scrolling times time, as the game computes it", () => {
        expect(scrolled(layer({ scrolling: [0.5, -2] }), 0, 4)).toBe(2);
        expect(layerOrigin(layer({ scrolling: [1, 0] }), [0, 0], 3)[0]).toBeCloseTo(3 - 5, 10);
    });
    it("stays inside one tile for a tiled layer", () => {
        const l = layer({ scrolling: [3, -3] }); // tile is 10 world units
        expect(scrolled(l, 0, 100)).toBeCloseTo(0, 9);
        expect(scrolled(l, 0, 4)).toBeCloseTo(2, 9);
        expect(scrolled(l, 1, 4)).toBeCloseTo(8, 9);
        expect(scrolled(l, 0, 1e7)).toBeLessThan(10);
        expect(layerOrigin(l, [0, 0], 4)[0]).toBeCloseTo(layerOrigin(l, [0, 0], 4 + 10 / 3)[0], 6);
    });
    it("leaves an untiled layer unwrapped", () => {
        expect(scrolled(layer({ tiled: false, scrolling: [3, 0] }), 0, 100)).toBe(300);
    });
});

describe("animation conditions", () => {
    it("detects scrolling layers", () => {
        expect(hasScrolling([layer({}), layer({})])).toBe(false);
        expect(hasScrolling([layer({}), layer({ scrolling: [0, 0.1] })])).toBe(true);
    });
    it("runs only when everything allows it", () => {
        const on = { enabled: true, animate: true, scrolling: true, visible: true };
        expect(shouldAnimate(on)).toBe(true);
        expect(shouldAnimate({ ...on, enabled: false })).toBe(false);
        expect(shouldAnimate({ ...on, animate: false })).toBe(false);
        expect(shouldAnimate({ ...on, scrolling: false })).toBe(false);
        expect(shouldAnimate({ ...on, visible: false })).toBe(false);
    });
    it("defaults on, off for reduced motion unless chosen", () => {
        expect(animateDefault(null, false)).toBe(true);
        expect(animateDefault(null, true)).toBe(false);
        expect(animateDefault("1", true)).toBe(true);
        expect(animateDefault("0", false)).toBe(false);
    });
});

describe("clock", () => {
    it("advances by the frame gap and holds still on resume", () => {
        expect(advanceClock(5, null, 1000)).toBe(5);
        expect(advanceClock(5, 1000, 1016)).toBeCloseTo(5.016, 9);
        expect(advanceClock(5, 1000, 60000)).toBe(5.25);
        expect(advanceClock(5, 1000, 900)).toBe(5);
    });
});
