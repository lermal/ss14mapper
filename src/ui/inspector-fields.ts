// Component fields as the inspector shows and writes them, without DOM: which components an entity has, each
// field's value (map override, else prototype, else default), editors' text ↔ YAML, and the override text an edit
// produces (only the fields that differ from the prototype).
import { formatAngle, formatFloat } from "../map/document";
import { normalizeColor } from "../map/decals";
import { entryText, formatScalar, parseDocument, toPlain, type YEntry } from "../map/yaml";
import type { ComponentSchemas, FieldKind, FieldSchema } from "../pack/format";

/** Field holding the C# type of a tagged mapping in prototype data (`!type:Name`). */
const TYPE_FIELD = "!type";

/** A field of a component as the panel shows it. */
export interface FieldView {
    name: string;
    kind: FieldKind;
    /** C# type, or "?" for a field the schema does not know. */
    type: string;
    schema?: FieldSchema;
    /** The map's value (plain data) and its YAML text without the key, when the map overrides the field. */
    override?: { value: unknown; text: string };
    /** The prototype's value, when the prototype sets the field. */
    proto?: unknown;
    /** The schema's default as YAML text. */
    default?: string;
}

export interface ComponentView {
    type: string;
    /** The prototype has the component. */
    inPrototype: boolean;
    /** The map has an override of it (possibly without fields). */
    overridden: boolean;
    /** The schema knows the component. */
    known: boolean;
}

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);

/** Components of an entity: the prototype's and the map's, sorted by name. */
export function componentViews(proto: Record<string, unknown>, overrides: ReadonlyArray<{ type: string }>, schemas: ComponentSchemas | null): ComponentView[] {
    const names = new Set([...Object.keys(proto), ...overrides.map((o) => o.type)]);
    const over = new Set(overrides.map((o) => o.type));
    return [...names].sort(byName).map((type) => ({ type, inPrototype: type in proto, overridden: over.has(type), known: !!schemas?.components[type] }));
}

/** Entries of an override's YAML text (one per field, each with its source text). */
export function overrideEntries(text: string): YEntry[] {
    if (text.trim() === "" || text.trim() === "{}") return [];
    return parseDocument(text + "\n").root.entries;
}

