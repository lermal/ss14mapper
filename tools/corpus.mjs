// Lists the map corpus used by tests: every .yml under <corpus>/<fork>/Resources/Maps.
// The corpus lives outside the repository; its location comes from SS14MAPPER_CORPUS.
import fs from "node:fs";
import path from "node:path";

export function corpusRoot() {
    return process.env.SS14MAPPER_CORPUS ?? path.resolve(import.meta.dirname, "../../ss14mapper-corpus");
}

export function corpusFiles(root = corpusRoot()) {
    if (!fs.existsSync(root)) return [];
    const files = [];
    for (const fork of fs.readdirSync(root).sort()) {
        const maps = path.join(root, fork, "Resources", "Maps");
        if (!fs.existsSync(maps)) continue;
        for (const file of fs.readdirSync(maps, { recursive: true }).sort()) {
            if (String(file).endsWith(".yml")) files.push({ fork, file: path.join(maps, String(file)) });
        }
    }
    return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const files = corpusFiles();
    const byFork = Object.groupBy(files, (f) => f.fork);
    console.log(`corpus: ${corpusRoot()}`);
    for (const [fork, list] of Object.entries(byFork)) console.log(`  ${fork}: ${list.length} maps`);
}
