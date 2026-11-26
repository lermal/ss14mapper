import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig } from "vitest/config";

const corpus = process.env.SS14MAPPER_CORPUS ?? path.resolve(import.meta.dirname, "../ss14mapper-corpus");
const packs = process.env.SS14MAPPER_PACKS ?? path.join(corpus, "packs");

const contentApi = process.env.SS14MAPPER_DEV_API;

const TYPES: Record<string, string> = { ".json": "application/json", ".webp": "image/webp", ".yml": "text/yaml; charset=utf-8" };

/** Serves files under `root` at `prefix` (development only; production serves packs as static files). */
function serveDir(prefix: string, root: string): Connect.NextHandleFunction {
    return (req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]!);
        if (!url.startsWith(prefix)) return next();
        const file = path.resolve(root, "." + url.slice(prefix.length - 1));
        if (!file.startsWith(path.resolve(root)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
        fs.createReadStream(file).pipe(res);
    };
}

/** Local packs and the map corpus for the development server. */
function localData(): Plugin {
    return {
        name: "ss14mapper-local-data",
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url !== "/packs/index.json") return next();
                const forks = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "tools/forks.json"), "utf8")) as Array<{ id: string; name: string; repo?: string }>;
                const available = forks.filter((f) => fs.existsSync(path.join(packs, f.id, "manifest.json"))).map(({ id, name, repo }) => ({ id, name, repo }));
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(available));
            });
            server.middlewares.use(serveDir("/packs/", packs));
            server.middlewares.use(serveDir("/corpus/", corpus));
        },
    };
}

export default defineConfig({
    appType: "mpa",
    plugins: [localData()],
    build: {
        target: "es2022",
        sourcemap: true,
        rolldownOptions: {
            input: [path.resolve(import.meta.dirname, "admin/content/index.html"), path.resolve(import.meta.dirname, "index.html"), path.resolve(import.meta.dirname, "ru/index.html"), path.resolve(import.meta.dirname, "guide/index.html"), path.resolve(import.meta.dirname, "guide/ru/index.html")],
        },
    },
    server: {
        host: "127.0.0.1",
        port: 8767,
        strictPort: true,
        proxy: contentApi ? {
            '/api': { target: contentApi, changeOrigin: true, rewrite: (url) => url.replace(/^\/api/, ''), cookieDomainRewrite: '' },
            '^/(guide|faq)(/|$)': { target: contentApi },
            '/content-media/': { target: contentApi },
            '/sitemap.xml': { target: contentApi },
        } : undefined,
    },
    test: {
        include: ["tests/**/*.test.ts"],
        // tests over the whole map corpus take minutes when they run in parallel
        testTimeout: 600_000,
    },
});
