// Requests to the API (accounts, settings, builds). The session cookie goes along with every request; requests
// that change something carry the CSRF token from the XSRF-TOKEN cookie, fetched once before the first of them
// and again when the server answers 419 (token expired).
import { API_URL } from "../pack/forks";

/** A failed request: the HTTP status (0 when the server could not be reached) and the server's message. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string,
        /** The parsed JSON body, if any. */
        readonly body: unknown = null,
    ) {
        super(message);
        this.name = "ApiError";
    }

    /** The `code` field of the body (`invalid_url`, `duplicate`, ...). */
    get code(): string | undefined {
        const c = (this.body as { code?: unknown } | null)?.code;
        return typeof c === "string" ? c : undefined;
    }
}

const UNREACHABLE = "Could not reach the server. Try again later.";

function defaultMessage(status: number): string {
    if (status === 401) return "You are signed out.";
    if (status === 403) return "You are not allowed to do this.";
    if (status === 404) return "Not found.";
    if (status === 429) return "Too many requests. Try again later.";
    return "The server could not complete the request.";
}

export interface ClientOptions {
    /** The API's origin, without a trailing slash. */
    base: string;
    fetch?: typeof fetch;
    /** The page's cookies (`document.cookie`). */
    cookies?: () => string;
}

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions {
    body?: unknown;
    /** Lets the request outlive the page (a last settings push). */
    keepalive?: boolean;
}

/** Reads one cookie's value, URL-decoded; null when it is not set. */
export function readCookie(cookies: string, name: string): string | null {
    for (const part of cookies.split(";")) {
        const i = part.indexOf("=");
        if (i < 0 || part.slice(0, i).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(i + 1).trim());
        } catch {
            return part.slice(i + 1).trim();
        }
    }
    return null;
}

export class ApiClient {
    readonly base: string;
    private readonly fetchFn: typeof fetch;
    private readonly cookies: () => string;
    /** The CSRF cookie request, shared by requests made at the same time. */
    private csrf: Promise<void> | null = null;

    constructor(options: ClientOptions) {
        this.base = options.base.replace(/\/+$/, "");
        this.fetchFn = options.fetch ?? ((...args) => globalThis.fetch(...args));
        this.cookies = options.cookies ?? (() => (typeof document === "undefined" ? "" : document.cookie));
    }

    /** Sends a request; resolves with the parsed body (undefined for an empty one) or throws an ApiError. */
    async request<T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> {
        const changes = method !== "GET";
        if (changes) await this.ensureCsrf(false);
        let r = await this.send(method, path, options);
        if (r.status === 419 && changes) {
            await this.ensureCsrf(true);
            r = await this.send(method, path, options);
        }
        return this.parse<T>(r);
    }

    /** Fetches a file (a signed-in download); resolves with its bytes or throws an ApiError. */
    async blob(path: string): Promise<Blob> {
        const r = await this.send("GET", path, {});
        if (r.ok) return r.blob();
        return this.parse<never>(r);
    }

    private ensureCsrf(again: boolean): Promise<void> {
        if (again || !this.csrf) {
            const p = this.send("GET", "/sanctum/csrf-cookie", {}).then(async (r) => {
                // the answer is only its cookie; the body is read so the request ends cleanly
                await r.text().catch(() => "");
                if (!r.ok) throw new ApiError(r.status, defaultMessage(r.status));
            });
            // a failed attempt is made again next time
            p.catch(() => {
                if (this.csrf === p) this.csrf = null;
            });
            this.csrf = p;
        }
        return this.csrf;
    }

    private async send(method: Method, path: string, options: RequestOptions): Promise<Response> {
        const headers: Record<string, string> = { Accept: "application/json" };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        if (method !== "GET") {
            const token = readCookie(this.cookies(), "XSRF-TOKEN");
            if (token) headers["X-XSRF-TOKEN"] = token;
        }
        try {
            return await this.fetchFn(`${this.base}${path}`, {
                method,
                headers,
                credentials: "include",
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                keepalive: options.keepalive,
            });
        } catch {
            throw new ApiError(0, UNREACHABLE);
        }
    }

    private async parse<T>(r: Response): Promise<T> {
        let body: unknown = null;
        const text = await r.text().catch(() => "");
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = null;
            }
        }
        if (r.ok) return (body ?? undefined) as T;
        const message = (body as { message?: unknown } | null)?.message;
        throw new ApiError(r.status, typeof message === "string" && message ? message : defaultMessage(r.status), body);
    }
}

// ---- the API's documents

export interface Me {
    id: number;
    login: string;
    avatar: string | null;
    maintainer: boolean;
    /** Builds waiting for approval (maintainers only). */
    pending?: number;
    /** Bug reports not yet fixed (maintainers only). */
    bugs?: number;
}

export type SettingsKind = "keys" | "categories";

export interface SettingsDoc {
    revision: number;
    data: unknown;
}

