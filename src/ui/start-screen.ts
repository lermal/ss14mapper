// The start screen, shown while no map is open: the build, a new map, opening or dropping a map file, and the
// maps kept in this browser (one click opens one).
import { button, h, icon, ICON } from "./icons";
import { formatSize, formatWhen, type LibraryEntry } from "./library";
import type { Fork } from "./shell";

export interface StartHooks {
    setFork(id: string): void;
    open(): void;
    newMap(): void;
    reopen(m: LibraryEntry): void;
    manage(): void;
    shortcuts(): void;
    /** Add a build (a link under the build list); absent without accounts. */
    addBuild?(): void;
}

/** Maps listed; the rest are in Manage library. */
const SHOWN = 10;

const STYLE = `
.start { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.4; }
.start .st-top { display: flex; align-items: center; gap: 8px; height: 44px; flex: none; padding: 0 14px; box-sizing: border-box; background: var(--panel); border-bottom: 1px solid var(--border); font-weight: 600; }
.start .st-top svg { color: var(--focus); }
.start .st-top .st-grow { flex: 1; }
.start .st-link { border: 0; background: transparent; color: var(--accent-text); font-size: 13px; font-weight: 400; padding: 4px; }
.start .st-link:hover { color: #b8d0ff; }
.start main { flex: 1; display: flex; justify-content: center; align-items: flex-start; padding: 72px 24px; overflow-y: auto; }
.start .st-cols { width: 100%; max-width: 920px; display: flex; flex-wrap: wrap; gap: 24px; }
.start .st-main { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 20px; }
.start h1 { margin: 0 0 6px; font-size: 28px; font-weight: 600; }
.start .st-lead { margin: 0; color: var(--muted); }
.start .st-build { display: flex; flex-direction: column; gap: 6px; }
.start .st-build span { color: var(--muted); font-size: 13px; }
.start .st-build select { height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--raised); color: var(--text); font: inherit; }
.start .st-add { align-self: flex-start; margin-top: 2px; padding: 0; border: 0; background: none; color: var(--accent-text); font: inherit; font-size: 13px; cursor: pointer; }
.start .st-add:hover { text-decoration: underline; }
.start .st-drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; height: 240px; border: 2px dashed var(--border-strong); border-radius: 12px; background: var(--panel-2); }
.start .st-drop.over { border-color: var(--accent); background: var(--accent-soft); }
.start .st-drop svg { color: #6f7a8b; }
.start .st-drop > span { color: var(--text-2); }
.start .st-open { height: 36px; padding: 0 18px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; }
.start .st-open:hover { filter: brightness(1.12); }
.start .st-actions { display: flex; gap: 10px; }
.start .st-new { height: 36px; padding: 0 18px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--raised); color: var(--text); font-weight: 600; }
.start .st-new:hover { border-color: var(--accent); }
.start .st-note { margin: 0; color: var(--muted); font-size: 12px; }
.start .st-heads { display: flex; align-items: baseline; }
.start .st-heads .st-link { margin-left: auto; font-size: 12px; }
.start .st-error { color: var(--danger-text); min-height: 1.4em; margin: 0; }
.start aside { flex: 1 1 280px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.start .st-head { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
.start .st-recent { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--text); text-align: left; }
.start .st-recent:hover { border-color: var(--border-strong); background: var(--raised); }
.start .st-recent .st-meta { color: var(--muted); font-size: 12px; }
.start .st-none { padding: 12px; border: 1px dashed var(--border-strong); border-radius: 8px; color: var(--muted); font-size: 13px; }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

export class StartScreen {
    /** The header bar (the account control goes at its end). */
    readonly header: HTMLElement;
    private readonly fork: HTMLSelectElement;
    private readonly recent: HTMLElement;
    private readonly error: HTMLElement;
    private forks: Fork[] = [];

    constructor(readonly container: HTMLElement, private readonly hooks: StartHooks) {
        addStyle();
        container.classList.add("start");
        const top = (this.header = h("header", "st-top"));
        top.append("SS14 Mapper");

        const main = h("main");
        const cols = h("div", "st-cols");
        const left = h("div", "st-main");
        const build = h("label", "st-build");
        this.fork = h("select");
        this.fork.addEventListener("change", () => hooks.setFork(this.fork.value));
        build.append(h("span", "", "Build"), this.fork);
        if (hooks.addBuild) build.append(button("st-add", "Add a build…", "", () => hooks.addBuild?.()));
        const drop = h("div", "st-drop");
        const open = button("st-open", "Open file…", "", () => hooks.open());
        open.id = "start-open";
        const make = button("st-new", "New map…", "", () => hooks.newMap());
        make.id = "start-new";
        const actions = h("div", "st-actions");
        actions.append(make, open);
        drop.append(icon(ICON.upload, 40), h("span", "", "Drop a .yml map here"), actions);
        // the page takes the drop itself; the zone only shows where it goes
        drop.addEventListener("dragenter", () => drop.classList.add("over"));
        drop.addEventListener("dragleave", (e) => {
            if (!drop.contains(e.relatedTarget as Node)) drop.classList.remove("over");
        });
        drop.addEventListener("drop", () => drop.classList.remove("over"));
        this.error = h("p", "st-error");
        left.append(build, drop, this.error);

        const aside = h("aside");
        this.recent = h("div");
        this.recent.style.cssText = "display: flex; flex-direction: column; gap: 10px";
        const heads = h("div", "st-heads");
        heads.append(h("span", "st-head", "Recent"), button("st-link", "Manage…", "", () => hooks.manage()));
        
        aside.append(heads, this.recent);
        cols.append(left, aside);
        main.append(cols);
        container.append(top, main);
    }

    setForks(forks: Fork[], current: string): void {
        this.forks = forks;
        this.fork.replaceChildren(...forks.map((f) => new Option(f.name, f.id)));
        this.fork.value = current;
    }

    setFork(id: string): void {
        this.fork.value = id;
    }

    /** Shows why a map did not open (empty clears it). */
    setError(message: string): void {
        this.error.textContent = message;
    }

    /** Lists the maps of the library, most recently used first. */
    setRecent(list: LibraryEntry[]): void {
        if (!list.length) {
            this.recent.replaceChildren(h("div", "st-none", "No maps yet"));
            return;
        }
        const items = list.slice(0, SHOWN).map((m) => {
            const fork = this.forks.find((f) => f.id === m.build)?.name ?? m.build;
            const b = button("st-recent", h("span", "", m.name), `Open ${m.name}`, () => this.hooks.reopen(m));
            b.append(h("span", "st-meta", `${fork} · ${formatWhen(m.savedAt)} · ${formatSize(m.size)}`));
            return b;
        });
        if (list.length > SHOWN) items.push(button("st-link", `All ${list.length} maps…`, "", () => this.hooks.manage()));
        this.recent.replaceChildren(...items);
    }
}
