// Short notices at the bottom of the map, optionally with one action ("Deleted. Undo").
// API contract shared by the palette and the editor shell.

export interface ToastAction {
    label: string;
    run: () => void;
}

const STYLE = `
.toast { position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2000; display: flex; align-items: center; justify-content: center; gap: 12px; max-width: min(520px, calc(100% - 32px)); box-sizing: border-box; padding: 8px 14px; background: var(--raised); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius); box-shadow: var(--shadow); font: 13px/1.35 var(--font); }
.toast[hidden] { display: none; }
.toast .toast-text { min-width: 0; overflow-wrap: anywhere; }
.toast.has-action { padding-right: 8px; }
.toast .toast-action { flex: none; height: 24px; padding: 0 10px; background: transparent; color: var(--accent-text); border: 1px solid var(--border-strong); border-radius: var(--radius-s); }
.toast .toast-action:hover { background: var(--accent-soft); }
`;

let box: HTMLElement | null = null;
let timer = 0;

const dismiss = () => {
    clearTimeout(timer);
    if (box) box.hidden = true;
};

function ensure(): HTMLElement {
    if (box && box.isConnected) return box;
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    box = document.createElement("div");
    box.className = "toast";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    box.hidden = true;
    document.body.append(box);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && box && !box.hidden) dismiss();
    });
    return box;
}

/** Shows a notice for `ms` milliseconds; a newer notice replaces it. Escape dismisses it. */
export function showToast(message: string, action?: ToastAction, ms = 5000): void {
    if (typeof document === "undefined") return;
    const el = ensure();
    clearTimeout(timer);
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;
    el.replaceChildren(text);
    if (action) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "toast-action";
        b.textContent = action.label;
        b.addEventListener("click", () => {
            dismiss();
            action.run();
        });
        el.append(b);
    }
    el.hidden = false;
    // inside the map area, so it stays centred on it whatever the side panels do
    // (the page itself while the editor is hidden: the start screen)
    const view = document.getElementById("view");
    const host = view && view.getClientRects().length ? view : document.body;
    if (el.parentElement !== host) host.append(el);
    el.classList.toggle("has-action", !!action);
    timer = window.setTimeout(dismiss, ms);
}
