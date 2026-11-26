// The account in the headers of the start screen and the editor: Sign in with GitHub, or the user's menu (Your
// builds, Add a build, Manage builds for the maintainer, Sign out), and the dialogs behind it.
import { language, t as translate } from "../i18n";
import { adminMeta, BUG_TABS, KIND_TABS, bugMeta, MANAGE_TABS, myBuildMeta, SLUG_PATTERN, stateLabel, type StateLabel } from "../api/builds";
import { ApiError, type AdminFork, type Api, type BugImage, type BugReport, type BugKind, type BugReportInput, type BugStatus, type ForkStatus, type Me, type MyFork } from "../api/client";
import { addImages, IMAGE_TYPES, MAX_IMAGES } from "../api/feedback-images";
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
.dlg .fb-list { display: flex; flex-direction: column; max-height: 56vh; overflow-y: auto; margin-top: 12px; border-top: 1px solid var(--border); }
.dlg .fb-row { display: grid; grid-template-columns: minmax(0, 1fr) 100px auto; align-items: center; gap: 8px 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.dlg .fb-row > .fb-text { grid-column: 1; }
.dlg .fb-row > .fb-state { grid-column: 2; }
.dlg .fb-row > .fb-actions { grid-column: 3; }
.dlg .fb-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; }
.dlg .fb-actions .danger { margin-left: 8px; }
.dlg .fb-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dlg .fb-name { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dlg .fb-meta { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.dlg .fb-meta a { color: inherit; }
.dlg .fb-reason { color: var(--danger-text); font-size: 12px; }
.dlg .fb-state { flex: none; font-size: 12px; color: var(--muted); }
.dlg .fb-state.ready { color: var(--accent-text); }
.dlg .fb-state.failed { color: var(--danger-text); }
.dlg .fb-state.wait { color: var(--warn); }
.dlg .fb-row button.btn { height: 26px; padding: 0 10px; }
.dlg .fb-tabs, .dlg .fb-seg { display: flex; flex-wrap: wrap; gap: 2px; align-self: flex-start; max-width: 100%; }
.dlg .fb-tabs button, .dlg .fb-seg button { min-height: 30px; padding: 4px 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--muted); }
.dlg .fb-tabs button:hover, .dlg .fb-seg button:hover { color: var(--text); background: var(--raised); }
.dlg .fb-tabs button[aria-pressed="true"], .dlg .fb-seg button[aria-pressed="true"] { background: var(--accent-soft); border-bottom-color: var(--accent-text); color: var(--text); }
.dlg .fb-tabs .n { margin-left: 5px; color: var(--muted); font-weight: 400; }
.dlg .fb-approve { display: grid; grid-column: 1 / -1; grid-template-columns: minmax(0, 1fr) minmax(0, 140px); gap: 12px; width: 100%; min-width: 0; }
.dlg .fb-approve .dlg-field { margin: 0; flex: 1; min-width: 0; }
.dlg .fb-approve input:disabled { color: var(--muted); }
.dlg .fb-note { margin-top: 10px; color: var(--muted); font-size: 12px; }
.dlg textarea { min-height: 120px; resize: vertical; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--input); color: var(--text); font: 13px/1.4 var(--font); }
.dlg .fb-check { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--text-2); font-size: 13px; }
.dlg .fb-desc { color: var(--text-2); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 2px; }
.dlg .fb-row.top { align-items: flex-start; }
.dlg .fb-row.top > .fb-text, .dlg .fb-row.top > .fb-actions { grid-column: 1 / -1; }
.dlg .fb-kind { margin-right: 8px; color: var(--muted); font-size: 12px; }
.dlg .fb-bar { display: flex; gap: 8px 20px; align-items: flex-start; flex-wrap: wrap; }
.dlg .fb-filter { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dlg .fb-filter-label { color: var(--muted); font-size: 12px; }
.dlg .fb-bar .fb-tabs { margin-top: 0; }
.dlg .fb-images { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dlg .fb-images .fb-count { color: var(--muted); font-size: 12px; }
.dlg .fb-thumb { position: relative; flex: none; }
.dlg .fb-thumb img { display: block; height: 64px; width: auto; max-width: 120px; min-width: 40px; object-fit: cover; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--panel-2); }
.dlg .fb-thumb .fb-rm { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--radius-s); background: var(--raised); color: var(--text); opacity: 0.9; }
.dlg .fb-thumb .fb-rm:hover { background: var(--danger-bg); color: var(--danger-text); opacity: 1; }
.dlg .fb-row-images { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.dlg .fb-row-images button { padding: 0; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--panel-2); line-height: 0; overflow: hidden; }
.dlg .fb-row-images button:hover { border-color: var(--border-strong); }
.dlg .fb-row-images img, .dlg .fb-row-images .ph { height: 48px; width: 48px; object-fit: cover; display: block; }
.dlg .fb-view { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.dlg .fb-view img { flex: 1; min-width: 0; max-width: 100%; max-height: calc(100vh - 190px); object-fit: contain; margin: 0 auto; }
.dlg .fb-view button { flex: none; }
.dlg .fb-empty { padding: 16px 0; color: var(--muted); }
.dlg .fb-section { min-width: 0; margin: 0; padding: 0; border: 0; }
.dlg .fb-section + .fb-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.dlg .fb-section legend { padding: 0; margin-bottom: 10px; font-weight: 600; color: var(--text); }
.dlg .fb-section .dlg-field { margin-top: 12px; gap: 6px; }
.dlg .fb-section .dlg-field:first-of-type { margin-top: 0; }
.dlg .fb-section .fb-seg { margin-bottom: 12px; }
.dlg .fb-section input, .dlg .fb-section textarea, .dlg .fb-approve input { min-width: 0; width: 100%; }
.dlg .fb-section input[type=checkbox] { width: auto; flex: none; }
.dlg .fb-context { margin-top: 12px; color: var(--muted); font-size: 12px; }
.dlg .fb-context summary { cursor: pointer; color: var(--text-2); }
.dlg .fb-context p { margin-top: 8px; }
@media (max-width: 480px) {
    .dlg .fb-approve { grid-template-columns: minmax(0, 1fr); }
    .dlg .fb-row { grid-template-columns: minmax(0, 1fr); }
    .dlg .fb-row > .fb-state, .dlg .fb-row > .fb-actions { grid-column: 1; }
    .dlg .fb-actions { width: 100%; margin-left: 0; }
}
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

function section(title: string, ...children: HTMLElement[]): HTMLElement {
    const group = h("fieldset", "fb-section");
    group.append(h("legend", "", title), ...children);
    return group;
}

function actions(...children: HTMLElement[]): HTMLElement {
    const group = h("div", "fb-actions");
    group.append(...children);
    return group;
}

function filter(label: string, controls: HTMLElement): HTMLElement {
    const group = h("div", "fb-filter");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    group.append(h("span", "fb-filter-label", label), controls);
    return group;
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
                b.append(h("span", "", translate("Sign in")));
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
        b.title = translate("Signed in as {{1}}", { 1: me.login });
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
            { label: translate("Your builds…"), run: () => void this.yourBuilds() },
            { label: translate("Add a build…"), run: () => void this.addBuild() },
            { label: translate("Send feedback…"), run: () => void this.reportBug() },
        ];
        if (me.maintainer) {
            items.push({ label: translate("Guides and FAQ…"), run: () => { window.open(`/admin/content/?lang=${language()}`, "_blank", "noopener,noreferrer"); } });
            const n = me.pending ?? 0;
            items.push({ label: translate("Manage builds…"), ...(n > 0 ? { note: translate("{{1}} waiting for approval", { 1: n }) } : {}), run: () => void this.manageBuilds() });
            const bugs = me.bugs ?? 0;
            items.push({ label: translate("Feedback…"), ...(bugs > 0 ? { note: translate("{{1}} new", { 1: bugs }) } : {}), run: () => void this.bugReports() });
        }
        items.push("-", { label: translate("Sign out"), run: () => void this.signOut() });
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
            if (!(e instanceof ApiError && e.status === 401)) return void showToast(translate("Could not sign out."));
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
            [translate("Sign in with GitHub to {{1}}.", { 1: what })],
            [
                { label: translate("Cancel"), value: false },
                { label: translate("Sign in"), value: true, kind: "primary" },
            ],
            false,
        );
        if (go) await this.signIn();
        return false;
    }

    private async needMaintainer(title: string, what: string): Promise<boolean> {
        if (!(await this.needSignIn(title, what))) return false;
        if (this.me?.maintainer) return true;
        await dialog(title, [translate("Only maintainers can open this form.")], [{ label: translate("Close"), value: undefined }], undefined);
        return false;
    }

    async addBuild(): Promise<void> {
        if (!(await this.needSignIn(translate("Add a build"), translate("add a build")))) return;
        const repo = textInput("", "https://github.com/owner/repository");
        repo.dataset.autofocus = "";
        const branch = textInput("", translate("Default branch"));
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
            if (!url) return fail(translate("Enter the address of a GitHub repository."));
            try {
                await this.api.submitFork(url, branch.value.trim());
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) {
                    this.lost();
                    return fail(translate("You are signed out. Sign in with GitHub to add a build."));
                }
                return fail(messageOf(e));
            }
            return true;
        };
        const ok = await dialog(
            translate("Add a build"),
            [
                section(translate("Build source"), field(translate("GitHub repository"), repo), field(translate("Branch"), branch)),
                error,
                h("p", "fb-hint", translate("The build is added after the maintainer approves it. Its pack is then built from the repository and updated when the branch changes.")),
            ],
            [
                { label: translate("Cancel"), value: false },
                { label: translate("Submit"), value: true, kind: "primary" },
            ],
            false,
            { check, width: 520 },
        );
        if (!ok) return;
        if (this.me?.maintainer) this.me.pending = (this.me.pending ?? 0) + 1;
        showToast(translate("Build submitted. It will appear after approval."), undefined, 6000);
    }

    // ---- Report a bug

    async reportBug(): Promise<void> {
        if (!(await this.needSignIn(translate("Send feedback"), translate("send feedback")))) return;
        const ctx = this.hooks.bugContext();
        const title = textInput("", translate("Short summary"));
        title.dataset.autofocus = "";
        title.maxLength = 150;
        const text = h("textarea");
        text.maxLength = 5000;
        const attach = h("input");
        attach.type = "checkbox";
        let kind: BugKind = "bug";
        const seg = h("div", "fb-seg");
        seg.setAttribute("role", "group");
        seg.setAttribute("aria-label", translate("Feedback type"));
        const kinds: Array<[BugKind, string]> = [
            ["bug", translate("Bug")],
            ["idea", translate("Suggestion")],
        ];
        const setKind = (k: BugKind) => {
            kind = k;
            for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.kind === k));
            text.placeholder = k === "bug" ? translate("What happened, and what you expected instead") : translate("What you would like the editor to do, and why");
            // a map helps to reproduce a bug; a suggestion rarely needs one
            attach.checked = k === "bug";
        };
        for (const [k, label] of kinds) {
            const b = button("", label, "", () => setKind(k));
            b.type = "button";
            b.dataset.kind = k;
            seg.append(b);
        }
        setKind("bug");
        // images: the files, their previews, and the three ways to add them
        let files: File[] = [];
        const previews = new Map<File, string>();
        const strip = h("div", "fb-images");
        const picker = h("input");
        picker.type = "file";
        picker.accept = IMAGE_TYPES.join(",");
        picker.multiple = true;
        picker.hidden = true;
        const addBtn = button("btn", translate("Add images…"), "", () => picker.click());
        addBtn.type = "button";
        const drawImages = () => {
            const thumbs = files.map((f) => {
                let url = previews.get(f);
                if (!url) previews.set(f, (url = URL.createObjectURL(f)));
                const t = h("div", "fb-thumb");
                const img = h("img");
                img.src = url;
                img.alt = f.name;
                const rm = button("fb-rm", icon(ICON.close, 10), translate("Remove image"), () => {
                    files = files.filter((x) => x !== f);
                    URL.revokeObjectURL(previews.get(f)!);
                    previews.delete(f);
                    drawImages();
                });
                rm.type = "button";
                t.append(img, rm);
                return t;
            });
            addBtn.disabled = files.length >= MAX_IMAGES;
            strip.replaceChildren(addBtn, ...thumbs, h("span", "fb-count", translate("{{1}} of {{2}}", { 1: files.length, 2: MAX_IMAGES })));
        };
        const take = (list: File[]) => {
            const r = addImages(files, list);
            files = r.images;
            if (r.error) fail(r.error);
            else error.hidden = true;
            drawImages();
        };
        picker.addEventListener("change", () => {
            take([...(picker.files ?? [])]);
            picker.value = "";
        });
        const onPaste = (e: ClipboardEvent) => {
            const items = [...(e.clipboardData?.items ?? [])];
            const pics = items.filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => f !== null);
            if (!pics.length) return;
            const t = e.target;
            // a text field keeps its own paste unless the clipboard holds only the image
            if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && items.some((i) => i.type === "text/plain")) return;
            e.preventDefault();
            take(pics);
        };
        const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
        const onOver = (e: DragEvent) => {
            if (hasFiles(e)) e.preventDefault();
        };
        const onDrop = (e: DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            take([...(e.dataTransfer?.files ?? [])]);
        };
        document.addEventListener("paste", onPaste);
        document.addEventListener("dragover", onOver);
        document.addEventListener("drop", onDrop);
        const imagesField = h("div", "dlg-field");
        imagesField.append(translate("Images"), strip, picker);
        drawImages();
        const check = h("label", "fb-check");
        check.append(attach, translate("Attach the open map ({{1}})", { 1: ctx.mapName ?? "" }));
        check.hidden = ctx.mapName === null;
        const context = h("details", "fb-context");
        context.append(h("summary", "", translate("Report context")), h("p", "", translate("The page address, the build and your browser version are sent with it.")));
        if (ctx.build) context.append(h("p", "", `${translate("Build")}: ${ctx.buildName(ctx.build)}`));
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
            if (!subject) return fail(translate("Enter a title."));
            if (!description) return fail(kind === "bug" ? translate("Describe the problem.") : translate("Describe the suggestion."));
            const report: BugReportInput = { kind, title: subject, description, page_url: location.href, build: ctx.build, user_agent: navigator.userAgent };
            if (ctx.mapName !== null && attach.checked) {
                const map = ctx.mapText();
                if (map !== null) {
                    if (map.length > MAX_MAP) return fail(translate("The map is larger than 20 MB. Send it without the map."));
                    report.map_name = ctx.mapName;
                    report.map = map;
                }
            } else if (ctx.mapName !== null) report.map_name = ctx.mapName;
            try {
                await this.api.sendBugReport(report, files);
            } catch (e) {
                if (e instanceof ApiError && e.status === 401) {
                    this.lost();
                    return fail(translate("You are signed out. Sign in with GitHub to send feedback."));
                }
                return fail(messageOf(e));
            }
            return true;
        };
        const ok = await dialog(
            translate("Send feedback"),
            [
                section(translate("Message"), seg, field(translate("Title"), title), field(translate("Description"), text)),
                section(translate("Attachments"), imagesField, check, context),
                error,
            ],
            [
                { label: translate("Cancel"), value: false },
                { label: translate("Send"), value: true, kind: "primary" },
            ],
            false,
            { check: send, width: 560 },
        );
        document.removeEventListener("paste", onPaste);
        document.removeEventListener("dragover", onOver);
        document.removeEventListener("drop", onDrop);
        for (const u of previews.values()) URL.revokeObjectURL(u);
        if (ok) showToast(translate("Thanks. Your feedback was sent."), undefined, 6000);
    }

    // ---- Your builds

    async yourBuilds(): Promise<void> {
        if (!(await this.needSignIn(translate("Your builds"), translate("view your builds")))) return;
        const list = h("div", "fb-list");
        list.append(h("p", "dlg-muted", translate("Loading…")));
        const add = button("btn", translate("Add a build…"), "", () => void this.addBuild());
        const shown = dialog<void>(translate("Your builds"), [add, list], [{ label: translate("Close"), value: undefined }], undefined, { width: 560 });
        try {
            const forks = await this.api.myForks();
            list.replaceChildren(...(forks.length ? forks.map((f) => this.myRow(f)) : [h("div", "fb-empty", translate("You have not added any builds."))]));
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
        if (!(await this.needMaintainer(translate("Feedback"), translate("review feedback")))) return;
        let reports: BugReport[] | null = null;
        let tab: BugStatus | null = "new";
        let kindTab: BugKind | null = null;
        const tabs = h("div", "fb-tabs");
        const kindTabs = h("div", "fb-tabs");
        const bar = h("div", "fb-bar");
        bar.append(filter(translate("Status"), tabs), filter(translate("Feedback type"), kindTabs));
        const list = h("div", "fb-list");
        list.append(h("p", "dlg-muted", translate("Loading…")));

        const render = () => {
            const all = (reports ?? []).filter((r) => kindTab === null || r.kind === kindTab);
            kindTabs.replaceChildren(
                ...KIND_TABS.map((t) => {
                    const b = button("", t.label, "", () => {
                        kindTab = t.kind;
                        render();
                    });
                    b.setAttribute("aria-pressed", String(t.kind === kindTab));
                    return b;
                }),
            );
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
            list.replaceChildren(...(shown.length ? shown.map((r) => row(r)) : [h("div", "fb-empty", translate("No reports match these filters."))]));
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
                translate("Delete report?"),
                [translate("{{1}} and its attached map and images will be deleted.", { 1: r.title })],
                [
                    { label: translate("Cancel"), value: false },
                    { label: translate("Delete"), value: true, kind: "danger" },
                ],
                false,
            );
            if (sure) await act(el, () => this.api.removeBug(r.id));
        };

        // image previews are fetched with the session and live until the dialog closes
        const urls = new Map<number, Promise<string>>();
        const imageUrl = (r: BugReport, i: BugImage): Promise<string> => {
            let p = urls.get(i.id);
            if (!p) urls.set(i.id, (p = this.api.bugImage(r.id, i.id).then((b) => URL.createObjectURL(b))));
            return p;
        };
        const view = async (r: BugReport, start: number) => {
            let at = start;
            const img = h("img");
            const prev = button("btn", translate("Previous"), "", () => step(-1));
            const next = button("btn", translate("Next"), "", () => step(1));
            const n = r.images.length;
            const wrap = h("div", "fb-view");
            wrap.append(prev, img, next);
            const show = async () => {
                const dlgEl = wrap.closest(".dlg");
                dlgEl?.setAttribute("aria-label", translate("Image {{1}} of {{2}}", { 1: at + 1, 2: n }));
                const title = dlgEl?.querySelector("h2");
                if (title) title.textContent = translate("Image {{1}} of {{2}}", { 1: at + 1, 2: n });
                prev.disabled = at === 0;
                next.disabled = at === n - 1;
                const want = at;
                try {
                    const u = await imageUrl(r, r.images[at]!);
                    if (want === at) img.src = u;
                } catch (e) {
                    showToast(messageOf(e), undefined, 6000);
                }
            };
            const step = (d: number) => {
                at = Math.min(n - 1, Math.max(0, at + d));
                void show();
            };
            const keys = (e: KeyboardEvent) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                e.stopPropagation();
                step(e.key === "ArrowLeft" ? -1 : 1);
            };
            window.addEventListener("keydown", keys, true);
            const closed = dialog<void>(translate("Image {{1}} of {{2}}", { 1: at + 1, 2: n }), [wrap], [{ label: translate("Close"), value: undefined }], undefined, { width: 960 });
            void show();
            await closed;
            window.removeEventListener("keydown", keys, true);
        };
        const thumbs = (r: BugReport): HTMLElement => {
            const box = h("div", "fb-row-images");
            r.images.forEach((i, idx) => {
                const b = button("", "", translate("Image {{1}} of {{2}}", { 1: idx + 1, 2: r.images.length }), () => void view(r, idx));
                b.type = "button";
                const img = h("img");
                img.alt = translate("Image {{1}}", { 1: idx + 1 });
                b.append(img);
                box.append(b);
                void imageUrl(r, i).then((u) => (img.src = u), () => undefined);
            });
            return box;
        };

        const row = (r: BugReport): HTMLElement => {
            const el = h("div", "fb-row top");
            el.dataset.id = String(r.id);
            const t = h("div", "fb-text");
            const n = h("span", "fb-name", r.title);
            n.title = r.title;
            const meta = h("div", "fb-meta");
            meta.append(h("span", "fb-kind", r.kind === "idea" ? translate("Suggestion") : translate("Bug")), bugMeta(r, this.hooks.bugContext().buildName));
            t.append(n, meta, h("span", "fb-desc", r.description));
            if (r.images.length) t.append(thumbs(r));
            const controls = actions();
            el.append(t, controls);
            if (r.hasMap) controls.append(button("btn", translate("Map"), "", (e) => void download(r, e.currentTarget as HTMLButtonElement)));
            if (r.status === "new") controls.append(button("btn", translate("Mark done"), "", () => void act(el, () => this.api.markBugFixed(r.id))));
            controls.append(button("btn danger", translate("Delete"), "", () => void remove(r, el)));
            return el;
        };

        render();
        const shown = dialog<void>(translate("Feedback"), [bar, list], [{ label: translate("Close"), value: undefined }], undefined, { width: 720 });
        try {
            await refresh();
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) this.lost();
            list.replaceChildren(h("div", "fb-error", messageOf(e)));
        }
        await shown;
        for (const p of urls.values()) void p.then((u) => URL.revokeObjectURL(u), () => undefined);
    }

    // ---- Manage builds

    async manageBuilds(): Promise<void> {
        if (!(await this.needMaintainer(translate("Manage builds"), translate("manage builds")))) return;
        let forks: AdminFork[] | null = null;
        let tab: ForkStatus = "pending";
        let approving: number | null = null;
        const tabs = h("div", "fb-tabs");
        const list = h("div", "fb-list");
        list.append(h("p", "dlg-muted", translate("Loading…")));
        const note = h("p", "fb-note", translate("The ID names the build in links and saved maps and cannot be changed after the first build."));

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
            list.replaceChildren(...(shown.length ? shown.map((f) => (f.id === approving ? approveRow(f) : row(f))) : [h("div", "fb-empty", translate("No builds with this status."))]));
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
            const del = btn(translate("Delete"), () => void remove(f, r), "danger");
            if (f.status === "pending") {
                r.append(rowText(f.title, adminMeta(f)), actions(btn(translate("Approve"), () => startApprove(f)), btn(translate("Decline"), () => void act(r, () => this.api.act(f.id, "reject")))));
            } else if (f.status === "approved") {
                const s = stateLabel(f.status, f.build);
                r.append(
                    rowText(f.title, adminMeta(f), s.reason),
                    badge(s),
                    actions(btn(translate("Rebuild"), () => void act(r, () => this.api.act(f.id, "rebuild"))),
                    btn(translate("Hide"), () => void act(r, () => this.api.act(f.id, "hide"))),
                    del),
                );
            } else if (f.status === "hidden") {
                r.append(rowText(f.title, adminMeta(f)), actions(btn(translate("Unhide"), () => void act(r, () => this.api.act(f.id, "unhide"))), del));
            } else {
                r.append(rowText(f.title, adminMeta(f)), actions(btn(translate("Approve"), () => startApprove(f)), del));
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
            if (id.disabled) id.title = translate("The ID cannot be changed after the first build.");
            form.append(field(translate("Name"), name), field("ID", id, "id"));
            const approve = async () => {
                const title = name.value.trim();
                const slug = id.value.trim();
                if (!title) return showToast(translate("Enter a name."));
                if (slug !== f.slug && !SLUG_PATTERN.test(slug)) return showToast(translate("The ID can have lowercase letters, digits and hyphens, and starts with a letter or digit."), undefined, 6000);
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
            r.append(form, actions(button("btn primary", translate("Approve"), "", () => void approve()), button("btn", translate("Cancel"), "", cancel)));
            return r;
        };

        const remove = async (f: AdminFork, r: HTMLElement) => {
            const sure = await dialog(
                translate("Delete build?"),
                [translate("{{1}} and its packs will be deleted.", { 1: f.title })],
                [
                    { label: translate("Cancel"), value: false },
                    { label: translate("Delete"), value: true, kind: "danger" },
                ],
                false,
            );
            if (sure) await act(r, () => this.api.remove(f.id));
        };

        render();
        const shown = dialog<void>(translate("Manage builds"), [tabs, list, note], [{ label: translate("Close"), value: undefined }], undefined, { width: 720 });
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
