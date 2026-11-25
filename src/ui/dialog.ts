// Modal dialogs of the shell in place of the browser's confirm() and prompt(): unsaved changes, About, and the
// forms built on `dialog` (new map, Save as, the library). Esc or a click outside cancels; Enter in a field
// presses the primary button; the editor does not see keys while one is open.
import { t as translate } from "../i18n";
import { button, h, icon, ICON } from "./icons";

const STYLE = `
.dlg-backdrop { position: fixed; inset: 0; z-index: 1800; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, 0.55); }
.dlg { width: min(var(--dlg-w, 440px), 100%); max-height: 100%; overflow-y: auto; box-sizing: border-box; padding: 24px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-l); box-shadow: var(--shadow); font: 13px/1.45 var(--font); }
.dlg { position: relative; }
.dlg h2 { margin: 0 0 16px; padding-right: 24px; font-size: 18px; font-weight: 600; }
.dlg h3 { margin: 12px 0 4px; font-size: 13px; font-weight: 600; }
.dlg .dlg-x { position: absolute; top: 12px; right: 12px; width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: 0; border-radius: var(--radius); background: transparent; color: var(--muted); }
.dlg .dlg-x:hover { background: var(--raised); color: var(--text); }
.dlg p { margin: 0 0 6px; color: var(--text-2); }
.dlg .dlg-muted { color: var(--muted); }
.dlg .dlg-buttons { display: flex; gap: 8px; margin-top: 24px; }
.dlg .dlg-buttons .grow { flex: 1; }
.dlg button.btn { height: var(--control-h); padding: 0 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--raised); color: var(--text); }
.dlg button.btn:hover { border-color: var(--border-strong); }
.dlg button.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.dlg button.btn.danger { background: var(--danger-bg); border-color: var(--danger-border); color: var(--danger-text); }
.dlg button.btn:disabled { opacity: 0.5; cursor: default; }
.dlg .dlg-field { display: flex; flex-direction: column; gap: 8px; margin: 16px 0 0; color: var(--text-2); font-size: 13px; }
.dlg .dlg-field input[type=text], .dlg .dlg-field input[type=number], .dlg .dlg-field select { height: var(--control-h); box-sizing: border-box; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--input); color: var(--text); font-size: 13px; }
.dlg .dlg-error { min-height: 1.45em; margin: 8px 0 0; color: var(--danger-text); }
`;

/** Open dialogs, the topmost last (a confirmation over a list): keys aimed nowhere belong to the topmost. */
const open: HTMLElement[] = [];

let styleAdded = false;
function addStyle(): void {
    if (styleAdded) return;
    styleAdded = true;
    const el = document.createElement("style");
    el.textContent = STYLE;
    document.head.append(el);
}

interface DialogButton<T> {
    label: string;
    value: T;
    kind?: "primary" | "danger";
    /** Pushes the buttons after it to the right. */
    spaceAfter?: boolean;
}

export interface DialogOptions<T> {
    /** Runs before a button other than the cancel one closes the dialog; false keeps it open (a form's errors). */
    check?: (value: T) => boolean | Promise<boolean>;
    /** Width in px (440 by default). */
    width?: number;
    /** Gets the function that closes the dialog, for controls in the body. */
    bind?: (close: (value: T) => void) => void;
}

