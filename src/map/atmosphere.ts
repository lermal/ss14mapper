import type { PrototypeData } from "../pack/format";
import type { Pack } from "../pack/loader";
import type { Scene } from "../render/scene";
import { formatFloat, type MapDocument } from "./document";
import { entryText, get, map, parseDocument, scalar, seq, type YMap, type YNode } from "./yaml";

const ATMOS_CHUNK_SIZE = 4;
const CELL_VOLUME = 2500;
const ROOM_TEMP = 293.15;
const FREEZER_TEMP = 235;
const GAS_CONSTANT = Math.fround(8.314462618);
const ATMOSPHERE = Math.fround(101.325);
const GAS_MINER_PRESSURE = 6500;
const SHUTTLE_GAS = 2500;
const GAS_INDEX: Record<string, number> = { Oxygen: 0, Nitrogen: 1, Plasma: 3, WaterVapor: 5 };

type Mix = { temperature: number; moles: Record<string, number> };
type Profile = { arraySize: number | null; mixtures: Mix[] };

function moles(pressure: number, temperature: number): number {
    return Math.fround(Math.fround(pressure * CELL_VOLUME) / Math.fround(Math.fround(temperature) * GAS_CONSTANT));
}

function air(temperature: number, pressure: number): Mix {
    const total = moles(pressure, temperature);
    return {
        temperature,
        moles: {
            Oxygen: Math.fround(total * Math.fround(0.21)),
            Nitrogen: Math.fround(total * Math.fround(0.79)),
        },
    };
}

/** The round-start mixes in AtmosphereSystem.Commands.cs. Frontier and Triad use different marker indices. */
function mixtures(fork: "common" | "frontier" | "triad"): Mix[] {
    const miner = moles(GAS_MINER_PRESSURE, ROOM_TEMP);
    const standard = air(ROOM_TEMP, ATMOSPHERE);
    const result: Mix[] = [
        standard,
        { temperature: ROOM_TEMP, moles: {} },
        { temperature: ROOM_TEMP, moles: { Oxygen: miner } },
        { temperature: ROOM_TEMP, moles: { Nitrogen: miner } },
        { temperature: ROOM_TEMP, moles: { Plasma: miner } },
        { temperature: 5000, moles: { Oxygen: miner, Plasma: miner } },
        air(FREEZER_TEMP, ATMOSPHERE),
        { temperature: ROOM_TEMP, moles: { Nitrogen: moles(ATMOSPHERE, ROOM_TEMP) } },
    ];
    if (fork !== "triad") result.push(air(ROOM_TEMP, GAS_MINER_PRESSURE));
    if (fork !== "common") {
        result.push(
            { temperature: ROOM_TEMP, moles: { Oxygen: SHUTTLE_GAS } },
            { temperature: ROOM_TEMP, moles: { Nitrogen: SHUTTLE_GAS } },
            { temperature: ROOM_TEMP, moles: { Plasma: SHUTTLE_GAS } },
            { temperature: fork === "frontier" ? 340 : 330, moles: { ...standard.moles, WaterVapor: standard.moles.Nitrogen! } },
        );
    }
    return result;
}

function legacyMoles(gridFields: Record<string, unknown> | undefined, outside: YNode | undefined): Profile["arraySize"] | undefined {
    const data = gridFields?.data as { uniqueMixes?: unknown[] } | undefined;
    const saved = data?.uniqueMixes ?? gridFields?.uniqueMixes;
    const outsideMoles = get(outside, "moles");
    for (const mix of Array.isArray(saved) ? saved : []) {
        if (!mix || typeof mix !== "object" || !("moles" in mix)) continue;
        if (Array.isArray(mix.moles)) return mix.moles.length >= 6 ? mix.moles.length : undefined;
        if (mix.moles && typeof mix.moles === "object") return null;
    }
    if (outsideMoles?.kind === "seq" && outsideMoles.items.length >= 6) return outsideMoles.items.length;
    if (outsideMoles?.kind === "map") return null;
    return undefined;
}

