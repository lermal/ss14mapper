// Data fields of every registered component, read from C# sources as text (nothing is compiled or executed):
// `[DataField]` members with their YAML name, C# type, a kind the editor has a value editor for, the default when
// the initializer is a simple literal, `[ViewVariables]` access and whether the field is required.
import { formatAngle, formatFloat } from "../../src/map/document";
import type { ComponentSchemas, EnumSchema, FieldKind, FieldSchema } from "../../src/pack/format";

export interface SourceFile {
    file: string;
    text: string;
}

/** A class (all its partial declarations merged) as found in the sources. */
interface ClassInfo {
    name: string;
    attributes: string[];
    bases: string[];
    members: Member[];
}

interface Member {
    attributes: string[];
    modifiers: Set<string>;
    type: string;
    name: string;
    init: string | null;
}

const MODIFIERS = new Set([
    "public", "private", "protected", "internal", "static", "readonly", "const", "required", "virtual", "override",
    "abstract", "sealed", "new", "volatile", "unsafe", "extern", "partial", "event", "file",
]);

/**
 * The source with comments and preprocessor lines blanked (same length, line breaks kept), and a copy in which the
 * contents of string and char literals are blanked too, for scanning structure.
 */
export function blank(src: string): { code: string; masked: string } {
    const code = src.split("");
    const masked = src.split("");
    const n = src.length;
    let i = 0;
    const space = (from: number, to: number, both: boolean) => {
        for (let k = from; k < to; k++) {
            if (src[k] === "\n") continue;
            masked[k] = " ";
            if (both) code[k] = " ";
        }
    };
    let lineStart = true;
    while (i < n) {
        const c = src[i]!;
        const d = src[i + 1];
        if (lineStart && /\s/.test(c) && c !== "\n") {
            i++;
            continue;
        }
        if (lineStart && c === "#") {
            const end = src.indexOf("\n", i);
            space(i, end === -1 ? n : end, true);
            i = end === -1 ? n : end;
            continue;
        }
        lineStart = c === "\n";
        if (c === "/" && d === "/") {
            const end = src.indexOf("\n", i);
            space(i, end === -1 ? n : end, true);
            i = end === -1 ? n : end;
        } else if (c === "/" && d === "*") {
            const end = src.indexOf("*/", i + 2);
            const stop = end === -1 ? n : end + 2;
            space(i, stop, true);
            i = stop;
        } else if (c === '"' && src.startsWith('"""', i)) {
            const end = src.indexOf('"""', i + 3);
            const stop = end === -1 ? n : end + 3;
            space(i + 3, stop - 3, false);
            i = stop;
        } else if (c === '"' || ((c === "@" || c === "$") && (d === '"' || ((d === "@" || d === "$") && src[i + 2] === '"')))) {
            const verbatim = c === "@" || d === "@";
            let k = src.indexOf('"', i) + 1;
            const open = k;
            while (k < n) {
                if (verbatim && src[k] === '"' && src[k + 1] === '"') k += 2;
                else if (!verbatim && src[k] === "\\") k += 2;
                else if (src[k] === '"' || (!verbatim && src[k] === "\n")) break;
                else k++;
            }
            space(open, k, false);
            i = k + 1;
        } else if (c === "'") {
            let k = i + 1;
            while (k < n && src[k] !== "'" && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
            space(i + 1, k, false);
            i = k + 1;
        } else i++;
    }
    return { code: code.join(""), masked: masked.join("") };
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/** Index of the bracket closing the one at `at` (masked text), or -1. Angle brackets are not tracked. */
function closing(masked: string, at: number): number {
    const stack: string[] = [];
    for (let k = at; k < masked.length; k++) {
        const c = masked[k]!;
        if (c === "(" || c === "[" || c === "{") stack.push(OPEN[c]!);
        else if (c === ")" || c === "]" || c === "}") {
            if (stack.pop() !== c) return -1;
            if (!stack.length) return k;
        }
    }
    return -1;
}

/** Splits at top-level commas (brackets and angle brackets nest). */
export function splitTop(s: string, sep = ","): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let k = 0; k < s.length; k++) {
        const c = s[k]!;
        if (quote) {
            if (c === "\\") k++;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if ("([{<".includes(c)) depth++;
        else if (")]}>".includes(c)) depth--;
        else if (c === sep && depth === 0) {
            out.push(s.slice(start, k));
            start = k + 1;
        }
    }
    out.push(s.slice(start));
    return out.map((p) => p.trim()).filter((p) => p !== "");
}

/** Attribute lists (`[A, B(x)]`) immediately before `at`, walking back over modifiers; returns them in source order. */
function attributesBefore(masked: string, code: string, at: number): string[] {
    const found: string[] = [];
    let k = at;
    for (;;) {
        while (k > 0 && /\s/.test(masked[k - 1]!)) k--;
        const word = /(\w+)$/.exec(masked.slice(Math.max(0, k - 20), k));
        if (word && MODIFIERS.has(word[1]!)) {
            k -= word[1]!.length;
            continue;
        }
        if (masked[k - 1] !== "]") break;
        let depth = 0;
        let j = k - 1;
        for (; j >= 0; j--) {
            if (masked[j] === "]") depth++;
            else if (masked[j] === "[") {
                depth--;
                if (depth === 0) break;
            }
        }
        if (j < 0) break;
        found.unshift(...splitTop(code.slice(j + 1, k - 1)));
        k = j;
    }
    return found;
}

const attrName = (a: string) => /^(?:\w+\s*:\s*)?(?:[\w.]+\.)?(\w+?)(?:Attribute)?\s*(?:\(|$)/.exec(a.trim())?.[1] ?? "";
const attrArgs = (a: string) => {
    const open = a.indexOf("(");
    return open === -1 ? [] : splitTop(a.slice(open + 1, a.lastIndexOf(")")));
};

/** Short form of a C# type: namespaces dropped, spacing normalised (`Dictionary<string, List<int>>`). */
export function shortType(t: string): string {
    return t
        .replace(/global::/g, "")
        .replace(/\s+/g, "")
        .replace(/\b(?:\w+\.)+(\w+)/g, "$1")
        .replace(/,/g, ", ");
}

/** Members of a class body: segments ending at a top-level `;` or block, with their leading attributes. */
function members(code: string, masked: string, from: number, to: number): Member[] {
    const out: Member[] = [];
    let start = from;
    let k = from;
    const segment = (end: number) => {
        const m = member(code.slice(start, end), masked.slice(start, end));
        if (m) out.push(m);
        start = end + 1;
    };
    while (k < to) {
        const c = masked[k]!;
        if (c === ";") {
            segment(k);
            k++;
        } else if (c === "{" || c === "(" || c === "[") {
            const end = closing(masked, k);
            if (end === -1 || end > to) return out;
            k = end + 1;
            if (c === "{") {
                // a property's accessors or an object initializer may be followed by `= value;` or `;`
                let j = k;
                while (j < to && /\s/.test(masked[j]!)) j++;
                if (masked[j] !== "=" && masked[j] !== ";" && masked[j] !== "," && masked[j] !== ")") segment(k - 1);
            }
        } else k++;
    }
    return out;
}

function member(code: string, masked: string): Member | null {
    let k = 0;
    const attributes: string[] = [];
    for (;;) {
        while (k < masked.length && /\s/.test(masked[k]!)) k++;
        if (masked[k] !== "[") break;
        const end = closing(masked, k);
        if (end === -1) return null;
        attributes.push(...splitTop(code.slice(k + 1, end)));
        k = end + 1;
    }
    if (!attributes.length) return null;
    const rest = masked.slice(k);
    if (/\b(class|struct|enum|record|interface|delegate)\b/.test(rest.split(/[={]/)[0]!)) return null;
    // the declaration head ends at `=` (not `=>`), `{`, `(` after the name, or the end
    let head = rest.length;
    let depth = 0;
    let init: string | null = null;
    for (let j = 0; j < rest.length; j++) {
        const c = rest[j]!;
        if (c === "<") depth++;
        else if (c === ">") depth--;
        else if (depth === 0 && (c === "{" || (c === "=" && rest[j + 1] !== ">") || (c === "=" && rest[j + 1] === ">"))) {
            head = j;
            break;
        } else if (depth === 0 && c === "(") {
            // a tuple type at the start, or a method's parameters after its name
            if (rest.slice(0, j).trim() === "" || /^[\w\s]*$/.test(rest.slice(0, j)) && rest.slice(0, j).trim().split(/\s+/).every((w) => MODIFIERS.has(w))) {
                const end = closing(rest, j);
                if (end === -1) return null;
                j = end;
                continue;
            }
            return null;
        }
    }
    const words = code.slice(k, k + head).trim();
    const modifiers = new Set<string>();
    let decl = words;
    for (;;) {
        const m = /^(\w+)\s+/.exec(decl);
        if (!m || !MODIFIERS.has(m[1]!)) break;
        modifiers.add(m[1]!);
        decl = decl.slice(m[0].length);
    }
    if (modifiers.has("static") || modifiers.has("const")) return null;
    const name = /(\w+)\s*$/.exec(decl);
    if (!name) return null;
    const type = decl.slice(0, name.index).trim();
    if (!type) return null;
    // the initializer: after `=` at the head, or after the accessor block
    const tail = rest.slice(head);
    const tailCode = code.slice(k + head);
    if (tail.startsWith("=") && !tail.startsWith("=>")) init = tailCode.slice(1).trim();
    else if (tail.startsWith("{")) {
        const end = closing(tail, 0);
        const after = end === -1 ? "" : tail.slice(end + 1);
        const eq = after.search(/\S/);
        if (eq !== -1 && after[eq] === "=" && after[eq + 1] !== ">") init = tailCode.slice(end + 1 + eq + 1).trim();
    }
    return { attributes, modifiers, type: shortType(type), name: name[1]!, init: init?.replace(/;\s*$/, "").trim() || null };
}

/** Classes, enums and prototype type names declared in the sources. */
export function scan(files: readonly SourceFile[]): {
    classes: Map<string, ClassInfo>;
    enums: Map<string, EnumSchema>;
    prototypeTypes: Map<string, string>;
} {
    const classes = new Map<string, ClassInfo>();
    const enums = new Map<string, EnumSchema>();
    const prototypeTypes = new Map<string, string>();
    const decl = /\b(class|struct|record|interface)\s+(\w+)\s*(<[^{};()]*>)?\s*(\([^)]*\))?\s*(?::\s*([^{;]+?))?\s*(?:where\b[^{;]*)?([{;])/g;
    for (const f of files) {
        if (!f.text.includes("class ") && !f.text.includes("enum ")) continue;
        const { code, masked } = blank(f.text);
        for (const m of masked.matchAll(decl)) {
            const open = m.index + m[0].length - 1;
            // `class X : Base;` has no body
            const end = m[6] === ";" ? open : closing(masked, open);
            if (end === -1) continue;
            const name = m[2]!;
            const attributes = attributesBefore(masked, code, m.index);
            if (attributes.some((a) => attrName(a) === "Prototype")) {
                const id = /^Prototype\s*\(\s*"([^"]+)"/.exec(attributes.find((a) => attrName(a) === "Prototype")!.trim());
                prototypeTypes.set(name, id ? id[1]! : prototypeName(name));
            }
            if (m[1] !== "class" && m[1] !== "record") continue;
            const bases = m[5] ? splitTop(m[5]).map((b) => shortType(b).replace(/<.*$/, "")) : [];
            const info = classes.get(name) ?? { name, attributes: [], bases: [], members: [] };
            info.attributes.push(...attributes);
            for (const b of bases) if (!info.bases.includes(b)) info.bases.push(b);
            if (end > open && f.text.includes("DataField")) info.members.push(...members(code, masked, open + 1, end));
            classes.set(name, info);
        }
        for (const m of masked.matchAll(/\benum\s+(\w+)\s*(?::\s*\w+)?\s*\{/g)) {
            const open = m.index + m[0].length - 1;
            const end = closing(masked, open);
            if (end === -1) continue;
            const flags = attributesBefore(masked, code, m.index).some((a) => attrName(a) === "Flags");
            const names = splitTop(code.slice(open + 1, end))
                .map((p) => p.replace(/^\[[^\]]*\]\s*/g, "").split("=")[0]!.trim())
                .filter((p) => /^\w+$/.test(p));
            const old = enums.get(m[1]!);
            const merged = old ? [...new Set([...old.members, ...names])] : names;
            enums.set(m[1]!, { members: merged, ...(flags || old?.flags ? { flags: true as const } : {}) });
        }
    }
    return { classes, enums, prototypeTypes };
}

/** YAML type of a prototype class without a `[Prototype("name")]`: the class name without `Prototype`, camelCase. */
function prototypeName(cls: string): string {
    const n = cls.replace(/Prototype$/, "");
    return n.charAt(0).toLowerCase() + n.slice(1);
}

const INT = new Set(["int", "uint", "long", "ulong", "short", "ushort", "byte", "sbyte", "Int32", "UInt32", "Int64", "UInt64", "Int16", "UInt16", "Byte", "SByte"]);
const FLOAT = new Set(["float", "double", "decimal", "Single", "Double", "FixedPoint2"]);
const STRING = new Set(["string", "String", "ResPath", "LocId"]);
const LIST = /^(List|IList|IReadOnlyList|ICollection|IReadOnlyCollection|IEnumerable|HashSet|ISet|IReadOnlySet|SortedSet|ImmutableList|ImmutableArray|Queue|Stack|LinkedList|FrozenSet)<(.*)>$/;
const DICT = /^(Dictionary|IDictionary|IReadOnlyDictionary|SortedDictionary|FrozenDictionary|ImmutableDictionary|OrderedDictionary)<(.*)>$/;

interface Kind {
    kind: FieldKind;
    proto?: string;
    enum?: string;
}

/** Generic argument of `Name<T>` in a serializer reference (`typeof(PrototypeIdSerializer<TagPrototype>)`). */
function serializerArg(serializer: string, name: RegExp): string | null {
    const m = new RegExp(`\\b(?:${name.source})<([^>]*)>`).exec(serializer);
    return m ? shortType(m[1]!).split(", ").at(-1)! : null;
}

/** The editor's kind of a C# type (with the field's custom serializer, when it has one). */
export function kindOf(type: string, serializer: string | null, enums: ReadonlyMap<string, EnumSchema>, protoType: (cls: string) => string): Kind {
    const t = type.replace(/\?$/, "");
    if (serializer) {
        const one = serializerArg(serializer, /PrototypeIdSerializer/);
        if (one) return { kind: "proto", proto: protoType(one) };
        if (/PrototypeId(List|HashSet|Array)Serializer|PrototypeIdValueDictionarySerializer/.test(serializer) || /Prototype.*Dictionary/.test(serializer)) return { kind: LIST.test(t) || t.endsWith("[]") ? "list" : "dict" };
        if (/TimeOffsetSerializer/.test(serializer)) return { kind: "timespan" };
        if (/FlagSerializer|ConstantSerializer/.test(serializer)) return { kind: "other" };
    }
    if (t === "bool" || t === "Boolean") return { kind: "bool" };
    if (INT.has(t)) return { kind: "int" };
    if (FLOAT.has(t)) return { kind: "float" };
    if (STRING.has(t)) return { kind: "string" };
    if (t === "Color") return { kind: "color" };
    if (t === "Vector2") return { kind: "vector2" };
    if (t === "Vector2i") return { kind: "vector2i" };
    if (t === "Angle") return { kind: "angle" };
    if (t === "EntityUid" || t === "NetEntity") return { kind: "entity" };
    if (t === "TimeSpan") return { kind: "timespan" };
    if (t === "EntProtoId" || /^EntProtoId<.*>$/.test(t)) return { kind: "proto", proto: "entity" };
    const proto = /^ProtoId<(\w+)>$/.exec(t);
    if (proto) return { kind: "proto", proto: protoType(proto[1]!) };
    if (/^Sound(Path|Collection)?Specifier$/.test(t)) return { kind: "sound" };
    if (LIST.test(t) || t.endsWith("[]")) return { kind: "list" };
    if (DICT.test(t)) return { kind: "dict" };
    if (enums.has(t)) {
        const e = enums.get(t)!;
        return e.flags ? { kind: "other" } : { kind: "enum", enum: t };
    }
    return { kind: "other" };
}

const num = (s: string): number | null => {
    const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[fFdDmMuUlL]*$/.exec(s.trim());
    return m ? Number(m[1]) : null;
};
const hex = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).toUpperCase().padStart(2, "0");
const bool = (v: boolean) => (v ? "True" : "False");
/** A double as .NET writes it (the number part of `formatAngle`). */
const double = (v: number) => formatAngle(v).slice(0, -" rad".length);

function stringLiteral(s: string): string | null {
    const m = /^@?"((?:[^"\\]|\\.)*)"$/.exec(s.trim());
    if (!m) return null;
    return m[1]!.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", "0": "\0" })[c] ?? c);
}