/** The YAML of an entry's value without the key: "x" for `key: x`, the dedented block for `key:\n  a: 1`. */
export function valueText(entry: YEntry): string {
    const full = entryText(entry, 0).replace(/^(?:[ \t]*(?:#.*)?\n)*/, "");
    const colon = full.indexOf(":");
    const first = full.slice(colon + 1, full.indexOf("\n") === -1 ? undefined : full.indexOf("\n")).trim();
    const rest = full.indexOf("\n") === -1 ? [] : full.slice(full.indexOf("\n") + 1).split("\n");
    const indent = Math.min(...rest.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const body = rest.map((l) => l.slice(Number.isFinite(indent) ? Math.min(indent, l.length - l.trimStart().length) : 0));
    return [first, ...body].filter((l, i) => i > 0 || l !== "").join("\n");
}

/** Base field every component has in the game, which mappers never edit: listed only when the map overrides it. */
export const HIDDEN_FIELD = "netsync";

/** Fields of a component: the schema's, plus any the prototype or the map sets that the schema lacks; sorted by name. The hidden field is left out unless the map overrides it. */
export function fieldViews(schema: readonly FieldSchema[] | undefined, proto: Record<string, unknown> | undefined, overrideText: string | undefined): FieldView[] {
    const out = new Map<string, FieldView>();
    for (const s of schema ?? []) out.set(s.name, { name: s.name, kind: s.kind, type: s.type, schema: s, ...(s.default !== undefined ? { default: s.default } : {}) });
    for (const [k, v] of Object.entries(proto ?? {})) {
        if (k === "type") continue;
        const f = out.get(k) ?? { name: k, kind: guessKind(v), type: "?" };
        f.proto = v;
        out.set(k, f);
    }
    for (const e of overrideText === undefined ? [] : overrideEntries(overrideText)) {
        const k = e.key.value;
        const f = out.get(k) ?? { name: k, kind: guessKind(toPlain(e.value)), type: "?" };
        f.override = { value: toPlain(e.value), text: valueText(e) };
        out.set(k, f);
    }
    return [...out.values()].filter((f) => f.name !== HIDDEN_FIELD || f.override !== undefined).sort((a, b) => byName(a.name, b.name));
}

/** Kind of a value of a field the schema does not know: scalars are edited as text, the rest as YAML. */
function guessKind(v: unknown): FieldKind {
    return v !== null && typeof v === "object" ? "other" : "string";
}

/** Kinds edited as YAML text. */
export const COMPLEX = new Set<FieldKind>(["list", "dict", "sound", "other"]);

/** YAML of plain data in the game's style: block mappings, sequences under a key not indented, `!type:` tags. */
export function toYaml(value: unknown, indent = 0): string {
    const pad = " ".repeat(indent);
    if (Array.isArray(value)) {
        if (!value.length) return pad + "[]";
        return value
            .map((v) => {
                if (v !== null && typeof v === "object" && Object.keys(v).length) {
                    const tag = !Array.isArray(v) ? (v as Record<string, unknown>)[TYPE_FIELD] : undefined;
                    const inner = toYaml(tagless(v), indent + 2);
                    if (tag !== undefined) return `${pad}- !type:${tag}${inner.trim() === "{}" ? "" : "\n" + inner}`;
                    return `${pad}- ${inner.slice(indent + 2)}`;
                }
                return `${pad}- ${scalarYaml(v)}`;
            })
            .join("\n");
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>).filter(([k]) => k !== TYPE_FIELD);
        if (!entries.length) return pad + "{}";
        return entries
            .map(([k, v]) => {
                const key = pad + formatScalar(k) + ":";
                if (v === null || typeof v !== "object") return `${key} ${scalarYaml(v)}`;
                const tag = !Array.isArray(v) ? (v as Record<string, unknown>)[TYPE_FIELD] : undefined;
                const inner = toYaml(tagless(v), Array.isArray(v) ? indent : indent + 2);
                const head = tag !== undefined ? `${key} !type:${tag}` : key;
                if (inner.trim() === "{}" || inner.trim() === "[]") return tag !== undefined && inner.trim() === "{}" ? head : `${head} ${inner.trim()}`;
                return `${head}\n${inner}`;
            })
            .join("\n");
    }
    return pad + scalarYaml(value);
}

function tagless(v: object): unknown {
    if (Array.isArray(v)) return v;
    const { [TYPE_FIELD]: _tag, ...rest } = v as Record<string, unknown>;
    return rest;
}

function scalarYaml(v: unknown): string {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return String(v);
    const s = String(v);
    // strings that would read back as another type are quoted
    if (/^(true|false|null|~|[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)$/i.test(s)) return `'${s}'`;
    return formatScalar(s);
}

// ---------------------------------------------------------------------------------------------
// Values

/** "#RRGGBBAA" of a colour as the game reads it (hex with or without alpha, or a name of the engine's colours). */
export function colorHex(v: unknown, colors: Record<string, readonly number[]> = {}): string | null {
    if (typeof v !== "string") return null;
    try {
        return normalizeColor(v);
    } catch {
        const c = colors[v.trim().toLowerCase()];
        return c ? "#" + c.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase() : null;
    }
}

/** Radians of an Angle as written ("1.57 rad", "90 deg", or a bare number of radians). */
export function angleRadians(v: unknown): number | null {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return null;
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(rad|deg)?\s*$/.exec(v);
    if (!m) return null;
    return m[2] === "deg" ? (Number(m[1]) * Math.PI) / 180 : Number(m[1]);
}

/** [x, y] of a Vector2 as written ("1.5,-2"). */
export function vector(v: unknown): [number, number] | null {
    if (typeof v !== "string") return null;
    const parts = v.split(",").map((p) => p.trim());
    if (parts.length !== 2 || parts.some((p) => !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(p))) return null;
    return [Number(parts[0]), Number(parts[1])];
}

/** Seconds of a TimeSpan as the engine reads it: seconds, or a number with a unit (`500ms`, `2s`, `1.5m`, `1h`). */
export function seconds(v: unknown): number | null {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return null;
    const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(ms|s|m|h)?\s*$/.exec(v);
    if (!m) return null;
    return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2] ?? "s"]!;
}

const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : typeof v === "string" && /^(true|false)$/i.test(v) ? v.toLowerCase() === "true" : null);
const asNumber = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** A field's YAML value (a default from the schema, an editor's output) as plain data. */
export function defaultValue(text: string): unknown {
    try {
        return toPlain(parseDocument(entryFor("v", text) + "\n").root.entries[0]!.value);
    } catch {
        return text;
    }
}

