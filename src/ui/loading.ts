// The loading screen shown while a map is read, its build loaded and the map drawn: big stations take a few seconds.
import { h } from "./icons";

const STYLE = `
.loading { position: fixed; inset: 0; z-index: 1500; display: flex; align-items: center; justify-content: center; background: rgba(11, 13, 16, 0.82); }
.loading[hidden] { display: none; }
.loading .ld-box { display: flex; align-items: center; gap: 14px; min-width: 260px; max-width: min(440px, calc(100vw - 32px)); box-sizing: border-box; padding: 16px 20px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-l); box-shadow: var(--shadow); font: 13px/1.4 var(--font); color: var(--text); }
.loading .ld-tiles { flex: none; display: grid; grid-template-columns: repeat(2, 8px); gap: 3px; }
.loading .ld-tiles span { width: 8px; height: 8px; background: var(--accent-text); }
.loading .ld-tiles span:nth-child(2) { animation-delay: 0.15s; }
.loading .ld-tiles span:nth-child(3) { animation-delay: 0.3s; }
.loading .ld-tiles span:nth-child(4) { animation-delay: 0.45s; }
.loading .ld-text { min-width: 0; display: flex; flex-direction: column; }
.loading .ld-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.loading .ld-step { color: var(--muted); }
@media (prefers-reduced-motion: no-preference) {
  .loading .ld-tiles span { animation: ld-tile 1.2s ease-in-out infinite alternate; }
}
@keyframes ld-tile { from { opacity: 0.3; } to { opacity: 1; } }
`;

export class Loading {
    private readonly root: HTMLElement;
    private readonly name: HTMLElement;
    private readonly stepText: HTMLElement;

    constructor() {
        const style = document.createElement("style");
        style.textContent = STYLE;
        document.head.append(style);
        this.root = h("div", "loading");
        this.root.hidden = true;
        this.root.setAttribute("role", "status");
        this.root.setAttribute("aria-live", "polite");
        const box = h("div", "ld-box");
        const text = h("div", "ld-text");
        this.name = h("span", "ld-name");
        this.stepText = h("span", "ld-step");
        text.append(this.name, this.stepText);
        const tiles = h("span", "ld-tiles");
        tiles.setAttribute("aria-hidden", "true");
        tiles.append(...Array.from({ length: 4 }, () => h("span")));
        box.append(tiles, text);
        this.root.append(box);
        document.body.append(this.root);
    }

    get shown(): boolean {
        return !this.root.hidden;
    }

    /** Shows the screen for a map and lets the browser paint it before the work that follows. */
    show(name: string, step: string): Promise<void> {
        this.name.textContent = name;
        return this.step(step);
    }

    /** The current step; resolves once it is on screen. */
    step(text: string): Promise<void> {
        this.stepText.textContent = text;
        this.root.hidden = false;
        // two frames: the first lays out, the second has painted
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }

    hide(): void {
        this.root.hidden = true;
    }
}
