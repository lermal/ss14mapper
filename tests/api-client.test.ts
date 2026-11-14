import { describe, expect, it } from "vitest";
import { Api, ApiClient, ApiError, readCookie } from "../src/api/client";

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    credentials: RequestCredentials | undefined;
}

/** A fetch that answers from a script and records the calls; the CSRF endpoint sets the token cookie. */
function server(answers: Array<(c: Call) => Response>, tokens = ["t%3D1", "t%3D2"]) {
    const calls: Call[] = [];
    let cookie = "other=x";
    let csrf = 0;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const c: Call = {
            url: String(input),
            method: init?.method ?? "GET",
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: init?.body as string | undefined,
            credentials: init?.credentials,
        };
        calls.push(c);
        if (c.url.endsWith("/sanctum/csrf-cookie")) {
            cookie = `other=x; XSRF-TOKEN=${tokens[Math.min(csrf++, tokens.length - 1)]}`;
            return new Response(null, { status: 204 });
        }
        const next = answers.shift();
        if (!next) throw new Error(`unexpected ${c.method} ${c.url}`);
        return next(c);
    }) as typeof globalThis.fetch;
    const client = new ApiClient({ base: "http://api.test/", fetch, cookies: () => cookie });
    return { calls, client, api: new Api(client) };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("readCookie", () => {
    it("finds and decodes one cookie", () => {
        expect(readCookie("a=1; XSRF-TOKEN=ab%3D%3D; b=2", "XSRF-TOKEN")).toBe("ab==");
        expect(readCookie("a=1", "XSRF-TOKEN")).toBeNull();
        expect(readCookie("", "XSRF-TOKEN")).toBeNull();
    });
});

describe("ApiClient", () => {
    it("sends reads with the session cookie and JSON accept, without a CSRF round trip", async () => {
        const s = server([json(200, { id: 1, login: "a", avatar: null, maintainer: false })]);
        const me = await s.api.me();
        expect(me?.login).toBe("a");
        expect(s.calls).toHaveLength(1);
        expect(s.calls[0]!.url).toBe("http://api.test/me");
        expect(s.calls[0]!.credentials).toBe("include");
        expect(s.calls[0]!.headers.Accept).toBe("application/json");
        expect(s.calls[0]!.headers["X-XSRF-TOKEN"]).toBeUndefined();
    });

    it("treats a null answer on /me as signed out", async () => {
        const s = server([json(200, null)]);
        expect(await s.api.me()).toBeNull();
    });

    it("fetches the CSRF cookie once before the first change and sends the decoded token", async () => {
        const s = server([json(200, { status: "ok" }), json(201, { id: "x", status: "pending" })]);
        await s.api.logout();
        await s.api.submitFork("https://github.com/a/b", "");
        expect(s.calls.map((c) => `${c.method} ${c.url.replace("http://api.test", "")}`)).toEqual([
            "GET /sanctum/csrf-cookie",
            "POST /auth/logout",
            "POST /forks",
        ]);
        expect(s.calls[1]!.headers["X-XSRF-TOKEN"]).toBe("t=1");
        expect(s.calls[2]!.headers["X-XSRF-TOKEN"]).toBe("t=1");
        expect(JSON.parse(s.calls[2]!.body!)).toEqual({ url: "https://github.com/a/b" });
    });

    it("refetches the token once on 419 and retries with the new one", async () => {
        const s = server([json(419, { message: "CSRF token mismatch." }), json(200, { status: "ok" })]);
        await s.api.logout();
        const posts = s.calls.filter((c) => c.method === "POST");
        expect(posts).toHaveLength(2);
        expect(posts[0]!.headers["X-XSRF-TOKEN"]).toBe("t=1");
        expect(posts[1]!.headers["X-XSRF-TOKEN"]).toBe("t=2");
        expect(s.calls.filter((c) => c.url.endsWith("csrf-cookie"))).toHaveLength(2);
    });

    it("gives up after the second 419", async () => {
        const s = server([json(419, { message: "CSRF token mismatch." }), json(419, { message: "CSRF token mismatch." })]);
        await expect(s.api.logout()).rejects.toMatchObject({ status: 419, message: "CSRF token mismatch." });
        expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    });

    it("carries the server's message and code", async () => {
        const s = server([json(422, { message: "The repository does not exist or is not public.", code: "repo_not_found" })]);
        const e = await s.api.submitFork("https://github.com/a/b", "main").catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(422);
        expect((e as ApiError).message).toBe("The repository does not exist or is not public.");
        expect((e as ApiError).code).toBe("repo_not_found");
    });

    it("has plain messages without a body and when the server is unreachable", async () => {
        const s = server([() => new Response("", { status: 429 })]);
        await expect(s.api.myForks()).rejects.toMatchObject({ status: 429, message: "Too many requests. Try again later." });
        const down = new ApiClient({ base: "http://api.test", fetch: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch, cookies: () => "" });
        await expect(new Api(down).myForks()).rejects.toMatchObject({ status: 0, message: "Could not reach the server. Try again later." });
    });

    it("resolves an empty answer (204) with undefined", async () => {
        const s = server([() => new Response(null, { status: 204 })]);
        await expect(s.api.remove(3)).resolves.toBeUndefined();
        expect(s.calls.at(-1)!.method).toBe("DELETE");
        expect(s.calls.at(-1)!.url).toBe("http://api.test/admin/forks/3");
    });

    it("returns the server's document on a settings conflict", async () => {
        const s = server([json(409, { revision: 4, data: { version: 1, bindings: {} } })]);
        const r = await s.api.putSettings("keys", 2, { version: 1, bindings: {} });
        expect(r).toEqual({ ok: false, doc: { revision: 4, data: { version: 1, bindings: {} } } });
        expect(JSON.parse(s.calls.at(-1)!.body!)).toEqual({ revision: 2, data: { version: 1, bindings: {} } });
    });

    it("builds the sign-in address with the page to come back to", () => {
        const s = server([]);
        expect(s.api.signInUrl("http://localhost:8769/?open=a&x=1")).toBe("http://api.test/auth/github?return=http%3A%2F%2Flocalhost%3A8769%2F%3Fopen%3Da%26x%3D1");
    });
});