/** Whether two values of a field are the same for the game (`0.50` and `0.5`, `#fff` and `#FFFFFFFF`, `True` and `true`). */
export function sameValue(kind: FieldKind, a: unknown, b: unknown, colors?: Record<string, readonly number[]>): boolean {
    if (a === undefined || b === undefined) return a === b;
    switch (kind) {
        case "bool":
            return asBool(a) !== null && asBool(a) === asBool(b);
        case "int":
        case "float":
            return asNumber(a) !== null && asNumber(a) === asNumber(b);
        case "color":
            return colorHex(a, colors) !== null && colorHex(a, colors) === colorHex(b, colors);
        case "angle": {
            const x = angleRadians(a), y = angleRadians(b);
            return x !== null && y !== null && Math.abs(x - y) < 1e-9;
        }
        case "vector2":
        case "vector2i": {
            const x = vector(a), y = vector(b);
            return !!x && !!y && x[0] === y[0] && x[1] === y[1];
        }
        case "timespan": {
            const x = seconds(a), y = seconds(b);
            return x !== null && x === y;
        }
        case "string":
        case "enum":
        case "proto":
        case "entity":
            return (a === null) === (b === null) && String(a) === String(b);
        default:
            return deepEqual(a, b);
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
        // scalars as the YAML core schema reads them on either side ("5" in one place, 5 in the other)
        return a !== null && b !== null && typeof a !== "object" && typeof b !== "object" && String(a).toLowerCase() === String(b).toLowerCase();
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
    const ka = Object.keys(a).filter((k) => k !== TYPE_FIELD);
    const kb = Object.keys(b).filter((k) => k !== TYPE_FIELD);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** What the field's value is for the game, and where it comes from. */
export function effective(f: FieldView): { value: unknown; source: "map" | "prototype" | "default" | "none" } {
    if (f.override) return { value: f.override.value, source: "map" };
    if (f.proto !== undefined) return { value: f.proto, source: "prototype" };
    if (f.default !== undefined) return { value: defaultValue(f.default), source: "default" };
    return { value: null, source: "none" };
}

/** The value the field has without the map's override (prototype, else default). */
export function baseValue(f: FieldView): unknown {
    return f.proto !== undefined ? f.proto : f.default !== undefined ? defaultValue(f.default) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Editors' values → YAML

/** A double as .NET writes it. */
const double = (v: number) => formatAngle(v).slice(0, -" rad".length);

/**
 * YAML of a value typed into a field's editor, in the game's style; throws with a short message when the input is
 * not a value of the field's type. `input` is what the editor holds: a boolean for bool, degrees for Angle,
 * [x, y] for vectors, "#RRGGBBAA" for colours, YAML text for complex kinds, text otherwise.
 */
export function formatValue(f: Pick<FieldView, "kind" | "type">, input: unknown): string {
    const t = f.type.replace(/\?$/, "");
    switch (f.kind) {
        case "bool":
            return input ? "True" : "False";
        case "int": {
            const s = String(input).trim();
            if (!/^[-+]?\d+$/.test(s)) throw new Error("Expected a whole number");
            if (/^(uint|ulong|ushort|byte)$/.test(t) && s.startsWith("-")) throw new Error("Expected a positive number");
            return String(Number(s));
        }
        case "float": {
            const n = asNumber(String(input).trim());
            if (n === null) throw new Error("Expected a number");
            return t === "float" ? formatFloat(n) : double(n);
        }
        case "vector2":
        case "vector2i": {
            const [x, y] = (input as [unknown, unknown]).map((v) => asNumber(String(v).trim()));
            if (x === null || y === null || x === undefined || y === undefined) throw new Error("Expected two numbers");
            if (f.kind === "vector2i" && (!Number.isInteger(x) || !Number.isInteger(y))) throw new Error("Expected whole numbers");
            return f.kind === "vector2i" ? `${x},${y}` : `${formatFloat(x)},${formatFloat(y)}`;
        }
        case "angle": {
            const deg = asNumber(String(input).trim());
            if (deg === null) throw new Error("Expected degrees");
            return formatAngle(deg === 0 ? 0 : (deg * Math.PI) / 180);
        }
        case "color": {
            const hex = colorHex(String(input));
            if (!hex) throw new Error("Expected a colour (#RRGGBBAA)");
            return formatScalar(hex);
        }
        case "timespan": {
            const s = seconds(String(input));
            if (s === null) throw new Error("Expected seconds (or 500ms, 2m, 1h)");
            return double(Number(s.toPrecision(15)));
        }
        case "entity": {
            const s = String(input).trim();
            if (s === "invalid" || s === "") return "invalid";
            if (!/^\d+$/.test(s)) throw new Error("Expected an entity uid");
            return s;
        }
        case "string":
        case "enum":
        case "proto":
            return formatScalar(String(input));
        default:
            return String(input);
    }
}

/** A field's entry text: `key: value`, or `key:` then the YAML block (sequences unindented, as the game writes them). */
export function entryFor(key: string, yaml: string): string {
    const lines = yaml.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
    const k = formatScalar(key) + ":";
    if (lines.length === 1) return lines[0] === "" ? k : `${k} ${lines[0]}`;
    // a tag alone on the first line stays on the key's line
    if (/^!\S+$/.test(lines[0]!.trim())) return `${k} ${lines[0]!.trim()}\n` + indentBlock(lines.slice(1), 2);
    return `${k}\n` + indentBlock(lines, lines[0]!.startsWith("-") ? 0 : 2);
}

function indentBlock(lines: string[], n: number): string {
    return lines.map((l) => (l.trim() ? " ".repeat(n) + l : l)).join("\n");
}

/**
 * The override text after setting a field to `yaml` (or resetting it with null): the other fields keep their text;
 * a value equal to the prototype's is dropped, as the game saves only differences. New fields go in the schema's
 * order. Returns null when the override should be removed: no fields left on a component of the prototype.
 */
export function writeField(
    overrideText: string | undefined,
    field: FieldView,
    yaml: string | null,
    order: readonly string[],
    inPrototype: boolean,
    colors?: Record<string, readonly number[]>,
): string | null {
    const entries = overrideText === undefined ? [] : overrideEntries(overrideText);
    const texts = entries.map((e) => ({ key: e.key.value, text: entryText(e, 0) }));
    const at = texts.findIndex((e) => e.key === field.name);
    let next: string | null = yaml;
    if (next !== null) {
        const base = baseValue(field);
        if (base !== undefined && sameValue(field.kind, defaultValue(next), base, colors)) next = null;
    }
    if (next === null) {
        if (at !== -1) texts.splice(at, 1);
    } else {
        const text = entryFor(field.name, next);
        if (at !== -1) {
            // comments and blank lines before the field stay
            const lead = /^((?:[ \t]*(?:#.*)?\n)*)/.exec(texts[at]!.text)![1]!;
            texts[at] = { key: field.name, text: lead + text };
        } else {
            const rank = (k: string) => {
                const i = order.indexOf(k);
                return i === -1 ? Infinity : i;
            };
            let pos = texts.length;
            if (rank(field.name) !== Infinity) {
                const after = texts.findIndex((e) => rank(e.key) > rank(field.name));
                if (after !== -1) pos = after;
            }
            texts.splice(pos, 0, { key: field.name, text });
        }
    }
    if (!texts.length) return inPrototype ? null : "";
    return texts.map((t) => t.text).join("\n");
}

/** Text an editor starts with for a field's current value (see `formatValue` for what each kind holds). */
export function editorText(f: FieldView, value: unknown, colors?: Record<string, readonly number[]>): string {
    switch (f.kind) {
        case "angle": {
            const r = angleRadians(value);
            return r === null ? "" : String(Number(((r * 180) / Math.PI).toFixed(6)));
        }
        case "color":
            return colorHex(value, colors) ?? "";
        case "timespan": {
            const s = seconds(value);
            return s === null ? (value === null ? "" : String(value)) : String(s);
        }
        default:
            if (COMPLEX.has(f.kind)) return f.override && value === f.override.value ? f.override.text : value === null || value === undefined ? "" : toYaml(value);
            return value === null || value === undefined ? "" : typeof value === "boolean" ? (value ? "True" : "False") : String(value);
    }
}
