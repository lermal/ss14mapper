// Lossless reader and writer for the YAML subset written by the game's map saver (YamlDotNet).
//
// Every mapping entry and sequence item remembers the exact source text it was read from.
// Writing a document reproduces untouched parts byte for byte; only entries and items marked
// as changed are emitted again, in the same style the game uses:
//   - block mappings indented by 2, sequences under a key not indented ("key:\n- item");
//   - a mapping inside a sequence starts on the dash line ("- key: value");
//   - nested sequences start on the dash line ("- - value");
//   - tags precede the value ("key: !type:Name"), empty collections are "{}" and "[]".

export type ScalarStyle = "plain" | "single" | "double" | "block" | "flow";

export interface YScalar {
    kind: "scalar";
    tag?: string;
    /** Decoded text for plain, single and double quoted scalars; source text otherwise. */
    value: string;
    style: ScalarStyle;
    /** Source text of the value (possibly several lines) when read from a file. */
    raw?: string;
    /** `value` as it was read; the source text is reused while the value is unchanged. */
    rawValue?: string;
}

export interface YMap {
    kind: "map";
    tag?: string;
    entries: YEntry[];
}

export interface YSeq {
    kind: "seq";
    tag?: string;
    items: YItem[];
}

export type YNode = YScalar | YMap | YSeq;

export interface YEntry {
    key: YScalar;
    value: YNode;
    /** Source lines of the entry, including comments and blank lines before it. */
    src?: string;
    /** Comments and blank lines before the entry, kept when the entry is emitted again. */
    lead?: string;
}

export interface YItem {
    value: YNode;
    src?: string;
    lead?: string;
}

export interface YDocument {
    root: YMap;
    /** Lines after the root mapping, usually the "..." end marker. */
    trailer: string;
    finalNewline: boolean;
}

// ---------------------------------------------------------------------------------------------
// Reading

class Reader {
    /** Lines as parsed; the first line of a sequence item is temporarily rewritten during parsing. */
    private readonly lines: string[];

    constructor(private readonly original: string[]) {
        this.lines = original.slice();
    }

    get count(): number {
        return this.lines.length;
    }

    indentOf(i: number): number {
        const line = this.lines[i]!;
        let n = 0;
        while (n < line.length && line.charCodeAt(n) === 32) n++;
        return n;
    }

    /** Blank lines and comment lines carry no structure. */
    isTrivia(i: number): boolean {
        const t = this.lines[i]!.trim();
        return t === "" || t.startsWith("#");
    }

    nextSignificant(i: number): number {
        while (i < this.lines.length && this.isTrivia(i)) i++;
        return i;
    }

    isEnd(i: number): boolean {
        const t = this.lines[i]!;
        return t === "..." || t === "---";
    }

    text(i: number): string {
        return this.lines[i]!;
    }

    /** Source text of lines [from, to) as currently parsed (sequence dashes of open items blanked). */
    slice(from: number, to: number): string {
        return this.lines.slice(from, to).join("\n");
    }

    originalSlice(from: number, to: number): string {
        return this.original.slice(from, to).join("\n");
    }

    rewrite(i: number, line: string): void {
        this.lines[i] = line;
    }

    restore(i: number): void {
        this.lines[i] = this.original[i]!;
    }
}

const isSeqLine = (content: string) => content === "-" || content.startsWith("- ");

function splitTag(text: string): { tag?: string; rest: string } {
    if (!text.startsWith("!")) return { rest: text };
    const space = text.indexOf(" ");
    if (space === -1) return { tag: text, rest: "" };
    return { tag: text.slice(0, space), rest: text.slice(space + 1) };
}

/** Position of the ": " (or final ":") that ends a mapping key, or -1. */
function keyEnd(content: string): number {
    if (content.startsWith("'") || content.startsWith('"')) {
        const close = closingQuote(content, 0);
        if (close === -1) return -1;
        const after = close + 1;
        return content[after] === ":" && (after + 1 === content.length || content[after + 1] === " ") ? after : -1;
    }
    if (content.startsWith("- ") || content === "-") return -1;
    for (let i = 0; i < content.length; i++) {
        if (content[i] === ":" && (i + 1 === content.length || content[i + 1] === " ")) return i;
        if (content[i] === " " && content[i + 1] === "#") return -1;
    }
    return -1;
}

