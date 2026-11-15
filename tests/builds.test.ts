import { describe, expect, it } from "vitest";
import { adminMeta, browserName, bugMeta, myBuildMeta, relativeTime, repoPath, stateLabel } from "../src/api/builds";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("stateLabel", () => {
    it("maps review status and build state to the badge", () => {
        expect(stateLabel("pending", null)).toEqual({ label: "Waiting for approval", tone: "wait" });
        expect(stateLabel("approved", { state: "done" })).toEqual({ label: "Ready", tone: "ready" });
        expect(stateLabel("approved", { state: "queued" })).toEqual({ label: "Building", tone: "wait" });
        expect(stateLabel("approved", { state: "building" })).toEqual({ label: "Building", tone: "wait" });
        expect(stateLabel("approved", null)).toEqual({ label: "Building", tone: "wait" });
        expect(stateLabel("approved", { state: "failed", reason: "Checkout is too large." })).toEqual({ label: "Failed", tone: "failed", reason: "Checkout is too large." });
        expect(stateLabel("approved", { state: "failed", reason: null })).toEqual({ label: "Failed", tone: "failed" });
        expect(stateLabel("rejected", null)).toEqual({ label: "Declined", tone: "" });
        expect(stateLabel("hidden", { state: "done" })).toEqual({ label: "Hidden", tone: "" });
    });
});

describe("relativeTime", () => {
    it("reads like a person would say it", () => {
        expect(relativeTime(ago(20), NOW)).toBe("just now");
        expect(relativeTime(ago(60), NOW)).toBe("1 minute ago");
        expect(relativeTime(ago(5 * 60), NOW)).toBe("5 minutes ago");
        expect(relativeTime(ago(2 * 3600), NOW)).toBe("2 hours ago");
        expect(relativeTime(ago(30 * 3600), NOW)).toBe("yesterday");
        expect(relativeTime(ago(3 * 86400), NOW)).toBe("3 days ago");
        expect(relativeTime("2026-11-01T10:00:00Z", NOW)).toBe("1 Nov");
        expect(relativeTime("2025-03-01T10:00:00Z", NOW)).toBe("1 Mar 2025");
        expect(relativeTime(null, NOW)).toBe("");
    });
});

describe("meta lines", () => {
    it("shortens GitHub URLs", () => {
        expect(repoPath("https://github.com/new-frontiers-14/frontier-station-14")).toBe("new-frontiers-14/frontier-station-14");
        expect(repoPath("https://example.com/x")).toBe("https://example.com/x");
    });

    it("says when the user's build was submitted or built", () => {
        const base = { repo: "https://github.com/a/b", branch: "master", createdAt: ago(3600) };
        expect(myBuildMeta({ ...base, status: "pending", build: null }, NOW)).toBe("a/b · master · submitted 1 hour ago");
        expect(myBuildMeta({ ...base, status: "approved", build: { state: "done", commit: "efda2ea0123456789", finishedAt: ago(7200) } }, NOW)).toBe(
            "a/b · master · built 2 hours ago from efda2ea",
        );
        expect(myBuildMeta({ ...base, status: "approved", build: { state: "failed", commit: null, finishedAt: ago(10) } }, NOW)).toBe("a/b · master");
        expect(myBuildMeta({ ...base, status: "rejected", build: null }, NOW)).toBe("a/b · master");
    });

    it("shows the ID and last build in Manage builds, the submitter while waiting", () => {
        const f = { slug: "frontier", repo: "https://github.com/n/f", branch: "master", submittedBy: "lermal", createdAt: ago(100) };
        expect(adminMeta({ ...f, status: "pending", build: null }, NOW)).toBe("n/f · master · from lermal, 1 minute ago");
        expect(
            adminMeta({ ...f, status: "approved", build: { id: 1, state: "done", commit: "efda2ea99", reason: null, startedAt: ago(8000), finishedAt: ago(7200) } }, NOW),
        ).toBe("frontier · n/f · master · efda2ea, 2 hours ago");
        expect(adminMeta({ ...f, status: "approved", build: null }, NOW)).toBe("frontier · n/f · master");
    });
});

describe("browserName", () => {
    it("gives the browser and its major version", () => {
        expect(browserName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Safari/537.36")).toBe("Chrome 142");
        expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox 140");
        expect(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.3595.53")).toBe("Edge 142");
        expect(browserName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0")).toBe("Opera 120");
        expect(browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari 17");
        expect(browserName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1")).toBe("Chrome 126");
    });

    it("is empty for an unknown or missing agent", () => {
        expect(browserName("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36")).toBe("Chrome 156");
        expect(browserName("curl/8.5.0")).toBe("");
        expect(browserName("")).toBe("");
        expect(browserName(null)).toBe("");
    });
});

describe("bugMeta", () => {
    const base = { user: "lermal", build: "frontier", mapName: "barnacle.yml", userAgent: "Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36", createdAt: ago(5 * 60) };

    it("joins login, build name, map, browser and time", () => {
        expect(bugMeta(base, () => "Frontier Station 14", NOW)).toBe("lermal · Frontier Station 14 · barnacle.yml · Chrome 142 · 5 minutes ago");
    });

    it("leaves out what is missing", () => {
        expect(bugMeta({ ...base, mapName: null, userAgent: "curl/8", build: null }, undefined, NOW)).toBe("lermal · 5 minutes ago");
        expect(bugMeta({ ...base, user: null }, (id) => id, NOW)).toBe("deleted user · frontier · barnacle.yml · Chrome 142 · 5 minutes ago");
    });
});
