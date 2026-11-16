// What the build lists show, without DOM: the state badge of a submitted build, its meta line, relative times.
import { language, shortDate, t as translate } from "../i18n";
import type { AdminFork, BugKind, BugReport, BugStatus, BuildState, ForkStatus } from "./client";

export type StateTone = "ready" | "failed" | "wait" | "";

export interface StateLabel {
    label: string;
    tone: StateTone;
    /** Why the last build failed. */
    reason?: string;
}

/** The badge of a build: its review status first, then the state of its last build. */
export function stateLabel(status: ForkStatus, build: { state: BuildState; reason?: string | null } | null): StateLabel {
    if (status === "pending") return { label: translate("Waiting for approval"), tone: "wait" };
    if (status === "rejected") return { label: translate("Declined"), tone: "" };
    if (status === "hidden") return { label: translate("Hidden"), tone: "" };
    if (build?.state === "done") return { label: translate("Ready"), tone: "ready" };
    if (build?.state === "failed") return build.reason ? { label: translate("Failed"), tone: "failed", reason: build.reason } : { label: translate("Failed"), tone: "failed" };
    return { label: translate("Building asset pack"), tone: "wait" };
}

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "3 Nov" ("3 Nov 2024" in another year). */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, (now - t) / 1000);
    if (s < 60) return translate("just now");
    const time = new Intl.RelativeTimeFormat(language(), { numeric: "auto" });
    if (s < 3600) return time.format(-Math.floor(s / 60), "minute");
    if (s < 86_400) return time.format(-Math.floor(s / 3600), "hour");
    const days = Math.floor(s / 86_400);
    if (days < 7) return time.format(-days, "day");
    const d = new Date(t), n = new Date(now);
    return shortDate(d, d.getFullYear() !== n.getFullYear());
}

/** "owner/name" of a GitHub URL (the URL itself when it is not one). */
export function repoPath(url: string): string {
    const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);
    return m ? m[1]! : url;
}

const short = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : "");

/** The meta line of one of the user's builds: where it comes from, and when it was built or submitted. */
export function myBuildMeta(
    f: { repo: string; branch: string; status: ForkStatus; createdAt: string | null; build: { state: BuildState; commit: string | null; finishedAt: string | null } | null },
    now = Date.now(),
): string {
    const parts = [repoPath(f.repo), f.branch];
    if (f.status === "pending") {
        const when = relativeTime(f.createdAt, now);
        if (when) parts.push(translate("submitted {{1}}", { 1: when }));
    } else if (f.status === "approved" && f.build?.state === "done") {
        const when = relativeTime(f.build.finishedAt, now);
        const from = short(f.build.commit);
        parts.push([translate("built"), when, from && translate("from {{1}}", { 1: from })].filter(Boolean).join(" "));
    }
    return parts.join(" · ");
}

/** The meta line of a build in Manage builds: who submitted a waiting one; the ID and last build of the others. */
export function adminMeta(f: Pick<AdminFork, "slug" | "repo" | "branch" | "status" | "submittedBy" | "createdAt" | "build">, now = Date.now()): string {
    if (f.status === "pending" || f.status === "rejected") {
        const from = [f.submittedBy && translate("from {{1}}", { 1: f.submittedBy }), relativeTime(f.createdAt, now)].filter(Boolean).join(", ");
        return [repoPath(f.repo), f.branch, from].filter(Boolean).join(" · ");
    }
    const commit = short(f.build?.commit);
    const when = relativeTime(f.build?.finishedAt ?? f.build?.startedAt, now);
    const last = [commit, when].filter(Boolean).join(", ");
    return [f.slug, repoPath(f.repo), f.branch, last].filter(Boolean).join(" · ");
}

/** Tabs of Manage builds and the review status each one lists. */
export const MANAGE_TABS: ReadonlyArray<{ label: string; status: ForkStatus }> = [
    { label: translate("Waiting"), status: "pending" },
    { label: translate("Approved"), status: "approved" },
    { label: translate("Hidden"), status: "hidden" },
    { label: translate("Declined"), status: "rejected" },
];

/** The ID a build can be given: what the API accepts. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** "Chrome 142", "Firefox 140", "Safari 17", "Edge 142", "Opera 120" from a user agent; "" when it is not a known browser. */
export function browserName(ua: string | null | undefined): string {
    if (!ua) return "";
    // Edge, Opera and Firefox on iOS also say Chrome or Safari, so they are looked for first
    const known: Array<[string, RegExp]> = [
        ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
        ["Opera", /\bOPR\/(\d+)/],
        ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
        ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
        ["Safari", /\bVersion\/(\d+)[^]*\bSafari\//],
    ];
    for (const [name, re] of known) {
        const m = re.exec(ua);
        if (m) return `${name} ${m[1]}`;
    }
    return "";
}

/** The meta line of a bug report: who sent it, from which build and map, in which browser, and when. */
export function bugMeta(r: Pick<BugReport, "user" | "build" | "mapName" | "userAgent" | "createdAt">, buildName: (id: string) => string = (id) => id, now = Date.now()): string {
    return [r.user ?? translate("deleted user"), r.build && buildName(r.build), r.mapName, browserName(r.userAgent), relativeTime(r.createdAt, now)].filter(Boolean).join(" · ");
}

/** Type filter of Feedback; `kind` null lists both. */
export const KIND_TABS: ReadonlyArray<{ label: string; kind: BugKind | null }> = [
    { label: translate("All types"), kind: null },
    { label: translate("Bugs"), kind: "bug" },
    { label: translate("Suggestions"), kind: "idea" },
];

/** Tabs of Feedback; `status` null lists all. */
export const BUG_TABS: ReadonlyArray<{ label: string; status: BugStatus | null }> = [
    { label: translate("New"), status: "new" },
    { label: translate("Done"), status: "fixed" },
    { label: translate("All"), status: null },
];