function closingQuote(text: string, start: number): number {
    const quote = text[start];
    for (let i = start + 1; i < text.length; i++) {
        if (quote === "'") {
            if (text[i] === "'") {
                if (text[i + 1] === "'") {
                    i++;
                    continue;
                }
                return i;
            }
        } else {
            if (text[i] === "\\") {
                i++;
                continue;
            }
            if (text[i] === '"') return i;
        }
    }
    return -1;
}

function decodeSingle(raw: string): string {
    return foldLines(raw.slice(1, -1)).replace(/''/g, "'");
}

function decodeDouble(raw: string): string {
    const body = foldLines(raw.slice(1, -1));
    return body.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_m, e: string) => {
        switch (e[0]) {
            case "n": return "\n";
            case "r": return "\r";
            case "t": return "\t";
            case "0": return "\0";
            case "\\": return "\\";
            case '"': return '"';
            case "/": return "/";
            case " ": return " ";
            case "x": case "u": case "U": return String.fromCodePoint(parseInt(e.slice(1), 16));
            default: return e;
        }
    });
}

/** Line folding of multi-line flow scalars: a single line break becomes a space. */
function foldLines(text: string): string {
    if (!text.includes("\n")) return text;
    return text
        .split("\n")
        .map((l, i) => (i === 0 ? l.replace(/ +$/, "") : l.trim()))
        .reduce((acc, l, i) => (i === 0 ? l : l === "" ? acc + "\n" : acc.endsWith("\n") ? acc + l : acc + " " + l), "");
}

function readScalar(value: string, style: ScalarStyle, raw: string, tag?: string): YScalar {
    return { kind: "scalar", tag, value, style, raw, rawValue: value };
}

function parseKey(text: string): YScalar {
    if (text.startsWith("'")) return readScalar(decodeSingle(text), "single", text);
    if (text.startsWith('"')) return readScalar(decodeDouble(text), "double", text);
    return readScalar(text, "plain", text);
}

/**
 * Reads a value that starts on line `i` at text `rest` (after "key: " or "- ").
 * Returns the node and the index of the first line after it.
 * `indent` is the indentation of the owning entry or item.
 */
function readInlineValue(r: Reader, i: number, rest: string, indent: number): { node: YNode; next: number } {
    const { tag, rest: value } = splitTag(rest);

    if (value === "") {
        return readBlockValue(r, i + 1, indent, tag);
    }

    const first = value[0];
    if (first === "|" || first === ">") {
        let j = i + 1;
        let end = j;
        while (j < r.count) {
            if (r.isEnd(j)) break;
            const blank = r.text(j).trim() === "";
            if (!blank && r.indentOf(j) <= indent) break;
            j++;
            if (!blank) end = j;
        }
        // trailing blank lines belong to the block scalar only when it keeps them ("+")
        if (value.includes("+")) end = j;
        const raw = [value, ...rangeLines(r, i + 1, end)].join("\n");
        return { node: readScalar(raw, "block", raw, tag), next: end };
    }

    if (first === "'" || first === '"') {
        let text = value;
        let j = i;
        while (closingQuote(text, 0) === -1 && j + 1 < r.count) {
            j++;
            text += "\n" + r.text(j);
        }
        const close = closingQuote(text, 0);
        const raw = text.slice(0, close + 1);
        const decoded = first === "'" ? decodeSingle(raw) : decodeDouble(raw);
        return { node: readScalar(decoded, first === "'" ? "single" : "double", raw, tag), next: j + 1 };
    }

    if (first === "{" || first === "[") {
        let text = value;
        let j = i;
        while (!flowBalanced(text) && j + 1 < r.count) {
            j++;
            text += "\n" + r.text(j);
        }
        return { node: readScalar(text, "flow", text, tag), next: j + 1 };
    }

    // plain scalar, possibly continued on more indented lines
    let text = value;
    let j = i + 1;
    while (j < r.count && !r.isEnd(j) && r.text(j).trim() !== "" && r.indentOf(j) > indent && keyEnd(r.text(j).trim()) === -1 && !isSeqLine(r.text(j).trim())) {
        text += "\n" + r.text(j);
        j++;
    }
    // a comment after a plain value ("Name # note") is not part of the value
    const comment = text.search(/ +#/);
    const valueText = comment === -1 ? text : text.slice(0, comment);
    return { node: readScalar(foldLines(valueText), "plain", text, tag), next: j };
}

function rangeLines(r: Reader, from: number, to: number): string[] {
    const out: string[] = [];
    for (let k = from; k < to; k++) out.push(r.text(k));
    return out;
}

function flowBalanced(text: string): boolean {
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"') quote = c;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") depth--;
    }
    return depth <= 0;
}

