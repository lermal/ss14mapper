// Properties of the map entity itself: which parallax the game draws behind it (its `Parallax` component).
import type { MapDocument } from "./document";

/** `ParallaxComponent.Parallax`'s default (Content.Shared/Parallax/ParallaxComponent.cs). */
export const PARALLAX_COMPONENT_DEFAULT = "Default";

/**
 * Components a new `Parallax` goes after: those the map gets when it is made (MapSystem) and the ones that come
 * before `Parallax` on the maps of the corpus (FTLDestination, MapLight). Later ones (MapAtmosphere, LoadedMap,
 * ChunkContainer) stay after it, as in the game's files.
 */
export const PARALLAX_AFTER: readonly string[] = ["MetaData", "Transform", "Map", "GridTree", "FTLDestination", "Broadphase", "OccluderTree", "MapLight"];

/** The file's map entity (the first listed in `maps`), or null for files without one (shuttles). */
export function mapEntity(doc: MapDocument): number | null {
    return doc.mapEntities()[0] ?? null;
}

/** The parallax a map entity's own `Parallax` component names, or null when it has none. */
export function ownParallax(doc: MapDocument, uid: number): string | null {
    const c = doc.components(uid).find((x) => x.type === "Parallax");
    if (!c) return null;
    const v = c.data.parallax;
    return typeof v === "string" && v ? v : PARALLAX_COMPONENT_DEFAULT;
}

/**
 * The parallax the game draws on a map (`ParallaxSystem.GetParallax`): the component's, else `fallback`; null when
 * the map has a biome (ParallaxOverlay draws nothing there).
 */
export function mapParallax(doc: MapDocument, uid: number, fallback: string): string | null {
    if (doc.components(uid).some((x) => x.type === "Biome")) return null;
    return ownParallax(doc, uid) ?? fallback;
}

/**
 * Sets the map's parallax as one undo step. Picking the default (`fallback`) removes the `Parallax` component: maps
 * that use the default have none. Otherwise the component is written with `parallax: <id>`, a new one after the
 * map's own components (see `PARALLAX_AFTER`). Returns whether the file changed.
 */
export function setMapParallax(doc: MapDocument, uid: number, id: string, fallback: string): boolean {
    const own = ownParallax(doc, uid);
    if (own === id || (own === null && id === fallback)) return false;
    if (id === fallback) return doc.removeComponent(uid, "Parallax");
    doc.setComponent(uid, "Parallax", `parallax: ${id}`, { after: PARALLAX_AFTER });
    return true;
}