function colorDefault(init: string, colors: ReadonlyMap<string, readonly number[]>): string | null {
    const named = /^(?:Color\.)(\w+)$/.exec(init);
    if (named) {
        const c = colors.get(named[1]!.toLowerCase());
        return c ? "#" + c.map(hex).join("") : null;
    }
    const fromHex = /^Color\.FromHex\(\s*"#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})"\s*\)$/.exec(init);
    if (fromHex) return "#" + (fromHex[1]!.length === 6 ? fromHex[1]! + "FF" : fromHex[1]!).toUpperCase();
    const ctor = /^new(?:\s+Color)?\s*\(([^()]*)\)$/.exec(init);
    if (ctor) {
        const parts = splitTop(ctor[1]!).map((p) => p.replace(/^\w+:\s*/, ""));
        const values = parts.map(num);
        if ((values.length === 3 || values.length === 4) && values.every((v) => v !== null)) {
            const bytes = parts.every((p) => /^\d+$/.test(p.trim())) && parts.length >= 3;
            const v = values.map((x) => (bytes ? x! / 255 : x!));
            if (v.length === 3) v.push(1);
            return "#" + v.map(hex).join("");
        }
    }
    return null;
}

/** YAML text of a field's default: from a simple literal initializer, or C#'s default for value types. */
export function defaultOf(kind: Kind, type: string, init: string | null, enums: ReadonlyMap<string, EnumSchema>, colors: ReadonlyMap<string, readonly number[]>): string | undefined {
    const nullable = type.endsWith("?");
    const i = init?.replace(/!$/, "").trim() ?? null;
    if (i === "null") return undefined;
    if (i === null || i === "default") {
        if (nullable) return undefined;
        switch (kind.kind) {
            case "bool": return "False";
            case "int": case "float": return "0";
            case "vector2": case "vector2i": return "0,0";
            case "angle": return "0 rad";
            case "timespan": return "0";
            case "color": return "#00000000";
            case "entity": return type === "EntityUid" ? "invalid" : undefined;
            case "enum": return enums.get(kind.enum!)?.members[0];
            default: return undefined;
        }
    }
    switch (kind.kind) {
        case "bool": return i === "true" ? "True" : i === "false" ? "False" : undefined;
        case "int": {
            const v = num(i);
            return v !== null && Number.isInteger(v) ? String(v) : /^0x[0-9a-fA-F]+$/.test(i) ? String(parseInt(i, 16)) : undefined;
        }
        case "float": {
            const v = num(i.replace(/^FixedPoint2\.New\((.*)\)$/, "$1"));
            if (v === null) return undefined;
            return type.replace(/\?$/, "") === "float" ? formatFloat(v) : double(v);
        }
        case "string": case "proto": {
            if (i === "string.Empty" || i === "String.Empty") return "";
            return stringLiteral(i) ?? undefined;
        }
        case "enum": {
            const m = /^(?:\w+\.)*(\w+)$/.exec(i);
            const e = enums.get(kind.enum!);
            return m && e?.members.includes(m[1]!) ? m[1]! : undefined;
        }
        case "color": return colorDefault(i, colors) ?? undefined;
        case "vector2": case "vector2i": {
            if (/^Vector2i?\.Zero$/.test(i)) return "0,0";
            if (/^Vector2i?\.One$/.test(i)) return "1,1";
            const m = /^new(?:\s+Vector2i?)?\s*\(([^()]*)\)$/.exec(i);
            const v = m ? splitTop(m[1]!).map(num) : [];
            return v.length === 2 && v.every((x) => x !== null) ? v.map((x) => formatFloat(x!)).join(",") : undefined;
        }
        case "angle": {
            if (i === "Angle.Zero" || i === "new()" || i === "new Angle()") return "0 rad";
            const deg = /^Angle\.FromDegrees\(([^()]*)\)$/.exec(i);
            if (deg && num(deg[1]!) !== null) return formatAngle((num(deg[1]!)! * Math.PI) / 180);
            const rad = /^new(?:\s+Angle)?\s*\(([^()]*)\)$/.exec(i);
            if (rad && num(rad[1]!) !== null) return formatAngle(num(rad[1]!)!);
            return undefined;
        }
        case "timespan": {
            if (i === "TimeSpan.Zero") return "0";
            const m = /^TimeSpan\.From(Milliseconds|Seconds|Minutes|Hours|Days)\(([^()]*)\)$/.exec(i);
            const v = m ? num(m[2]!) : null;
            if (v === null) return undefined;
            const scale = { Milliseconds: 0.001, Seconds: 1, Minutes: 60, Hours: 3600, Days: 86400 }[m![1] as "Seconds"];
            return double(Number((v * scale).toPrecision(15)));
        }
        case "list":
            return /^(new(\s*[\w<>, ]+)?\s*\(\s*\)|\[\s*\]|new(\s*[\w<>, ]+)?\s*(\(\s*\))?\s*\{\s*\}|Array\.Empty<.*>\(\))$/.test(i) ? "[]" : undefined;
        case "dict":
            return /^(new(\s*[\w<>, ]+)?\s*\(\s*\)|\[\s*\]|new(\s*[\w<>, ]+)?\s*(\(\s*\))?\s*\{\s*\})$/.test(i) ? "{}" : undefined;
        default:
            return undefined;
    }
}