/** A value that starts on the next lines: a nested mapping, a sequence or nothing (null). */
function readBlockValue(r: Reader, i: number, indent: number, tag?: string): { node: YNode; next: number } {
    const j = r.nextSignificant(i);
    if (j < r.count && !r.isEnd(j)) {
        const ind = r.indentOf(j);
        const content = r.text(j).slice(ind);
        if (isSeqLine(content) && ind >= indent) {
            const seq = readSequence(r, i, ind);
            seq.node.tag = tag;
            return seq;
        }
        if (ind > indent) {
            const map = readMapping(r, i, ind);
            map.node.tag = tag;
            return map;
        }
    }
    return { node: readScalar("", "plain", "", tag), next: i };
}

function readMapping(r: Reader, i: number, indent: number): { node: YMap; next: number } {
    const entries: YEntry[] = [];
    let pos = i;
    while (true) {
        const j = r.nextSignificant(pos);
        if (j >= r.count || r.isEnd(j) || r.indentOf(j) !== indent) break;
        const content = r.text(j).slice(indent);
        const end = keyEnd(content);
        if (end === -1) break;
        const key = parseKey(content.slice(0, end));
        const rest = content.slice(end + 1).replace(/^ /, "");
        const { node, next } = readInlineValue(r, j, rest, indent);
        entries.push({ key, value: node, src: r.slice(pos, next), lead: j > pos ? r.slice(pos, j) : undefined });
        pos = next;
    }
    return { node: { kind: "map", entries }, next: pos };
}

function readSequence(r: Reader, i: number, indent: number): { node: YSeq; next: number } {
    const items: YItem[] = [];
    let pos = i;
    while (true) {
        const j = r.nextSignificant(pos);
        if (j >= r.count || r.isEnd(j) || r.indentOf(j) !== indent) break;
        const content = r.text(j).slice(indent);
        if (!isSeqLine(content)) break;
        const rest = content === "-" ? "" : content.slice(2);
        let parsed: { node: YNode; next: number };

        const { tag, rest: afterTag } = splitTag(rest);
        if (rest === "" || (tag && afterTag === "")) {
            parsed = readBlockValue(r, j + 1, indent, tag);
        } else if (isSeqLine(rest) || keyEnd(afterTag) !== -1) {
            // the item's content starts on the dash line: read it as if the dash were indentation
            r.rewrite(j, " ".repeat(indent + 2) + rest);
            parsed = isSeqLine(rest) ? readSequence(r, j, indent + 2) : readMapping(r, j, indent + 2);
            r.restore(j);
        } else {
            parsed = readInlineValue(r, j, rest, indent);
        }
        items.push({ value: parsed.node, src: r.originalSlice(pos, parsed.next), lead: j > pos ? r.originalSlice(pos, j) : undefined });
        pos = parsed.next;
    }
    return { node: { kind: "seq", items }, next: pos };
}

export function parseDocument(text: string): YDocument {
    const finalNewline = text.endsWith("\n");
    const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
    const r = new Reader(lines);
    const { node, next } = readMapping(r, 0, 0);
    if (next < lines.length) {
        const rest = lines.slice(next);
        const significant = rest.find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
        if (significant !== undefined && significant !== "..." && significant !== "---") {
            throw new Error(`Unsupported YAML at line ${next + 1}: ${lines[next]}`);
        }
    }
    return { root: node, trailer: lines.slice(next).join("\n"), finalNewline };
}

// ---------------------------------------------------------------------------------------------
// Writing

/** Marks an entry or item as changed, so it is emitted from its value instead of its source. */
export function touch(target: YEntry | YItem): void {
    delete target.src;
}

/** Marks every entry and item below a node as changed (used to verify the emitter). */
export function touchAll(node: YNode): void {
    if (node.kind === "map") {
        for (const e of node.entries) {
            touch(e);
            touchAll(e.value);
        }
    } else if (node.kind === "seq") {
        for (const it of node.items) {
            touch(it);
            touchAll(it.value);
        }
    }
}

const pad = (n: number) => " ".repeat(n);

function scalarText(s: YScalar): string {
    if (s.raw !== undefined && s.value === s.rawValue) return s.raw;
    return formatScalar(s.value);
}

function withTag(tag: string | undefined, text: string): string {
    if (!tag) return text;
    return text === "" ? tag : `${tag} ${text}`;
}

