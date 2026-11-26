// The start screen, shown while no map is open: the build, a new map, opening or dropping a map file, and the
// maps kept in this browser (one click opens one).
import { language, languages, t as translate } from "../i18n";
import { button, h } from "./icons";
import { formatSize, formatWhen, type LibraryEntry } from "./library";
import type { Fork } from "./shell";

export interface StartHooks {
    setFork(id: string): void;
    open(): void;
    newMap(): void;
    reopen(m: LibraryEntry): void;
    manage(): void;
    shortcuts(): void;
    about(): void;
    setLanguage(code: string): Promise<void>;
    /** Add a build (a link under the build list); absent without accounts. */
    addBuild?(): void;
}

/** Maps listed; the rest are in Manage library. */
const SHOWN = 10;

export class StartScreen {
    /** Reserved account slot in the start header. */
    readonly header: HTMLElement;
    private readonly fork: HTMLSelectElement;
    private readonly recent: HTMLElement;
    private readonly error: HTMLElement;
    private readonly status: HTMLElement;
    private forks: Fork[] = [];
    private readonly controls: Array<HTMLButtonElement | HTMLSelectElement>;

    constructor(readonly container: HTMLElement, private readonly hooks: StartHooks) {
        container.classList.add("start");
        for (const el of container.querySelectorAll<HTMLElement>("[data-i18n]")) {
            el.textContent = translate(el.dataset.i18n!);
        }
        container.querySelector<HTMLElement>(".st-intro")!.lang = language();
        container.querySelector<HTMLAnchorElement>("#start-guide")!.href = language() === "ru" ? "/guide/ru/" : "/guide/";
        this.header = container.querySelector<HTMLElement>(".st-account-slot")!;
        const locale = container.querySelector<HTMLSelectElement>(".st-language")!;
        locale.setAttribute("aria-label", translate("Language"));
        locale.replaceChildren(...languages.map(({ code, name }) => {
            const option = new Option(name, code);
            option.lang = code;
            return option;
        }));
        locale.value = language();
        locale.disabled = false;
        locale.addEventListener("change", async () => {
            await hooks.setLanguage(locale.value);
            locale.value = language();
        });

        const action = (selector: string, run: () => void) => {
            const control = container.querySelector<HTMLButtonElement>(selector)!;
            control.disabled = false;
            control.addEventListener("click", run);
            control.addEventListener("mouseup", () => control.blur());
            return control;
        };
        this.fork = container.querySelector<HTMLSelectElement>("#start-build")!;
        this.fork.addEventListener("change", () => hooks.setFork(this.fork.value));
        const add = container.querySelector<HTMLButtonElement>(".st-add")!;
        if (hooks.addBuild) action(".st-add", () => hooks.addBuild?.());
        else add.style.visibility = "hidden";
        const drop = container.querySelector<HTMLElement>(".st-drop")!;
        const open = action("#start-open", () => hooks.open());
        const make = action("#start-new", () => hooks.newMap());
        // the page takes the drop itself; the zone only shows where it goes
        drop.addEventListener("dragenter", () => drop.classList.add("over"));
        drop.addEventListener("dragleave", (e) => {
            if (!drop.contains(e.relatedTarget as Node)) drop.classList.remove("over");
        });
        drop.addEventListener("drop", () => drop.classList.remove("over"));
        this.error = container.querySelector<HTMLElement>(".st-error")!;
        this.status = container.querySelector<HTMLElement>("#start-status")!;
        this.controls = [this.fork, open, make];
        for (const control of this.controls) control.disabled = true;
        this.recent = container.querySelector<HTMLElement>(".st-recents")!;
        action("#start-manage", () => hooks.manage());
        action("#start-shortcuts", () => hooks.shortcuts());
        action("#start-about", () => hooks.about());
    }

    setForks(forks: Fork[], current: string, error = ""): void {
        this.forks = forks;
        this.fork.replaceChildren(...forks.map((f) => new Option(f.name, f.id)));
        this.fork.value = current;
        for (const control of this.controls) control.disabled = forks.length === 0;
        this.status.textContent = forks.length ? translate("Drop a .yml map here") : error || translate("No builds available. Try reloading the page.");
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
        this.recent.setAttribute("aria-busy", "false");
        if (!list.length) {
            const empty = h("div", "st-none");
            empty.append(h("p", "st-empty-title", translate("No maps yet")), h("p", "", translate("Open or create a map, then save it to keep it here.")));
            this.recent.replaceChildren(empty);
            return;
        }
        const items = list.slice(0, SHOWN).map((m) => {
            const fork = this.forks.find((f) => f.id === m.build)?.name ?? m.build;
            const b = button("st-recent", h("span", "", m.name), translate("Open {{1}}", { 1: m.name }), () => this.hooks.reopen(m));
            const meta = h("span", "st-meta");
            meta.append(h("span", "", fork), h("span", "", formatWhen(m.savedAt)), h("span", "", formatSize(m.size)));
            b.append(meta);
            return b;
        });
        if (list.length > SHOWN) items.push(button("st-link", translate("All {{1}} maps…", { 1: list.length }), "", () => this.hooks.manage()));
        this.recent.replaceChildren(...items);
    }
}