export type ForkStatus = "pending" | "approved" | "hidden" | "rejected";
export type BuildState = "queued" | "building" | "done" | "failed";

export interface MyFork {
    id: string;
    name: string;
    repo: string;
    branch: string;
    status: ForkStatus;
    createdAt: string | null;
    build: { state: BuildState; commit: string | null; reason: string | null; finishedAt: string | null } | null;
}

export interface AdminFork {
    id: number;
    slug: string;
    title: string;
    repo: string;
    branch: string;
    status: ForkStatus;
    submittedBy: string | null;
    submitterIp: string | null;
    createdAt: string | null;
    build: { id: number; state: BuildState; commit: string | null; reason: string | null; startedAt: string | null; finishedAt: string | null } | null;
}

export type BugStatus = "new" | "fixed";
/** A bug or a suggestion. */
export type BugKind = "bug" | "idea";

export interface BugReport {
    id: number;
    kind: BugKind;
    title: string;
    description: string;
    status: BugStatus;
    user: string | null;
    pageUrl: string | null;
    build: string | null;
    mapName: string | null;
    hasMap: boolean;
    userAgent: string | null;
    createdAt: string | null;
}

/** What the site sends with a bug report; the map is the open map's text. */
export interface BugReportInput {
    kind: BugKind;
    title: string;
    description: string;
    page_url: string;
    build: string;
    map_name?: string;
    user_agent: string;
    map?: string;
}

export type AdminAction = "reject" | "hide" | "unhide" | "rebuild";

/** The endpoints of the contract over one client. */
export class Api {
    constructor(readonly client: ApiClient) {}

    /** The signed-in user, or null when signed out (the API answers 200 with null, so the console stays clean). */
    async me(): Promise<Me | null> {
        return (await this.client.request<Me | null>("GET", "/me")) ?? null;
    }

    /** Where the browser goes to sign in; the API comes back to `returnTo` afterwards. */
    signInUrl(returnTo: string): string {
        return `${this.client.base}/auth/github?return=${encodeURIComponent(returnTo)}`;
    }

    async logout(): Promise<void> {
        await this.client.request("POST", "/auth/logout");
    }

    getSettings(kind: SettingsKind): Promise<SettingsDoc> {
        return this.client.request<SettingsDoc>("GET", `/settings/${kind}`);
    }

    /** Stores a settings document over `revision`; a stale revision gives the server's current document. */
    async putSettings(kind: SettingsKind, revision: number, data: unknown, keepalive = false): Promise<{ ok: true; doc: SettingsDoc } | { ok: false; doc: SettingsDoc }> {
        try {
            return { ok: true, doc: await this.client.request<SettingsDoc>("PUT", `/settings/${kind}`, { body: { revision, data }, keepalive }) };
        } catch (e) {
            if (e instanceof ApiError && e.status === 409 && isSettingsDoc(e.body)) return { ok: false, doc: e.body };
            throw e;
        }
    }

    submitFork(url: string, branch: string): Promise<{ id: string; status: ForkStatus }> {
        return this.client.request("POST", "/forks", { body: branch ? { url, branch } : { url } });
    }

    myForks(): Promise<MyFork[]> {
        return this.client.request("GET", "/me/forks");
    }

    adminForks(): Promise<AdminFork[]> {
        return this.client.request("GET", "/admin/forks");
    }

    approve(id: number, fields: { title?: string; slug?: string }): Promise<unknown> {
        return this.client.request("POST", `/admin/forks/${id}/approve`, { body: fields });
    }

    act(id: number, action: AdminAction): Promise<unknown> {
        return this.client.request("POST", `/admin/forks/${id}/${action}`);
    }

    remove(id: number): Promise<unknown> {
        return this.client.request("DELETE", `/admin/forks/${id}`);
    }

    sendBugReport(report: BugReportInput): Promise<{ id: number; status: BugStatus }> {
        return this.client.request("POST", "/bug-reports", { body: report });
    }

    /** All bug reports, newest first (the tabs are counted from this). */
    adminBugReports(): Promise<BugReport[]> {
        return this.client.request("GET", "/admin/bug-reports?status=all");
    }

    bugMap(id: number): Promise<Blob> {
        return this.client.blob(`/admin/bug-reports/${id}/map`);
    }

    markBugFixed(id: number): Promise<unknown> {
        return this.client.request("POST", `/admin/bug-reports/${id}/fixed`);
    }

    removeBug(id: number): Promise<unknown> {
        return this.client.request("DELETE", `/admin/bug-reports/${id}`);
    }
}

function isSettingsDoc(v: unknown): v is SettingsDoc {
    return !!v && typeof v === "object" && typeof (v as { revision?: unknown }).revision === "number" && "data" in v;
}

/** The API of the site, or null in local development (no accounts). */
export const api: Api | null = API_URL ? new Api(new ApiClient({ base: API_URL })) : null;
