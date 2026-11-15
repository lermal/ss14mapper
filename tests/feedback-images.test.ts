import { describe, expect, it } from "vitest";
import { addImages, imageProblem, MAX_IMAGES, MSG_COUNT, MSG_SIZE, MSG_TOTAL, MSG_TYPE, reportForm } from "../src/api/feedback-images";
import { ApiClient, Api } from "../src/api/client";

const img = (size = 100, type = "image/png", name = "a.png") => ({ type, size, name });
const MB = 1024 * 1024;

describe("image validation", () => {
    it("accepts the four types and rejects the rest", () => {
        for (const t of ["image/png", "image/jpeg", "image/webp", "image/gif"]) expect(imageProblem(img(1, t), [])).toBeNull();
        expect(imageProblem(img(1, "image/svg+xml"), [])).toBe(MSG_TYPE);
        expect(imageProblem(img(1, ""), [])).toBe(MSG_TYPE);
    });

    it("limits one image to 5 MB", () => {
        expect(imageProblem(img(5 * MB), [])).toBeNull();
        expect(imageProblem(img(5 * MB + 1), [])).toBe(MSG_SIZE);
    });

    it("limits the count to 10", () => {
        const ten = Array.from({ length: MAX_IMAGES }, () => img(10));
        expect(imageProblem(img(10), ten.slice(1))).toBeNull();
        expect(imageProblem(img(10), ten)).toBe(MSG_COUNT);
    });

    it("limits the total to 30 MB", () => {
        const six = Array.from({ length: 6 }, () => img(5 * MB));
        expect(imageProblem(img(1), six)).toBe(MSG_TOTAL);
        expect(imageProblem(img(0), six)).toBeNull();
    });

    it("adds the good files and reports the first problem", () => {
        const good = img(10);
        const r = addImages([], [good, img(1, "text/plain"), img(6 * MB)]);
        expect(r.images).toEqual([good]);
        expect(r.error).toBe(MSG_TYPE);
        expect(addImages([good], [img(1)]).error).toBeNull();
    });
});

describe("report form", () => {
    const report = { kind: "bug" as const, title: "T", description: "D", page_url: "u", build: "b", user_agent: "ua", map_name: "m.yml", map: "a: 1\n" };

    it("has the fields, the map as text and the images as images[]", () => {
        const a = new File(["x"], "a.png", { type: "image/png" });
        const b = new File(["y"], "b.png", { type: "image/png" });
        const f = reportForm(report, [a, b]);
        expect(f.get("title")).toBe("T");
        expect(f.get("map")).toBe("a: 1\n");
        const all = f.getAll("images[]") as File[];
        expect(all.map((x) => x.name)).toEqual(["a.png", "b.png"]);
        expect(f.has("images")).toBe(false);
    });

    it("skips absent fields", () => {
        const { map: _m, map_name: _n, ...rest } = report;
        expect([...reportForm(rest).keys()]).not.toContain("map");
    });

    it("is sent without a Content-Type and with the CSRF token; JSON stays JSON without images", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetchFn = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            const csrf = url.includes("csrf");
            return new Response(csrf ? null : JSON.stringify({ id: 1, status: "new" }), { status: csrf ? 204 : 201 });
        }) as unknown as typeof fetch;
        const api = new Api(new ApiClient({ base: "http://x", fetch: fetchFn, cookies: () => "XSRF-TOKEN=tok" }));
        await api.sendBugReport(report, [new File(["x"], "a.png", { type: "image/png" })]);
        const multi = calls.at(-1)!.init;
        expect(multi.body).toBeInstanceOf(FormData);
        const h = multi.headers as Record<string, string>;
        expect(h["Content-Type"]).toBeUndefined();
        expect(h["X-XSRF-TOKEN"]).toBe("tok");
        await api.sendBugReport(report);
        const json = calls.at(-1)!.init;
        expect(typeof json.body).toBe("string");
        expect((json.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });
});