function mixNode(temperature: number | null, volume: number, gases: Record<string, number>, arraySize: number | null, immutable = false): YMap {
    const moles = arraySize === null
        ? map(Object.entries(gases).map(([gas, amount]) => [gas, scalar(formatFloat(amount))]))
        : seq(Array.from({ length: arraySize }, (_, i) => {
            const gas = Object.keys(GAS_INDEX).find((gas) => GAS_INDEX[gas] === i);
            return scalar(formatFloat(gas ? gases[gas] ?? 0 : 0));
        }));
    const result = map([["volume", scalar(formatFloat(volume))], ["moles", moles]]);
    if (temperature !== null) result.entries.unshift({ key: scalar("temperature"), value: scalar(formatFloat(temperature)) });
    if (immutable) result.entries.push({ key: scalar("immutable"), value: scalar("True") });
    return result;
}

/** Copies a mixture into the deeper grid data mapping without its original indentation or comments. */
function copyMixtureValue(value: YNode): YNode {
    if (value.kind === "map") return map(value.entries.map((entry) => [entry.key.value, copyMixtureValue(entry.value)]), value.tag);
    if (value.kind === "seq") return seq(value.items.map((item) => copyMixtureValue(item.value)), value.tag);
    return value;
}

function mapAir(doc: MapDocument, grid: number): YMap | undefined {
    for (let uid: number | null = grid, depth = 0; uid !== null && doc.proto(uid) !== undefined && depth < 64; depth++) {
        const component = doc.componentOverride(uid, "MapAtmosphere");
        if (component) {
            const air = get(parseDocument(component.text + "\n").root, "mixture");
            if (air?.kind !== "map") return undefined;
            // Map atmosphere is shared and immutable, regardless of how the map spells its fields.
            const fields: Array<[string, YNode]> = air.entries.filter((field) => field.key.value !== "immutable")
                .map((field) => [field.key.value, copyMixtureValue(field.value)]);
            fields.push(["immutable", scalar("True")]);
            return map(fields);
        }
        uid = doc.transform(uid).parent;
    }
    return undefined;
}

const DIRECTIONS: Record<string, number> = { north: 1, south: 2, east: 4, west: 8, northeast: 5, southeast: 6, northwest: 9, southwest: 10, all: 15 };
const CCW = [2, 4, 1, 8];

function blockedDirections(value: unknown, angle: number): number {
    const mask = value === undefined ? 15 : String(value).replace(/[\[\]]/g, "").split(/[\s,|]+/).reduce((mask, flag) => {
        const number = Number(flag);
        return mask | (Number.isInteger(number) ? number : DIRECTIONS[flag.toLowerCase()] ?? 0);
    }, 0);
    const turns = Math.round(angle / (Math.PI / 2));
    return CCW.reduce((blocked, bit, i) => blocked | (mask & bit ? CCW[((i + turns) % 4 + 4) % 4]! : 0), 0);
}

export interface GridAtmosphereResult {
    changed: boolean;
    filled: number;
    exposed: number;
    sealed: number;
}

