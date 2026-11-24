// The start screen, shown while no map is open: the build, a new map, opening or dropping a map file, and the
// maps kept in this browser (one click opens one).
import { language, languages, t as translate } from "../i18n";
import { creditLink } from "./credit";
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
    about(): void;
    setLanguage(code: string): Promise<void>;
    /** Add a build (a link under the build list); absent without accounts. */
    addBuild?(): void;
}

/** Maps listed; the rest are in Manage library. */
const SHOWN = 10;

export class StartScreen {
    /** The header bar (the account control goes at its end). */
    readonly header: HTMLElement;
    private readonly fork: HTMLSelectElement;
    private readonly recent: HTMLElement;
    private readonly error: HTMLElement;
    private readonly status: HTMLElement;
    private forks: Fork[] = [];
    private readonly controls: Array<HTMLButtonElement | HTMLSelectElement>;

    constructor(readonly container: HTMLElement, private readonly hooks: StartHooks) {
        container.classList.add("start");
        const top = (this.header = container.querySelector<HTMLElement>(".st-top")!);
        top.replaceChildren();
        const locale = h("select", "st-language");
        locale.setAttribute("aria-label", translate("Language"));
        for (const { code, name } of languages) {
            const option = new Option(name, code);
            option.lang = code;
            locale.add(option);
        }
        locale.value = language();
        locale.addEventListener("change", async () => {
            await hooks.setLanguage(locale.value);
            locale.value = language();
        });
        top.append("SS14 Mapper", h("span", "st-grow"), locale);

        const aside = container.querySelector<HTMLElement>(".st-library")!;
        const build = h("label", "st-build");
        this.fork = h("select");
        this.fork.addEventListener("change", () => hooks.setFork(this.fork.value));
        build.append(h("span", "", translate("Build")), this.fork);
        if (hooks.addBuild) build.append(button("st-add", translate("Add a build…"), "", () => hooks.addBuild?.()));
        const drop = h("div", "st-drop");
        const open = button("st-open", translate("Open file…"), "", () => hooks.open());
        open.id = "start-open";
        const make = button("st-new", translate("New map…"), "", () => hooks.newMap());
        make.id = "start-new";
        const actions = h("div", "st-actions");
        actions.append(make, open);
        drop.append(icon(ICON.upload, 40), h("span", "", translate("Drop a .yml map here")), actions);
        // the page takes the drop itself; the zone only shows where it goes
        drop.addEventListener("dragenter", () => drop.classList.add("over"));
        drop.addEventListener("dragleave", (e) => {
            if (!drop.contains(e.relatedTarget as Node)) drop.classList.remove("over");
        });
        drop.addEventListener("drop", () => drop.classList.remove("over"));
        this.error = h("p", "st-error");
        this.status = container.querySelector<HTMLElement>("#start-status")!;
        this.status.removeAttribute("lang");
        this.status.textContent = translate("Loading editor and builds…");
        this.status.before(build, drop);
        this.status.after(this.error);
        this.controls = [this.fork, open, make];
        for (const control of this.controls) control.disabled = true;

        this.recent = h("div");
        this.recent.style.cssText = "display: flex; flex-direction: column; gap: 10px";
        const heads = h("div", "st-heads");
        heads.append(h("span", "st-head", translate("Recent")), button("st-link", translate("Manage…"), "", () => hooks.manage()));

        aside.append(heads, this.recent);
        const footer = h("footer", "st-footer");
        const about = button("st-link", translate("AI in development"), "", () => hooks.about());
        about.setAttribute("aria-haspopup", "dialog");
        footer.append(about, creditLink("site-credit"));
        container.append(footer);
    }

    setForks(forks: Fork[], current: string, error = ""): void {
        this.forks = forks;
        this.fork.replaceChildren(...forks.map((f) => new Option(f.name, f.id)));
        this.fork.value = current;
        for (const control of this.controls) control.disabled = forks.length === 0;
        this.status.textContent = forks.length ? "" : error || translate("No builds available. Try reloading the page.");
        this.status.hidden = forks.length > 0;
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
            this.recent.replaceChildren(h("div", "st-none", translate("No maps yet")));
            return;
        }
        const items = list.slice(0, SHOWN).map((m) => {
            const fork = this.forks.find((f) => f.id === m.build)?.name ?? m.build;
            const b = button("st-recent", h("span", "", m.name), translate("Open {{1}}", { 1: m.name }), () => this.hooks.reopen(m));
            b.append(h("span", "st-meta", `${fork} · ${formatWhen(m.savedAt)} · ${formatSize(m.size)}`));
            return b;
        });
        if (list.length > SHOWN) items.push(button("st-link", translate("All {{1}} maps…", { 1: list.length }), "", () => this.hooks.manage()));
        this.recent.replaceChildren(...items);
    }
}
