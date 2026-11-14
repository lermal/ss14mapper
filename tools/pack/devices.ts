// Device linking data read from a checkout: port prototypes, the ports each entity ends up with (the
// prototype's DeviceLinkSource/DeviceLinkSink plus those game systems add in C# when a component starts) and
// how the fork saves links and device lists. The C# sources are only read as text.
import path from "node:path";
import type { DeviceStorage, PortDefinition } from "../../src/pack/format";
import type { Checkout, Raw, ResolvedEntity } from "./game";

/** Ports added by C# code to every entity with `component`, unless `when` rules it out. */
interface CodePorts {
    component: string;
    kind: "source" | "sink";
    /** YAML field of the component that may override the port, and its C# default. */
    ports: Array<{ field: string | null; ids: string[] }>;
    /** Conditions of enclosing `if`s that can be checked against the prototype. */
    when: Condition[];
    at: string;
}

type Condition = { has: string; not: boolean } | { component: string; field: string; fallback: boolean; not: boolean };

interface CsField {
    /** YAML name (`[DataField("name")]` or the field name with a lower-case first letter), null without DataField. */
    yaml: string | null;
    init: string | null;
}

const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const strings = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);

/** Index of the parenthesis closing the one at `open`, skipping strings. */
function closing(src: string, open: number, o = "(", c = ")"): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '"') {
            for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
            continue;
        }
        if (ch === o) depth++;
        else if (ch === c && --depth === 0) return i;
    }
    return -1;
}

