// Verify the deployed files, not just the build output: a missing nested page must fail release checks.
import assert from "node:assert/strict";

const origin = new URL(process.argv[2] ?? "https://ss14mapper.forged.by").origin;
const canonicalOrigin = "https://ss14mapper.forged.by";
const routes = ["/", "/ru/", "/guide/", "/guide/ru/"];

async function read(path) {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(20_000), redirect: "manual" });
    assert.equal(response.status, 200, `${path}: expected HTTP 200, received ${response.status}`);
    assert.doesNotMatch(response.headers.get("x-robots-tag") ?? "", /noindex/i, `${path}: indexing blocked`);
    return response.text();
}

let failed = false;
for (const path of [...routes, "/sitemap.xml", "/robots.txt"]) {
    try {
        const text = await read(path);
        if (path === "/sitemap.xml") {
            for (const route of routes) assert.ok(text.includes(`<loc>${canonicalOrigin}${route}</loc>`), `missing ${route}`);
        } else if (path === "/robots.txt") {
            assert.ok(text.includes(`Sitemap: ${canonicalOrigin}/sitemap.xml`), "missing sitemap directive");
        } else {
            assert.ok(text.includes(`<link rel="canonical" href="${canonicalOrigin}${path}">`), "wrong canonical");
            assert.doesNotMatch(text, /<meta[^>]+content="[^"]*noindex/i, "indexing blocked");
            const guide = path.startsWith("/guide/");
            const russian = path === "/ru/" || path === "/guide/ru/";
            assert.ok(text.includes(`<html lang="${russian ? "ru" : "en"}">`), "wrong page language");
            for (const [code, target] of [["en", guide ? "/guide/" : "/"], ["ru", guide ? "/guide/ru/" : "/ru/"]]) {
                assert.ok(text.includes(`<link rel="alternate" hreflang="${code}" href="${canonicalOrigin}${target}">`), `missing ${code} alternate`);
            }
        }
        console.log(`OK ${path}`);
    } catch (error) {
        failed = true;
        console.error(`FAIL ${path}: ${error.message}`);
    }
}
if (failed) process.exitCode = 1;
