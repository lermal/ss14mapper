// The account in the headers of the start screen and the editor: Sign in with GitHub, or the user's menu (Your
// builds, Add a build, Manage builds for the maintainer, Sign out), and the dialogs behind it.
import { adminMeta, BUG_TABS, bugMeta, MANAGE_TABS, myBuildMeta, SLUG_PATTERN, stateLabel, type StateLabel } from "../api/builds";
import { ApiError, type AdminFork, type Api, type BugReport, type BugReportInput, type BugStatus, type ForkStatus, type Me, type MyFork } from "../api/client";
import { dialog } from "./dialog";
import { button, h, icon, ICON } from "./icons";
import { popupMenu, type MenuItem } from "./menus";
import { showToast } from "./toast";

const STYLE = `
.tb-account { display: flex; align-items: center; margin-left: auto; font-weight: 400; }
.st-top .tb-account svg { color: currentColor; }
.tb-signin { height: 30px; display: inline-flex; align-items: center; gap: 7px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); color: var(--text); }
.tb-signin:hover { border-color: var(--border-strong); }
.tb-user { height: 30px; display: inline-flex; align-items: center; gap: 7px; padding: 0 8px 0 4px; border: 0; border-radius: var(--radius); background: transparent; color: var(--text); }
.tb-user:hover, .tb-user[aria-expanded="true"] { background: var(--raised); }
.tb-avatar { width: 22px; height: 22px; flex: none; border-radius: 50%; background: #3b4a5e; color: #cfd8e3; display: grid; place-items: center; font-size: 11px; font-weight: 600; object-fit: cover; }
.dlg .fb-hint { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
.dlg .fb-error { margin: 10px 0 0; padding: 8px 10px; border: 1px solid var(--danger-border); border-radius: var(--radius-s); background: var(--danger-bg); color: var(--danger-text); font-size: 12px; }
.dlg .fb-list { display: flex; flex-direction: column; gap: 6px; max-height: 56vh; overflow-y: auto; margin-top: 8px; }
.dlg .fb-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel-2); }
.dlg .fb-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dlg .fb-name { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dlg .fb-meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.dlg .fb-meta a { color: inherit; }
.dlg .fb-reason { color: var(--danger-text); font-size: 12px; }
.dlg .fb-state { flex: none; padding: 1px 7px; border-radius: var(--radius-s); font-size: 11px; font-weight: 600; background: var(--raised); color: var(--muted); }
.dlg .fb-state.ready { background: var(--accent-soft); color: var(--accent-text); }
.dlg .fb-state.failed { background: var(--danger-bg); color: var(--danger-text); }
.dlg .fb-state.wait { color: var(--warn); }
.dlg .fb-row button.btn { height: 26px; padding: 0 10px; }
.dlg .fb-tabs { display: flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; align-self: flex-start; margin-top: 4px; width: max-content; }
.dlg .fb-tabs button { height: 26px; padding: 0 12px; border: 0; background: var(--raised); color: var(--text); }
.dlg .fb-tabs button + button { border-left: 1px solid var(--border); }
.dlg .fb-tabs button[aria-pressed="true"] { background: var(--accent-soft); font-weight: 600; }
.dlg .fb-tabs .n { margin-left: 5px; color: var(--muted); font-weight: 400; }
.dlg .fb-approve { display: flex; gap: 8px; align-items: flex-end; flex: 1; min-width: 0; }
.dlg .fb-approve .dlg-field { margin: 0; flex: 1; min-width: 0; }
.dlg .fb-approve .dlg-field.id { flex: 0 0 120px; }
.dlg .fb-approve input:disabled { color: var(--muted); }
.dlg .fb-note { margin-top: 10px; color: var(--muted); font-size: 12px; }
.dlg textarea { min-height: 120px; resize: vertical; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--input); color: var(--text); font: 13px/1.4 var(--font); }
.dlg .fb-check { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--text-2); font-size: 13px; }
.dlg .fb-desc { color: var(--text-2); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.dlg .fb-row.top { align-items: flex-start; }
.dlg .fb-empty { padding: 14px; border: 1px dashed var(--border-strong); border-radius: var(--radius); color: var(--muted); }
`;

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

