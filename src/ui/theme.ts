// Shared look of the editor: colour and size tokens as CSS variables, and base styles for controls.
// Components use the variables (`var(--panel)`) in their own scoped styles instead of literal colours.

const TOKENS = `
:root {
  --bg: #0f1216;
  --map-bg: #0b0d10;
  --panel: #171b21;
  --panel-2: #141820;
  --raised: #1d222a;
  --input: #11151b;
  --border: #2a313b;
  --border-strong: #3a4350;
  --text: #e3e7ee;
  --text-2: #c9d1dc;
  --muted: #98a2b3;
  --faint: #7d8796;
  --accent: #3d7eff;
  --accent-soft: #22324f;
  --accent-text: #8ab4ff;
  --focus: #5b93ff;
  --warn: #f5a524;
  --danger-bg: #2a1b1d;
  --danger-border: #5a2a2a;
  --danger-text: #ffb4b4;
  --selection: #f5c542;
  --link-line: #5ccfe6;
  --list-line: #7dff8a;
  --mass: #ff9f43;
  --origin: #7fd4ff;
  --radius-s: 4px;
  --radius: 6px;
  --radius-l: 10px;
  --control-h: 28px;
  --font: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.35 var(--font); }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
input[type="checkbox"] { accent-color: var(--accent); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; border: 2px solid var(--panel); }
::-webkit-scrollbar-track { background: transparent; }
`;

let installed = false;

/** Adds the tokens and base styles to the page once. */
export function installTheme(): void {
    if (installed || typeof document === "undefined") return;
    installed = true;
    const el = document.createElement("style");
    el.dataset.theme = "ss14mapper";
    el.textContent = TOKENS;
    document.head.prepend(el);
}
