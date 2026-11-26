import { afterEach, describe, expect, it, vi } from "vitest";
import { bindFormLinks } from "../src/ui/form-links";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); });

function browser(path: string) {
    let url = new URL(path, "https://mapper.example.test");
    const events = new EventTarget();
    const state = { map: "kept" };
    const replaceState = vi.fn((_state: unknown, _title: string, next: string | URL) => {
        url = new URL(next); vi.stubGlobal("location", url);
    });
    vi.stubGlobal("window", events);
    vi.stubGlobal("location", url);
    vi.stubGlobal("history", { state, replaceState });
    return { state, replaceState, url: () => url, navigate: (hash: string) => {
        url.hash = hash; events.dispatchEvent(new Event("hashchange"));
    } };
}
function pending() {
    let close!: () => void;
    const opened = vi.fn(() => new Promise<void>(resolve => { close = resolve; }));
    return { opened, close: () => close() };
}

describe("links to forms", () => {
    it("retains the return fragment until close, preserving map parameters and history state", async () => {
        const page = browser("/ru/?open=map-id&fork=upstream#feedback"), form = pending();
        stop = bindFormLinks(new Map([["feedback", form.opened]]), vi.fn());
        expect(form.opened).toHaveBeenCalledOnce();
        expect(page.url().hash).toBe("#feedback");
        form.close();
        await vi.waitFor(() => expect(page.url().hash).toBe(""));
        expect(page.url().pathname + page.url().search).toBe("/ru/?open=map-id&fork=upstream");
        expect(page.replaceState.mock.calls[0]?.[0]).toBe(page.state);
    });

    it("leaves unknown anchors alone", () => {
        const page = browser("/#constructor"), form = pending();
        stop = bindFormLinks(new Map([["settings", form.opened]]), vi.fn());
        expect(form.opened).not.toHaveBeenCalled();
        expect(page.url().hash).toBe("#constructor");
        page.navigate("#guide-section");
        expect(page.replaceState).not.toHaveBeenCalled();
    });

    it("does not stack forms and opens the latest requested one after closing", async () => {
        const page = browser("/#feedback"), feedback = pending(), settings = pending(), library = pending();
        stop = bindFormLinks(new Map([["feedback", feedback.opened], ["settings", settings.opened], ["library", library.opened]]), vi.fn());
        page.navigate("#settings"); page.navigate("#library");
        expect(settings.opened).not.toHaveBeenCalled(); expect(library.opened).not.toHaveBeenCalled();
        feedback.close();
        await vi.waitFor(() => expect(library.opened).toHaveBeenCalledOnce());
        expect(settings.opened).not.toHaveBeenCalled(); expect(page.url().hash).toBe("#library");
        library.close(); await vi.waitFor(() => expect(page.url().hash).toBe(""));
    });

    it("does not erase an unrelated anchor selected while a form is open", async () => {
        const page = browser("/#settings"), form = pending();
        stop = bindFormLinks(new Map([["settings", form.opened]]), vi.fn());
        page.navigate("#notes"); form.close();
        await Promise.resolve();
        expect(page.url().hash).toBe("#notes"); expect(page.replaceState).not.toHaveBeenCalled();
    });

    it("reports an error and can open a different form afterwards", async () => {
        const page = browser("/#feedback"), error = new Error("Unavailable"), onError = vi.fn(), next = pending();
        stop = bindFormLinks(new Map([["feedback", () => Promise.reject(error)], ["settings", next.opened]]), onError);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
        expect(page.url().hash).toBe("");
        page.navigate("#settings"); expect(next.opened).toHaveBeenCalledOnce(); next.close();
    });

    it("ignores duplicate navigation events while waiting for a form", async () => {
        const page = browser("/#settings"), form = pending();
        stop = bindFormLinks(new Map([["settings", form.opened]]), vi.fn());
        page.navigate("#settings"); page.navigate("#settings");
        expect(form.opened).toHaveBeenCalledOnce(); form.close();
        await vi.waitFor(() => expect(page.url().hash).toBe(""));
        page.navigate("#settings"); expect(form.opened).toHaveBeenCalledTimes(2); form.close();
    });

    it("stops processing navigation and leaves the URL intact after disposal", async () => {
        const page = browser("/#settings"), form = pending();
        stop = bindFormLinks(new Map([["settings", form.opened]]), vi.fn());
        stop(); form.close(); await Promise.resolve();
        expect(page.replaceState).not.toHaveBeenCalled();
        page.navigate("#settings"); expect(form.opened).toHaveBeenCalledOnce();
    });
});