/** camelCase YAML name of a member without a tag in its `[DataField]`, as the engine derives it. */
const camel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

export interface SchemaStats {
    components: number;
    withFields: number;
    fields: number;
    kinds: Record<string, number>;
    /** Components whose class has a base class not found in the sources (its fields are missing). */
    unresolvedBases: string[];
    /** Registered components without a class found (names from prototypes only). */
    noClass: number;
    /** YAML prototype types referenced by prototype id fields (entities aside). */
    protoTypes: string[];
}

/**
 * Data fields of every `[RegisterComponent]` class (partial declarations merged, base classes' fields first, up to
 * the engine's `Component`), keyed by the component's name (class name without `Component`, or its
 * `[ComponentProtoName]`). Enums used by fields come along with their members.
 */
export function componentSchemas(files: readonly SourceFile[], colors: ReadonlyMap<string, readonly number[]>): { schemas: ComponentSchemas; stats: SchemaStats } {
    const { classes, enums, prototypeTypes } = scan(files);
    const protoType = (cls: string) => (cls === "EntityPrototype" ? "entity" : (prototypeTypes.get(cls) ?? prototypeName(cls)));
    const components: Record<string, FieldSchema[]> = {};
    const usedEnums = new Set<string>();
    const protoTypesUsed = new Set<string>();
    const unresolved = new Set<string>();
    const kinds: Record<string, number> = {};
    let fields = 0;

    const fieldsOf = (cls: ClassInfo, seen: Set<string>): FieldSchema[] => {
        if (seen.has(cls.name)) return [];
        seen.add(cls.name);
        const out: FieldSchema[] = [];
        for (const b of cls.bases) {
            if (/^I[A-Z]/.test(b)) continue;
            const base = classes.get(b);
            if (base) out.push(...fieldsOf(base, seen));
            else if (/Component$/.test(b)) unresolved.add(b);
        }
        for (const m of cls.members) {
            const names = m.attributes.map(attrName);
            if (names.includes("IncludeDataField")) {
                // the fields of the member's data definition are the component's own
                const inner = classes.get(m.type.replace(/\?$/, "").replace(/<.*$/, ""));
                for (const f of inner ? fieldsOf(inner, new Set(seen)) : []) if (!out.some((o) => o.name === f.name)) out.push(f);
                continue;
            }
            if (names.includes("IdDataField")) {
                out.push({ name: "id", type: m.type, kind: "string" });
                continue;
            }
            const df = m.attributes.find((a) => attrName(a) === "DataField");
            if (!df) continue;
            const args = attrArgs(df);
            let tag: string | null = null;
            let required = m.modifiers.has("required");
            let serializer: string | null = null;
            args.forEach((a, n) => {
                const named = /^(\w+)\s*:\s*([\s\S]*)$/.exec(a);
                const key = named ? named[1]! : ["tag", "readOnly", "priority", "required", "serverOnly", "customTypeSerializer"][n];
                const value = named ? named[2]!.trim() : a;
                if (key === "tag") tag = stringLiteral(value) ?? /^nameof\((?:\w+\.)*(\w+)\)$/.exec(value)?.[1] ?? null;
                else if (key === "required") required ||= value === "true";
                else if (key === "customTypeSerializer") serializer = value;
            });
            const kind = kindOf(m.type, serializer, enums, protoType);
            const f: FieldSchema = { name: tag ?? camel(m.name), type: m.type, kind: kind.kind };
            if (kind.proto) f.proto = kind.proto;
            if (kind.enum) {
                f.enum = kind.enum;
                usedEnums.add(kind.enum);
            }
            const def = defaultOf(kind, m.type, m.init, enums, colors);
            if (def !== undefined) f.default = def;
            if (required) f.required = true;
            const vv = m.attributes.find((a) => attrName(a) === "ViewVariables");
            if (vv) f.vv = /ReadWrite/.test(vv) ? "rw" : "r";
            const at = out.findIndex((o) => o.name === f.name);
            if (at === -1) out.push(f);
            else out[at] = f;
        }
        return out;
    };

    const registered = new Map<string, ClassInfo[]>();
    for (const cls of classes.values()) {
        if (!cls.attributes.some((a) => attrName(a) === "RegisterComponent")) continue;
        const override = cls.attributes.map((a) => /^ComponentProtoName\(\s*"([^"]+)"/.exec(a.trim())).find((m) => m);
        const name = override ? override[1]! : cls.name.replace(/Component$/, "");
        registered.set(name, [...(registered.get(name) ?? []), cls]);
    }
    for (const [name, list] of [...registered].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const merged: FieldSchema[] = [];
        for (const cls of list) for (const f of fieldsOf(cls, new Set())) if (!merged.some((m) => m.name === f.name)) merged.push(f);
        components[name] = merged;
        fields += merged.length;
        for (const f of merged) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    }
    const enumOut: Record<string, EnumSchema> = {};
    for (const list of Object.values(components)) for (const f of list) if (f.proto && f.proto !== "entity") protoTypesUsed.add(f.proto);
    for (const e of [...usedEnums].sort()) enumOut[e] = enums.get(e)!;
    return {
        schemas: { components, enums: enumOut, prototypeIds: {} },
        stats: {
            components: Object.keys(components).length,
            withFields: Object.values(components).filter((f) => f.length).length,
            fields,
            kinds,
            unresolvedBases: [...unresolved].sort(),
            noClass: 0,
            protoTypes: [...protoTypesUsed].sort(),
        },
    };
}