function isEmptyCollection(node: YNode): boolean {
    return (node.kind === "map" && node.entries.length === 0) || (node.kind === "seq" && node.items.length === 0);
}

function emitEntry(entry: YEntry, indent: number): string {
    if (entry.src !== undefined) return entry.src;
    const body = emitEntryBody(entry, indent);
    return entry.lead !== undefined ? entry.lead + "\n" + body : body;
}

function emitEntryBody(entry: YEntry, indent: number): string {
    const key = pad(indent) + scalarText(entry.key) + ":";
    const v = entry.value;
    if (v.kind === "scalar") {
        const text = withTag(v.tag, scalarText(v));
        return text === "" ? key : `${key} ${text}`;
    }
    if (isEmptyCollection(v)) return `${key} ${withTag(v.tag, v.kind === "map" ? "{}" : "[]")}`;
    const head = v.tag ? `${key} ${v.tag}` : key;
    if (v.kind === "map") return head + "\n" + emitEntries(v.entries, indent + 2);
    return head + "\n" + emitItems(v.items, indent);
}

function emitEntries(entries: YEntry[], indent: number): string {
    return entries.map((e) => emitEntry(e, indent)).join("\n");
}

function emitItem(item: YItem, indent: number): string {
    if (item.src !== undefined) return item.src;
    const body = emitItemBody(item, indent);
    return item.lead !== undefined ? item.lead + "\n" + body : body;
}

function emitItemBody(item: YItem, indent: number): string {
    const dash = pad(indent) + "-";
    const v = item.value;
    if (v.kind === "scalar") {
        const text = withTag(v.tag, scalarText(v));
        return text === "" ? dash : `${dash} ${text}`;
    }
    if (isEmptyCollection(v)) return `${dash} ${withTag(v.tag, v.kind === "map" ? "{}" : "[]")}`;
    if (v.tag) {
        const body = v.kind === "map" ? emitEntries(v.entries, indent + 2) : emitItems(v.items, indent + 2);
        return `${dash} ${v.tag}\n${body}`;
    }
    // the first line of the content replaces the indentation after the dash
    const body = v.kind === "map" ? emitEntries(v.entries, indent + 2) : emitItems(v.items, indent + 2);
    return dash + " " + body.slice(indent + 2);
}

function emitItems(items: YItem[], indent: number): string {
    return items.map((it) => emitItem(it, indent)).join("\n");
}

export function serializeDocument(doc: YDocument): string {
    const parts = [emitEntries(doc.root.entries, 0)];
    if (doc.trailer !== "") parts.push(doc.trailer);
    return parts.join("\n") + (doc.finalNewline ? "\n" : "");
}

// ---------------------------------------------------------------------------------------------
// Scalars written by the editor

// Characters that cannot start a plain scalar; "-", "?" and ":" only when followed by a space.
const PLAIN_UNSAFE_START = /^(?:[,\[\]{}#&*!|>'"%@`]|[-?:](?: |$))/;

function doubleQuoted(value: string): string {
    return (
        '"' +
        value
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            .replace(/\0/g, "\\0") +
        '"'
    );
}

/** Style the game's serializer uses for a string: plain when unambiguous, otherwise quoted. */
export function formatScalar(value: string): string {
    if (value === "") return '""';
    if (/[\n\r\t\0]/.test(value)) return doubleQuoted(value);
    if (
        /^\s|\s$/.test(value) ||
        PLAIN_UNSAFE_START.test(value) ||
        value.includes(": ") ||
        value.includes(" #") ||
        value.endsWith(":") ||
        value.startsWith("...") ||
        value.startsWith("---")
    ) {
        return "'" + value.replace(/'/g, "''") + "'";
    }
    return value;
}

export function scalar(value: string, tag?: string): YScalar {
    return { kind: "scalar", value, style: "plain", tag };
}

export function map(entries: Array<[string, YNode]>, tag?: string): YMap {
    return { kind: "map", tag, entries: entries.map(([k, v]) => ({ key: scalar(k), value: v })) };
}

export function seq(items: YNode[], tag?: string): YSeq {
    return { kind: "seq", tag, items: items.map((value) => ({ value })) };
}

export function get(node: YNode | undefined, key: string): YNode | undefined {
    if (!node || node.kind !== "map") return undefined;
    return node.entries.find((e) => e.key.value === key)?.value;
}

export function entryOf(node: YMap, key: string): YEntry | undefined {
    return node.entries.find((e) => e.key.value === key);
}