export interface AccountHooks {
    /** Before the page leaves to sign in (unsaved changes); false stays. */
    beforeSignIn(): Promise<boolean>;
    signedIn(me: Me): void;
    signedOut(): void;
    /** After Manage builds closes: the public build list may have changed. */
    buildsChanged(): void;
    /** What a bug report carries from the editor: the current build and the open map (null when none). */
    bugContext(): { build: string; buildName(id: string): string; mapName: string | null; mapText(): string | null };
}

/** The attached map's size limit (the API's). */
const MAX_MAP = 20 * 1024 * 1024;

function field(label: string, control: HTMLElement, cls = ""): HTMLElement {
    const l = h("label", `dlg-field${cls ? ` ${cls}` : ""}`);
    l.append(label, control);
    return l;
}

function textInput(value = "", placeholder = ""): HTMLInputElement {
    const i = h("input");
    i.type = "text";
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.autocomplete = "off";
    return i;
}

function badge(s: StateLabel): HTMLElement {
    return h("span", `fb-state${s.tone ? ` ${s.tone}` : ""}`, s.label);
}

function rowText(name: string, meta: string, reason?: string | null): HTMLElement {
    const t = h("div", "fb-text");
    const n = h("span", "fb-name", name);
    n.title = name;
    t.append(n, h("span", "fb-meta", meta));
    if (reason) t.append(h("span", "fb-reason", reason));
    return t;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Account {
    /** The signed-in user; null when signed out or not known yet. */
    me: Me | null = null;
    /** The first answer about the account has come (until then the headers show nothing). */
    private known = false;
    private readonly boxes: HTMLElement[] = [];
    readonly ready: Promise<void>;
    private resolveReady: () => void = () => {};

    constructor(
        private readonly api: Api,
        private readonly hooks: AccountHooks,
    ) {
        addStyle();
        this.ready = new Promise((r) => (this.resolveReady = r));
    }

    /** Adds the account control to the end of a header. */
    mount(header: HTMLElement): void {
        const box = h("div", "tb-account");
        this.boxes.push(box);
        header.append(box);
        this.render();
    }

    /** Asks the API who is signed in (in the background: nothing waits for it). */
    async load(): Promise<void> {
        try {
            this.me = await this.api.me();
        } catch (e) {
            // the API is down: offer to sign in, the sign-in page says the rest
            console.warn(`Could not read the account: ${messageOf(e)}`);
            this.me = null;
        }
        this.known = true;
        this.render();
        this.resolveReady();
        if (this.me) this.hooks.signedIn(this.me);
    }

    private render(): void {
        for (const box of this.boxes) {
            if (!this.known) {
                box.replaceChildren();
                continue;
            }
            if (!this.me) {
                const b = button("tb-signin", icon(ICON.github, 16), "", () => void this.signIn());
                b.append(h("span", "", "Sign in"));
                box.replaceChildren(b);
                continue;
            }
            box.replaceChildren(this.userButton(this.me));
        }
    }

    private userButton(me: Me): HTMLButtonElement {
        const b = h("button", "tb-user");
        b.type = "button";
        b.setAttribute("aria-haspopup", "menu");
        b.setAttribute("aria-expanded", "false");
        b.title = `Signed in as ${me.login}`;
        const letter = () => h("span", "tb-avatar", me.login.slice(0, 1).toUpperCase());
        if (me.avatar) {
            const img = h("img", "tb-avatar");
            img.alt = "";
            img.width = img.height = 22;
            img.referrerPolicy = "no-referrer";
            img.src = me.avatar + (me.avatar.includes("?") ? "&" : "?") + "s=44";
            img.addEventListener("error", () => img.replaceWith(letter()), { once: true });
            b.append(img);
        } else b.append(letter());
        b.append(h("span", "", me.login));
        let open = false;
        const show = () => {
            const r = b.getBoundingClientRect();
            const popup = popupMenu(this.menuItems(me), r.right, r.bottom + 4, (t) => b.contains(t), true);
            open = true;
            b.setAttribute("aria-expanded", "true");
            const before = popup.onClose;
            popup.onClose = () => {
                before?.();
                open = false;
                b.setAttribute("aria-expanded", "false");
            };
            return popup;
        };
        let popup: ReturnType<typeof popupMenu> | null = null;
        b.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            if (open) popup?.close();
            else popup = show();
        });
        b.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
                e.preventDefault();
                e.stopPropagation();
                if (!open) popup = show();
            }
        });
        return b;
    }

    private menuItems(me: Me): MenuItem[] {
        const items: MenuItem[] = [
            { label: "Your builds…", run: () => void this.yourBuilds() },
            { label: "Add a build…", run: () => void this.addBuild() },
            { label: "Report a bug…", run: () => void this.reportBug() },
        ];
        if (me.maintainer) {
            const n = me.pending ?? 0;
            items.push({ label: "Manage builds…", ...(n > 0 ? { note: `${n} waiting for approval` } : {}), run: () => void this.manageBuilds() });
            const bugs = me.bugs ?? 0;
            items.push({ label: "Bug reports…", ...(bugs > 0 ? { note: `${bugs} new` } : {}), run: () => void this.bugReports() });
        }
        items.push("-", { label: "Sign out", run: () => void this.signOut() });
        return items;
    }

    /** Leaves for GitHub's sign-in; the API brings the browser back to this page. */
    async signIn(): Promise<void> {
        if (!(await this.hooks.beforeSignIn())) return;
        location.assign(this.api.signInUrl(location.href));
    }

    async signOut(): Promise<void> {
        try {
            await this.api.logout();
        } catch (e) {
            // already signed out on the server: the same as success here
            if (!(e instanceof ApiError && e.status === 401)) return void showToast("Could not sign out.");
        }
        this.me = null;
        this.render();
        this.hooks.signedOut();
    }

    /** The session ended on the server (a 401): shown as signed out. */
    private lost(): void {
        if (!this.me) return;
        this.me = null;
        this.render();
        this.hooks.signedOut();
    }

    // ---- Add a build

    /** Signed out: offers to sign in (true when the visitor is signed in and may go on). */
    private async needSignIn(title: string, what: string): Promise<boolean> {
        await this.ready;
        if (this.me) return true;
        const go = await dialog(
            title,
            [`Sign in with GitHub to ${what}.`],
            [
                { label: "Cancel", value: false },
                { label: "Sign in", value: true, kind: "primary" },
            ],
            false,
        );
        if (go) await this.signIn();
        return false;
    }

    async addBuild(): Promise<void> {
        if (!(await this.needSignIn("Add a build", "add a build"))) return;
        const repo = textInput("", "https://github.com/owner/repository");
        repo.dataset.autofocus = "";
        const branch = textInput("", "Default branch");
        const error = h("div", "fb-error");
        error.hidden = true;
        error.setAttribute("role", "alert");
        const fail = (message: string) => {
            error.textContent = message;
            error.hidden = false;
            return false;
        };
        const check = async (submit: boolean): Promise<boolean> => {
            if (!submit) return true;
            const url = repo.value.trim();
            if (!url) return fail("Enter the address of a GitHub repository.");
            try {
                await this.api.submitFork(url, branch.value.trim());
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) {
                    this.lost();
                    return fail("You are signed out. Sign in with GitHub to add a build.");
                }
                return fail(messageOf(e));
            }
            return true;
        };
        const ok = await dialog(
            "Add a build",
            [
                field("GitHub repository", repo),
                field("Branch", branch),
                error,
                h("p", "fb-hint", "The build is added after the maintainer approves it. Its pack is then built from the repository and updated when the branch changes."),
            ],
            [
                { label: "Cancel", value: false },
                { label: "Submit", value: true, kind: "primary" },
            ],
            false,
            { check },
        );
        if (!ok) return;
        if (this.me?.maintainer) this.me.pending = (this.me.pending ?? 0) + 1;
        showToast("Build submitted. It will appear after approval.", undefined, 6000);
    }

    // ---- Report a bug

    async reportBug(): Promise<void> {
        if (!(await this.needSignIn("Report a bug", "report a bug"))) return;
        const ctx = this.hooks.bugContext();
        const title = textInput("", "Short summary");
        title.dataset.autofocus = "";
        title.maxLength = 150;
        const text = h("textarea");
        text.placeholder = "What happened, and what you expected instead";
        text.maxLength = 5000;
        const attach = h("input");
        attach.type = "checkbox";
        attach.checked = true;
        const check = h("label", "fb-check");
        check.append(attach, `Attach the open map (${ctx.mapName ?? ""})`);
        check.hidden = ctx.mapName === null;
        const error = h("div", "fb-error");
        error.hidden = true;
        error.setAttribute("role", "alert");
        const fail = (message: string) => {
            error.textContent = message;
            error.hidden = false;
            return false;
        };
        const send = async (submit: boolean): Promise<boolean> => {
            if (!submit) return true;
            const subject = title.value.trim();
            const description = text.value.trim();
            if (!subject) return fail("Enter a title.");
            if (!description) return fail("Describe the problem.");
            const report: BugReportInput = { title: subject, description, page_url: location.href, build: ctx.build, user_agent: navigator.userAgent };
            if (ctx.mapName !== null && attach.checked) {
                const map = ctx.mapText();
                if (map !== null) {
                    if (map.length > MAX_MAP) return fail("The map is larger than 20 MB. Send the report without it.");
                    report.map_name = ctx.mapName;
                    report.map = map;
                }
            } else if (ctx.mapName !== null) report.map_name = ctx.mapName;
            try {
                await this.api.sendBugReport(report);
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) {
                    this.lost();
                    return fail("You are signed out. Sign in with GitHub to report a bug.");
                }
                return fail(messageOf(e));
            }
            return true;
        };
        const ok = await dialog(
            "Report a bug",
            [
                field("Title", title),
                field("Description", text),
                check,
                error,
                h("p", "fb-hint", "The report includes the page address, the build and your browser version."),
            ],
            [
                { label: "Cancel", value: false },
                { label: "Send", value: true, kind: "primary" },
            ],
            false,
            { check: send, width: 480 },
        );
        if (ok) showToast("Thanks. The report was sent.", undefined, 6000);
    }

    // ---- Your builds

    async yourBuilds(): Promise<void> {
        const list = h("div", "fb-list");
        list.append(h("p", "dlg-muted", "Loading…"));
        const shown = dialog<void>("Your builds", [list], [{ label: "Close", value: undefined }], undefined, { width: 560 });
        try {
            const forks = await this.api.myForks();
            list.replaceChildren(...(forks.length ? forks.map((f) => this.myRow(f)) : [h("div", "fb-empty", "You have not added any builds.")]));
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) this.lost();
            list.replaceChildren(h("div", "fb-error", messageOf(e)));
        }
        await shown;
    }

    private myRow(f: MyFork): HTMLElement {
        const s = stateLabel(f.status, f.build);
        const r = h("div", "fb-row");
        r.append(rowText(f.name, myBuildMeta(f), s.reason), badge(s));
        return r;
    }

    // ---- Bug reports (maintainer)

    async bugReports(): Promise<void> {
        let reports: BugReport[] | null = null;
        let tab: BugStatus | null = "new";
        const tabs = h("div", "fb-tabs");
        const list = h("div", "fb-list");
        list.append(h("p", "dlg-muted", "Loading…"));

        const render = () => {
            const all = reports ?? [];
            tabs.replaceChildren(
                ...BUG_TABS.map((t) => {
                    const b = button("", t.label, "", () => {
                        tab = t.status;
                        render();
                    });
                    b.append(h("span", "n", String(t.status ? all.filter((r) => r.status === t.status).length : all.length)));
                    b.setAttribute("aria-pressed", String(t.status === tab));
                    return b;
                }),
            );
            if (!reports) return;
            const shown = tab ? all.filter((r) => r.status === tab) : all;
            list.replaceChildren(...(shown.length ? shown.map((r) => row(r)) : [h("div", "fb-empty", "No reports")]));
        };

        const refresh = async () => {
            reports = await this.api.adminBugReports();
            if (this.me?.maintainer) this.me.bugs = reports.filter((r) => r.status === "new").length;
            render();
        };

        /** Runs an action of a row, then lists the reports again; a failure is told in a notice. */
        const act = async (r: HTMLElement, action: () => Promise<unknown>) => {
            for (const b of r.querySelectorAll("button")) b.disabled = true;
            try {
                await action();
                await refresh();
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) this.lost();
                showToast(messageOf(e), undefined, 6000);
                for (const b of r.querySelectorAll("button")) b.disabled = false;
            }
        };

        const download = async (r: BugReport, b: HTMLButtonElement) => {
            b.disabled = true;
            try {
                const blob = await this.api.bugMap(r.id);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = r.mapName || "map.yml";
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) this.lost();
                showToast(messageOf(e), undefined, 6000);
            }
            b.disabled = false;
        };

        const remove = async (r: BugReport, el: HTMLElement) => {
            const sure = await dialog(
                "Delete report?",
                [`${r.title} and its attached map will be deleted.`],
                [
                    { label: "Cancel", value: false },
                    { label: "Delete", value: true, kind: "danger" },
                ],
                false,
            );
            if (sure) await act(el, () => this.api.removeBug(r.id));
        };

        const row = (r: BugReport): HTMLElement => {
            const el = h("div", "fb-row top");
            el.dataset.id = String(r.id);
            const t = h("div", "fb-text");
            const n = h("span", "fb-name", r.title);
            n.title = r.title;
            t.append(n, h("span", "fb-meta", bugMeta(r, this.hooks.bugContext().buildName)), h("span", "fb-desc", r.description));
            el.append(t);
            if (r.hasMap) el.append(button("btn", "Map", "", (e) => void download(r, e.currentTarget as HTMLButtonElement)));
            if (r.status === "new") el.append(button("btn", "Mark fixed", "", () => void act(el, () => this.api.markBugFixed(r.id))));
            el.append(button("btn danger", "Delete", "", () => void remove(r, el)));
            return el;
        };

        render();
        const shown = dialog<void>("Bug reports", [tabs, list], [{ label: "Close", value: undefined }], undefined, { width: 720 });
        try {
            await refresh();
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) this.lost();
            list.replaceChildren(h("div", "fb-error", messageOf(e)));
        }
        await shown;
    }

    // ---- Manage builds

    async manageBuilds(): Promise<void> {
        let forks: AdminFork[] | null = null;
        let tab: ForkStatus = "pending";
        let approving: number | null = null;
        const tabs = h("div", "fb-tabs");
        const list = h("div", "fb-list");
        list.append(h("p", "dlg-muted", "Loading…"));
        const note = h("p", "fb-note", "The ID names the build in links and saved maps and cannot be changed after the first build.");

        const render = () => {
            const all = forks ?? [];
            tabs.replaceChildren(
                ...MANAGE_TABS.map((t) => {
                    const b = button("", t.label, "", () => {
                        tab = t.status;
                        approving = null;
                        render();
                    });
                    b.append(h("span", "n", String(all.filter((f) => f.status === t.status).length)));
                    b.setAttribute("aria-pressed", String(t.status === tab));
                    return b;
                }),
            );
            note.hidden = tab !== "pending";
            if (!forks) return;
            const shown = all.filter((f) => f.status === tab);
            list.replaceChildren(...(shown.length ? shown.map((f) => (f.id === approving ? approveRow(f) : row(f))) : [h("div", "fb-empty", "No builds")]));
        };

        const refresh = async () => {
            forks = await this.api.adminForks();
            if (this.me?.maintainer) this.me.pending = forks.filter((f) => f.status === "pending").length;
            render();
        };

        /** Runs an action of a row, then lists the builds again; a failure is told in a notice. */
        const act = async (r: HTMLElement, action: () => Promise<unknown>) => {
            for (const b of r.querySelectorAll("button")) b.disabled = true;
            try {
                await action();
                approving = null;
                await refresh();
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) this.lost();
                showToast(messageOf(e).replace(/\bslug\b/g, "ID"), undefined, 6000);
                for (const b of r.querySelectorAll("button")) b.disabled = false;
            }
        };

        const startApprove = (f: AdminFork) => {
            approving = f.id;
            render();
            list.querySelector<HTMLInputElement>(".fb-approve input")?.focus();
        };

        const row = (f: AdminFork): HTMLElement => {
            const r = h("div", "fb-row");
            r.dataset.id = String(f.id);
            const btn = (label: string, run: () => void, kind = "") => button(`btn${kind ? ` ${kind}` : ""}`, label, "", run);
            const del = btn("Delete", () => void remove(f, r), "danger");
            if (f.status === "pending") {
                r.append(rowText(f.title, adminMeta(f)), btn("Approve", () => startApprove(f)), btn("Decline", () => void act(r, () => this.api.act(f.id, "reject"))));
            } else if (f.status === "approved") {
                const s = stateLabel(f.status, f.build);
                r.append(
                    rowText(f.title, adminMeta(f), s.reason),
                    badge(s),
                    btn("Rebuild", () => void act(r, () => this.api.act(f.id, "rebuild"))),
                    btn("Hide", () => void act(r, () => this.api.act(f.id, "hide"))),
                    del,
                );
            } else if (f.status === "hidden") {
                r.append(rowText(f.title, adminMeta(f)), btn("Unhide", () => void act(r, () => this.api.act(f.id, "unhide"))), del);
            } else {
                r.append(rowText(f.title, adminMeta(f)), btn("Approve", () => startApprove(f)), del);
            }
            return r;
        };

        const approveRow = (f: AdminFork): HTMLElement => {
            const r = h("div", "fb-row");
            r.dataset.id = String(f.id);
            const form = h("div", "fb-approve");
            const name = textInput(f.title);
            const id = textInput(f.slug);
            // the ID is fixed once a build exists
            id.disabled = !!f.build;
            if (id.disabled) id.title = "The ID cannot be changed after the first build.";
            form.append(field("Name", name), field("ID", id, "id"));
            const approve = async () => {
                const title = name.value.trim();
                const slug = id.value.trim();
                if (!title) return showToast("Enter a name.");
                if (slug !== f.slug && !SLUG_PATTERN.test(slug)) return showToast("The ID can have lowercase letters, digits and hyphens, and starts with a letter or digit.", undefined, 6000);
                await act(r, () => this.api.approve(f.id, slug !== f.slug ? { title, slug } : { title }));
            };
            const cancel = () => {
                approving = null;
                render();
            };
            for (const input of [name, id]) {
                input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        void approve();
                    } else if (e.key === "Escape") {
                        // ends the approval, not the dialog
                        e.preventDefault();
                        e.stopPropagation();
                        cancel();
                    }
                });
            }
            r.append(form, button("btn primary", "Approve", "", () => void approve()), button("btn", "Cancel", "", cancel));
            return r;
        };

        const remove = async (f: AdminFork, r: HTMLElement) => {
            const sure = await dialog(
                "Delete build?",
                [`${f.title} and its packs will be deleted.`],
                [
                    { label: "Cancel", value: false },
                    { label: "Delete", value: true, kind: "danger" },
                ],
                false,
            );
            if (sure) await act(r, () => this.api.remove(f.id));
        };

        render();
        const shown = dialog<void>("Manage builds", [tabs, list, note], [{ label: "Close", value: undefined }], undefined, { width: 720 });
        try {
            await refresh();
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) this.lost();
            list.replaceChildren(h("div", "fb-error", messageOf(e)));
        }
        await shown;
        this.hooks.buildsChanged();
    }
}