/** Shows a dialog; resolves with the value of the button pressed, or `cancel` on Esc or a click outside. */
export function dialog<T>(title: string, body: Array<string | Node>, buttons: DialogButton<T>[], cancel: T, options: DialogOptions<T> = {}): Promise<T> {
    addStyle();
    return new Promise((resolve) => {
        const back = h("div", "dlg-backdrop");
        const box = h("div", "dlg");
        if (options.width) box.style.setProperty("--dlg-w", `${options.width}px`);
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");
        box.setAttribute("aria-label", title);
        // a dialog whose only button is Close gets a cross in the corner instead
        const onlyClose = buttons.length === 1 && buttons[0]!.label === translate("Close");
        box.append(h("h2", "", title));
        for (const b of body) box.append(typeof b === "string" ? h("p", "", b) : b);
        const row = h("div", "dlg-buttons");
        let closed = false;
        const done = (v: T) => {
            if (closed) return;
            closed = true;
            window.removeEventListener("keydown", outside, true);
            open.splice(open.indexOf(back), 1);
            back.remove();
            resolve(v);
        };
        let checking = false;
        const press = async (v: T) => {
            if (checking) return;
            if (v !== cancel && options.check) {
                checking = true;
                const ok = await options.check(v);
                checking = false;
                if (!ok) return;
            }
            done(v);
        };
        let primary: (() => void) | null = null;
        if (onlyClose) {
            const x = button("dlg-x", icon(ICON.close, 14), translate("Close"), () => void press(buttons[0]!.value));
            x.setAttribute("aria-label", translate("Close"));
            box.append(x);
        }
        for (const b of onlyClose ? [] : buttons) {
            const el = button(`btn${b.kind ? ` ${b.kind}` : ""}`, b.label, "", () => void press(b.value));
            if (b.kind === "primary") primary = () => void press(b.value);
            row.append(el);
            if (b.spaceAfter) row.append(h("span", "grow"));
        }
        if (!onlyClose) box.append(row);
        back.append(box);
        back.addEventListener("pointerdown", (e) => {
            if (e.target === back) done(cancel);
        });
        // keys in the dialog reach its fields and buttons, then stop here; the editor never sees them
        back.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
                e.preventDefault();
                done(cancel);
            } else if (e.key === "Enter" && e.target instanceof HTMLInputElement && !e.defaultPrevented && primary) {
                e.preventDefault();
                primary();
            }
        });
        // keys aimed elsewhere (nothing focused) stop before the editor
        const outside = (e: KeyboardEvent) => {
            if (back.contains(e.target as Node) || open.at(-1) !== back) return;
            e.stopPropagation();
            if (e.key === "Escape") {
                e.preventDefault();
                done(cancel);
            }
        };
        window.addEventListener("keydown", outside, true);
        options.bind?.(done);
        document.body.append(back);
        open.push(back);
        const first = box.querySelector<HTMLElement>("[data-autofocus]") ?? row.querySelector<HTMLButtonElement>(".primary") ?? (onlyClose ? box.querySelector<HTMLElement>(".dlg-x") : null);
        first?.focus();
        if (first instanceof HTMLInputElement) first.select();
    });
}

export type UnsavedChoice = "save" | "discard" | "cancel";

/** Asks what to do with unsaved edits before another map replaces them. */
export function confirmUnsaved(name: string, note?: string): Promise<UnsavedChoice> {
    return dialog<UnsavedChoice>(
        translate("Save changes?"),
        [translate("{{1}} has unsaved changes.", { 1: name }), ...(note ? [note] : [])],
        [
            { label: translate("Discard"), value: "discard", kind: "danger", spaceAfter: true },
            { label: translate("Cancel"), value: "cancel" },
            { label: translate("Save"), value: "save", kind: "primary" },
        ],
        "cancel",
    );
}

/** About the editor and the current build data. */
export async function showAbout(build: string): Promise<void> {
    const trigger = document.activeElement;
    const head = h("div", "dlg-muted", build ? translate("Build: {{1}}", { 1: build }) : translate("No build loaded"));
    await dialog<void>(
        translate("About SS14 Mapper"),
        [
            translate("Map editor for Space Station 14."),
            head,
            h("h3", "", translate("AI in development")),
            translate("AI tools helped write code and tests for parts of SS14 Mapper. The project maintainer decides what gets merged and released."),
        ],
        [{ label: translate("Close"), value: undefined, kind: "primary" }],
        undefined,
    );
    if (trigger instanceof HTMLElement) trigger.focus();
}