/** Splits at commas outside brackets. */
function splitArgs(s: string): string[] {
    const out: string[] = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if ("([{<".includes(ch!)) depth++;
        else if (")]}>".includes(ch!)) depth--;
        else if (ch === "," && depth === 0) {
            out.push(s.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(s.slice(start).trim());
    return out.filter(Boolean);
}

export class DeviceData {
    private readonly classes = new Map<string, string[]>();
    private readonly code: CodePorts[] = [];
    readonly storage: DeviceStorage;

    constructor(private readonly game: Checkout) {
        const sources = game.csharp();
        for (const { text } of sources) {
            for (const m of text.matchAll(/\bclass\s+(\w+Component)\b/g)) {
                const body = this.classBody(text, m.index!);
                if (body) this.classes.set(m[1]!, [...(this.classes.get(m[1]!) ?? []), body]);
            }
        }
        for (const { file, text } of sources) {
            if (!/Ensure(Source|Sink)Ports?\s*\(/.test(text) || /void\s+Ensure(Source|Sink)Ports?\s*\(/.test(text)) continue;
            this.readCalls(path.relative(game.root, file), text);
        }
        this.storage = this.readStorage(sources);
    }

    private classBody(src: string, at: number): string | null {
        const open = src.indexOf("{", at);
        if (open < 0 || src.slice(at, open).includes(";")) return null;
        const end = closing(src, open, "{", "}");
        return end < 0 ? null : src.slice(open + 1, end);
    }

    /** `EnsureSourcePorts(uid, comp.A, comp.B)` and the like: which component's fields give the ports. */
    private readCalls(rel: string, src: string): void {
        for (const m of src.matchAll(/\.Ensure(Source|Sink)Ports?\s*\(/g)) {
            const open = m.index! + m[0].length - 1;
            const end = closing(src, open);
            if (end < 0) continue;
            const line = src.slice(0, m.index).split("\n").length;
            const at = `${rel}:${line}`;
            const args = splitArgs(src.slice(open + 1, end)).slice(1);
            const method = this.enclosingMethod(src, m.index!);
            if (!method) {
                this.game.problems.push(`${at}: port call outside a method`);
                continue;
            }
            const vars = this.variables(method.params + ",\n" + src.slice(method.bodyStart, m.index));
            const ports: CodePorts["ports"] = [];
            let component: string | null = method.component;
            let ok = true;
            for (const arg of args) {
                const ref = this.portRef(arg.replace(/\.ToArray\(\)$|\.ToList\(\)$/, ""), vars);
                if (!ref) {
                    ok = false;
                    break;
                }
                component ??= ref.cls;
                ports.push({ field: ref.field.yaml, ids: ref.ids });
            }
            if (!ok || !component || !ports.length) {
                this.game.problems.push(`${at}: ports added by code not understood (${args.join(", ")})`);
                continue;
            }
            const when = this.conditions(src, method.bodyStart, m.index!, vars);
            this.code.push({ component: component.replace(/Component$/, ""), kind: m[1] === "Source" ? "source" : "sink", ports, when, at });
        }
    }

    /** The method around `at`: its parameters, body start and the component it handles. */
    private enclosingMethod(src: string, at: number): { params: string; bodyStart: number; component: string | null } | null {
        const head = /(?:^|\n)[ \t]*(?:(?:(?:private|public|protected|internal|static|override|virtual|async|sealed)\s+)+[\w<>\[\],.? ]+?|void)\s+(\w+)\s*\(/g;
        let best: { params: string; bodyStart: number } | null = null;
        for (const m of src.slice(0, at).matchAll(head)) {
            const open = m.index! + m[0].length - 1;
            const end = closing(src, open);
            if (end < 0 || end > at) continue;
            best = { params: src.slice(open + 1, end), bodyStart: end + 1 };
        }
        if (!best) return null;
        const comp = /Entity<(\w+Component)\b/.exec(best.params) ?? /\b(\w+Component)\??\s+\w+/.exec(best.params);
        return { ...best, component: comp?.[1] ?? null };
    }

    /** Variable name → component class, from parameters and `out var x` of TryComp/Resolve in the code before the call. */
    private variables(code: string): Map<string, { cls: string; entity: boolean }> {
        const vars = new Map<string, { cls: string; entity: boolean }>();
        for (const m of code.matchAll(/Entity<(\w+Component)[^>]*>\??\s+(\w+)/g)) vars.set(m[2]!, { cls: m[1]!, entity: true });
        for (const m of code.matchAll(/\b(\w+Component)\??\s+(\w+)\s*[,)=]/g)) vars.set(m[2]!, { cls: m[1]!, entity: false });
        // `var (uid, comp) = ent;`
        for (const m of code.matchAll(/var\s*\(\s*\w+\s*,\s*(\w+)\s*\)\s*=\s*(\w+)\s*;/g)) {
            const ent = vars.get(m[2]!);
            if (ent?.entity) vars.set(m[1]!, { cls: ent.cls, entity: false });
        }
        for (const m of code.matchAll(/(?:TryComp|TryGetComponent|Resolve)<(\w+Component)>\([^;]*?out\s+(?:var|\w+\??)\s+(\w+)/g)) vars.set(m[2]!, { cls: m[1]!, entity: false });
        return vars;
    }

    /** A port argument (`comp.Port`, `ent.Comp.Port`, `SomeComponent.Port`) → its class, field and default ids. */
    private portRef(arg: string, vars: Map<string, { cls: string; entity: boolean }>): { cls: string; field: CsField; ids: string[] } | null {
        const parts = arg.split(".");
        let cls: string | null = null;
        let name: string | undefined;
        const v = vars.get(parts[0]!);
        if (v?.entity && parts[1] === "Comp" && parts.length === 3) [cls, name] = [v.cls, parts[2]];
        else if (v && !v.entity && parts.length === 2) [cls, name] = [v.cls, parts[1]];
        else if (/Component$/.test(parts[0]!) && parts.length === 2) [cls, name] = [parts[0]!, parts[1]];
        else if (/^"[^"]*"$/.test(arg)) return { cls: "", field: { yaml: null, init: arg }, ids: strings(arg) };
        if (!cls || !name) return null;
        const field = this.field(cls, name);
        if (!field) return null;
        const ids = this.initValues(cls, field.init);
        return ids ? { cls, field, ids } : null;
    }

    private field(cls: string, name: string): CsField | null {
        for (const body of this.classes.get(cls) ?? []) {
            const re = new RegExp(`((?:\\[[^\\[\\]]*(?:\\[[^\\]]*\\][^\\[\\]]*)*\\]\\s*)*)(?:public|internal|private|protected)[^;{}()=]*?\\b${name}\\b\\s*(?:\\{[^}]*\\}\\s*)?(?:=\\s*([^;]+))?;`);
            const m = re.exec(body);
            if (!m) continue;
            const attrs = m[1] ?? "";
            const df = /\bDataField\s*(?:\(\s*(?:"(\w+)")?)?/.exec(attrs);
            return { yaml: df ? (df[1] ?? lowerFirst(name)) : null, init: m[2]?.trim() ?? null };
        }
        return null;
    }

    /** Port ids of an initialiser: `"Open"`, `new("Open")`, `new() { "A", "B" }`, `[ "A" ]`, or a constant of the class. */
    private initValues(cls: string, init: string | null, depth = 0): string[] | null {
        if (!init) return [];
        const found = strings(init);
        if (found.length) return found;
        const id = /^(?:(\w+)\.)?(\w+)$/.exec(init);
        if (id && depth < 3) {
            const owner = id[1] && /Component$/.test(id[1]) ? id[1] : cls;
            const f = this.field(owner, id[2]!);
            if (f) return this.initValues(owner, f.init, depth + 1);
        }
        return /^(new\s*(\w+<[^>]*>)?\s*\(\s*\)|\[\s*\]|null)$/.test(init) ? [] : null;
    }

    /** `if (HasComp<X>(...))`, `if (comp.Flag)` around the call, as conditions on the prototype. */
    private conditions(src: string, from: number, at: number, vars: Map<string, { cls: string; entity: boolean }>): Condition[] {
        const out: Condition[] = [];
        const ifs: string[] = [];
        // unclosed blocks between the method start and the call, and a brace-less `if (...)` right before it
        const stack: number[] = [];
        for (let i = from; i < at; i++) {
            if (src[i] === "{") stack.push(i);
            else if (src[i] === "}") stack.pop();
        }
        const before = (pos: number) => {
            const text = src.slice(from, pos).trimEnd();
            if (!text.endsWith(")")) return;
            let depth = 0;
            for (let i = text.length - 1; i >= 0; i--) {
                if (text[i] === ")") depth++;
                else if (text[i] === "(" && --depth === 0) {
                    if (/\bif\s*$/.test(text.slice(0, i))) ifs.push(text.slice(i + 1, text.length - 1));
                    return;
                }
            }
        };
        for (const open of stack) before(open);
        // the brace-less case: text between the previous statement and the call ends with `if (...)`
        const stmt = Math.max(src.lastIndexOf(";", at), src.lastIndexOf("{", at), src.lastIndexOf("}", at));
        const tail = src.slice(stmt + 1, at).replace(/\s*_?\w+\s*$/, "");
        const m = /^\s*if\s*\(([^]*)\)\s*$/.exec(tail);
        if (m) ifs.push(m[1]!);
        for (const cond of ifs) {
            if (/\|\|/.test(cond)) continue; // alternatives: assume the port may be there
            for (const c of cond.split("&&")) {
                const not = /^\s*!/.test(c);
                const has = /\b(?:HasComp|HasComponent|TryComp|TryGetComponent)<(\w+)Component>/.exec(c);
                if (has) {
                    out.push({ has: has[1]!, not });
                    continue;
                }
                const flag = /^\s*!?\s*(\w+)\.(?:Comp\.)?(\w+)\s*$/.exec(c);
                const v = flag && vars.get(flag[1]!);
                if (v && flag) {
                    const f = this.field(v.cls, flag[2]!);
                    if (f?.yaml) out.push({ component: v.cls.replace(/Component$/, ""), field: f.yaml, fallback: f.init === "true", not });
                }
            }
        }
        return out;
    }

    /** How the fork writes `linkedPorts` and which component holds a device's back reference to its lists. */
    private readStorage(sources: Array<{ file: string; text: string }>): DeviceStorage {
        const linkStruct = sources.some(({ text }) => /record\s+struct\s+DeviceLink\s*\(/.test(text));
        const linked = this.classes.has("LinkedDeviceNetworkComponent") && /\bDeviceLists\b/.test(this.classes.get("LinkedDeviceNetworkComponent")!.join("\n"));
        return { linkFormat: linkStruct ? "struct" : "tuple", deviceListBackReference: linked ? "LinkedDeviceNetwork" : "DeviceNetwork" };
    }

    /** Port prototypes with localised names. */
    portPrototypes(type: "sourcePort" | "sinkPort"): Record<string, PortDefinition> {
        const out: Record<string, PortDefinition> = {};
        for (const [id, p] of [...this.game.all(type)].sort(([a], [b]) => (a < b ? -1 : 1))) {
            const name = p.name === undefined ? id : (this.game.localize(String(p.name)) ?? String(p.name));
            const def: PortDefinition = { name };
            const description = p.description === undefined ? undefined : (this.game.localize(String(p.description)) ?? String(p.description));
            if (description) def.description = description;
            if (type === "sourcePort" && p.defaultLinks !== undefined && p.defaultLinks !== null) def.defaultLinks = list(p.defaultLinks);
            out[id] = def;
        }
        return out;
    }

    /** Source and sink ports an entity has once its components have started. */
    ports(e: ResolvedEntity): { source: string[]; sink: string[] } {
        const source = new Set(list((e.components.DeviceLinkSource as Raw | undefined)?.ports));
        const sink = new Set(list((e.components.DeviceLinkSink as Raw | undefined)?.ports));
        for (const c of this.code) {
            const data = e.components[c.component] as Raw | undefined;
            if (!data || !c.when.every((w) => this.holds(w, e))) continue;
            const set = c.kind === "source" ? source : sink;
            for (const p of c.ports) {
                const override = p.field ? data[p.field] : undefined;
                for (const id of override !== undefined && override !== null ? list(override) : p.ids) set.add(id);
            }
        }
        return { source: [...source], sink: [...sink] };
    }

    private holds(w: Condition, e: ResolvedEntity): boolean {
        if ("has" in w) return w.has in e.components !== w.not;
        const v = (e.components[w.component] as Raw | undefined)?.[w.field];
        const value = v === undefined ? w.fallback : String(v).toLowerCase() === "true";
        return value !== w.not;
    }

    /** Where the ports added by code come from, for reports. */
    get codeSites(): string[] {
        return this.code.map((c) => `${c.at} ${c.component} ${c.kind}: ${c.ports.map((p) => p.ids.join("|")).join(", ")}`);
    }
}