/** Rebuilds the grid's serialized starting mixtures. The game initializes its own runtime simulation from them. */
export function fixGridAtmosphere(
    doc: MapDocument, scene: Scene, pack: Pack, prototypes: PrototypeData, grid: number,
): GridAtmosphereResult {
    if (!scene.grids.includes(grid)) throw new Error("Select a valid grid");
    const previous = doc.componentOverride(grid, "GridAtmosphere");
    const version = Number(previous?.data.version ?? 1);
    if (version !== 1 && version !== 2) throw new Error(`Unsupported grid atmosphere version ${version}`);

    const repo = pack.manifest.fork.repo.toLowerCase().replace(/(?:\.git)?\/$|\.git$/g, "");
    const fork = repo.endsWith("/triad-sector/triad_sector") ? "triad"
        : repo.endsWith("/new-frontiers-14/frontier-station-14") ? "frontier"
        : "common";
    const outside = mapAir(doc, grid);
    const savedEncoding = legacyMoles(previous?.data, outside);
    const namedFork = /\/(space-wizards\/space-station-14|goob-station\/goob-station|reserve-station\/reserve-station)$/.test(repo);
    const arraySize = fork === "triad" ? 16 : fork === "frontier" ? 12 : namedFork ? null : savedEncoding;
    if (arraySize === undefined) throw new Error("No supported gas format for this build. Use a map with saved atmosphere or select a supported build.");
    const profile = { arraySize, mixtures: mixtures(fork) };

    const tileSize = Number(doc.componentOverride(grid, "MapGrid")?.data.tileSize ?? 1);
    if (tileSize !== 1) throw new Error("Fix grid atmosphere requires a grid with unit-size tiles");
    const defaultSpace = outside ?? mixNode(null, CELL_VOLUME, {}, profile.arraySize, true);
    const mixIndexes = new Map<number, number>();
    const unique: YNode[] = [];
    const chunks = new Map<string, Map<number, number>>();
    const result: GridAtmosphereResult = { changed: false, filled: 0, exposed: 0, sealed: 0 };

    for (const [x, y] of scene.tileCells(grid)) {
        const tile = scene.tileAt(grid, x, y)!;
        const def = pack.tile(tile);
        if (!def && tile !== "Space") throw new Error(`Unknown tile ${tile}. Select a compatible build first.`);
        const mapAtmosphere = tile === "Space" || def?.isSpace || (fork === "triad" && def?.sprite?.startsWith("_Mono/Tiles/lattice/"));
        let mode = -1; // -1 is the surrounding map's immutable mixture
        if (mapAtmosphere) {
            result.exposed++;
        } else {
            mode = 0;
            let blocked = 0, noAir = false;
            for (const uid of scene.anchoredAt(grid, x, y)) {
                const original = doc.proto(uid);
                const proto = original ? pack.migrate(original) : null;
                const components = proto ? pack.fullComponents(prototypes, proto) : {};
                const airtight = doc.componentOverride(uid, "Airtight")?.data;
                if (components.Airtight || airtight) {
                    const fields = { ...components.Airtight, ...airtight };
                    if (String(fields.airBlocked).toLowerCase() !== "false") {
                        const angle = doc.transform(uid).rotation;
                        blocked |= blockedDirections(fields.airBlockedDirection, angle);
                        noAir ||= String(fields.noAirWhenFullyAirBlocked).toLowerCase() !== "false";
                    }
                }
                const marker = doc.componentOverride(uid, "AtmosFixMarker")?.data;
                if (components.AtmosFixMarker || marker) {
                    const fields = { ...components.AtmosFixMarker, ...marker };
                    mode = Number(fields.mode ?? 0);
                }
            }
            if (blocked === 15 && noAir) {
                result.sealed++;
                continue;
            }
            if (!Number.isInteger(mode) || mode < 0 || mode >= profile.mixtures.length) {
                throw new Error(`Unsupported atmosphere marker mode ${mode} at ${x}, ${y}`);
            }
            result.filled++;
        }

        let index = mixIndexes.get(mode);
        if (index === undefined) {
            index = unique.length;
            mixIndexes.set(mode, index);
            const mix = profile.mixtures[mode];
            unique.push(mix ? mixNode(mix.temperature, CELL_VOLUME, mix.moles, profile.arraySize) : defaultSpace);
        }
        const cx = Math.floor(x / ATMOS_CHUNK_SIZE), cy = Math.floor(y / ATMOS_CHUNK_SIZE);
        const key = `${cx},${cy}`;
        const bit = (x - cx * ATMOS_CHUNK_SIZE) + (y - cy * ATMOS_CHUNK_SIZE) * ATMOS_CHUNK_SIZE;
        let chunk = chunks.get(key);
        if (!chunk) chunks.set(key, (chunk = new Map()));
        chunk.set(index, (chunk.get(index) ?? 0) | (1 << bit));
    }

    const data = map([["chunkSize", scalar(String(ATMOS_CHUNK_SIZE))]]);
    if (unique.length) {
        data.entries.push(...map([
            ["uniqueMixes", seq(unique)],
            ["tiles", map([...chunks].map(([pos, values]) => [pos, map([...values].map(([id, flags]) => [String(id), scalar(String(flags))]))]))],
        ]).entries);
    }
    const other = previous?.text ? parseDocument(previous.text + "\n").root.entries : [];
    const fields = map([["version", scalar("2")], ["data", data]]);
    fields.entries.push(...other.filter(({ key }) => !["version", "data", "uniqueMixes", "tiles"].includes(key.value)));
    const next = fields.entries.map((field) => entryText(field, 0)).join("\n");

    const overlay = doc.componentOverride(grid, "GasTileOverlay");
    result.changed = previous?.text !== next || !overlay;
    if (result.changed) doc.batch("Fix grid atmosphere", () => {
        doc.setComponent(grid, "GridAtmosphere", next, { after: ["MapGrid", "Gravity", "DecalGrid"] });
        if (!overlay) doc.setComponent(grid, "GasTileOverlay", "", { after: ["GridAtmosphere"] });
    });
    return result;
}
