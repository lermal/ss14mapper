// What the build lists show, without DOM: the state badge of a submitted build, its meta line, relative times.
import type { AdminFork, BuildState, ForkStatus } from "./client";

export type StateTone = "ready" | "failed" | "wait" | "";

export interface StateLabel {
    label: string;
    tone: StateTone;
    /** Why the last build failed. */
    reason?: string;
}

/** The badge of a build: its review status first, then the state of its last build. */
export function stateLabel(status: ForkStatus, build: { state: BuildState; reason?: string | null } | null): StateLabel {
    if (status === "pending") return { label: "Waiting for approval", tone: "wait" };
    if (status === "rejected") return { label: "Declined", tone: "" };
    if (status === "hidden") return { label: "Hidden", tone: "" };
    if (build?.state === "done") return { label: "Ready", tone: "ready" };
    if (build?.state === "failed") return build.reason ? { label: "Failed", tone: "failed", reason: build.reason } : { label: "Failed", tone: "failed" };
    return { label: "Building", tone: "wait" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "3 Nov" ("3 Nov 2024" in another year). */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, (now - t) / 1000);
    const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    if (s < 60) return "just now";
    if (s < 3600) return plural(Math.floor(s / 60), "minute");
    if (s < 86_400) return plural(Math.floor(s / 3600), "hour");
    const days = Math.floor(s / 86_400);
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    const d = new Date(t), n = new Date(now);
    return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? "" : ` ${d.getFullYear()}`}`;
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
        if (when) parts.push(`submitted ${when}`);
    } else if (f.status === "approved" && f.build?.state === "done") {
        const when = relativeTime(f.build.finishedAt, now);
        const from = short(f.build.commit);
        parts.push(["built", when, from && `from ${from}`].filter(Boolean).join(" "));
    }
    return parts.join(" · ");
}

/** The meta line of a build in Manage builds: who submitted a waiting one; the ID and last build of the others. */
export function adminMeta(f: Pick<AdminFork, "slug" | "repo" | "branch" | "status" | "submittedBy" | "createdAt" | "build">, now = Date.now()): string {
    if (f.status === "pending" || f.status === "rejected") {
        const from = [f.submittedBy && `from ${f.submittedBy}`, relativeTime(f.createdAt, now)].filter(Boolean).join(", ");
        return [repoPath(f.repo), f.branch, from].filter(Boolean).join(" · ");
    }
    const commit = short(f.build?.commit);
    const when = relativeTime(f.build?.finishedAt ?? f.build?.startedAt, now);
    const last = [commit, when].filter(Boolean).join(", ");
    return [f.slug, repoPath(f.repo), f.branch, last].filter(Boolean).join(" · ");
}

/** Tabs of Manage builds and the review status each one lists. */
export const MANAGE_TABS: ReadonlyArray<{ label: string; status: ForkStatus }> = [
    { label: "Waiting", status: "pending" },
    { label: "Approved", status: "approved" },
    { label: "Hidden", status: "hidden" },
    { label: "Declined", status: "rejected" },
];

/** The ID a build can be given: what the API accepts. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
