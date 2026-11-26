import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const origin = "https://ss14mapper.forged.by";
const dist = new URL("../dist/", import.meta.url);
const routes = ["/", "/ru/", "/guide/", "/guide/ru/"];
const read = (path) => readFile(new URL(path, dist), "utf8");

function onlyMatch(html, pattern, label) {
    const matches = [...html.matchAll(pattern)];
    assert.equal(matches.length, 1, label);
    const value = matches[0][1].trim();
    assert.ok(value, label);
    return value;
}

const titles = new Set();
const descriptions = new Set();
for (const route of routes) {
    const html = await read(`${route.slice(1)}index.html`);
    const canonical = origin + route;
    const meta = (attr, name) => onlyMatch(html, new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`, "g"), `${route} ${name}`);
    const og = (name) => meta("property", `og:${name}`);
    titles.add(onlyMatch(html, /<title>([^<]*)<\/title>/g, `${route} title`));
    descriptions.add(meta("name", "description"));
    assert.equal(onlyMatch(html, /<link rel="canonical" href="([^"]*)"/g, route), canonical);
    assert.equal(og("url"), canonical);
    assert.equal(og("type"), "website");
    og("title");
    og("description");
    og("image:alt");
    assert.equal(og("image"), `${origin}/social-card.png`);
    assert.equal(og("image:width"), "1200");
    assert.equal(og("image:height"), "630");
    assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
    onlyMatch(html, /<h1\b[^>]*>([^<]*)<\/h1>/g, `${route} heading`);
    assert.ok(!/<meta[^>]+content="[^"]*noindex/i.test(html), `${route} is indexable`);
    const russian = route === "/ru/" || route === "/guide/ru/";
    const language = russian ? "ru" : "en";
    assert.match(html, new RegExp(`<html lang="${language}">`));
    if (route === "/" || route === "/ru/") {
        const catalog = JSON.parse(await readFile(new URL(`../src/locales/${language}.json`, import.meta.url), "utf8"));
        for (const [, key, text] of html.matchAll(/data-i18n="([^"]*)">([^<]*)/g)) {
            assert.equal(text, catalog[key], `${route} initial translation: ${key}`);
        }
        assert.ok(html.includes(`id="start-guide" href="${russian ? "/guide/ru/" : "/guide/"}"`));
        assert.match(html, /<div id="start" class="start">/);
        assert.match(html, /<script type="module"/);
        for (const [code, path] of [["en", "/"], ["ru", "/ru/"]]) {
            assert.ok(html.includes(`<link rel="alternate" hreflang="${code}" href="${origin}${path}">`), `${route} alternate ${code}`);
        }
        for (const id of ["start-build", "start-open", "start-new", "recent-title", "start-shortcuts"]) {
            assert.ok(html.includes(`id="${id}"`), `${route} initial workspace ${id}`);
        }
    } else {
        assert.ok(html.includes(`<a href="${russian ? "/ru/" : "/"}"`), `${route} editor link`);
        for (const [code, path] of [["en", "/guide/"], ["ru", "/guide/ru/"]]) {
            assert.ok(html.includes(`<link rel="alternate" hreflang="${code}" href="${origin}${path}">`), `${route} alternate ${code}`);
        }
        assert.doesNotMatch(html, /<script\b|rel="modulepreload"/);
    }
}

assert.equal(titles.size, routes.length, "unique titles");
assert.equal(descriptions.size, routes.length, "unique descriptions");
const sitemap = await read("sitemap.xml");
assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">(?:\s*<url><loc>[^<]+<\/loc><\/url>)+\s*<\/urlset>\s*$/);
assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]), routes.map((route) => origin + route));
const robots = await read("robots.txt");
assert.match(robots, /^User-agent: \*\r?\nAllow: \/$/m);
assert.equal(onlyMatch(robots, /^Sitemap: (.+)$/gm, "robots sitemap"), `${origin}/sitemap.xml`);
assert.match(await read("favicon.svg"), /<svg\b/);
const image = await sharp(await readFile(new URL("social-card.png", dist))).metadata();
assert.deepEqual([image.format, image.width, image.height], ["png", 1200, 630]);
const admin = await read("admin/content/index.html");
assert.match(admin, /<meta name="robots" content="noindex, nofollow">/);
assert.match(admin, /<script type="module"/);
assert.ok((await read("content.css")).includes(".markdown"));
console.log("Public HTML, admin entry, sitemap, robots and share assets verified.");
