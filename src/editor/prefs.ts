// Tool choices that outlast a reload: the decal snap (shared by the brush and moves of selected decals) and the
// brush's Defaults. Kept in localStorage as one small JSON value; unreadable data gives the defaults.
import type { KeyStorage } from "./keymap";
import type { DecalSnap } from "./tools";

export interface EditorPrefs {
    decalSnap: DecalSnap;
    /** The decal placer's Auto ("Defaults"). */
    decalAuto: boolean;
}

export const DEFAULT_PREFS: Readonly<EditorPrefs> = { decalSnap: "tile", decalAuto: false };

const KEY = "ss14mapper.editor";
const SNAPS: readonly DecalSnap[] = ["tile", "corner", "free"];

export function loadPrefs(storage: KeyStorage | null): EditorPrefs {
    const prefs = { ...DEFAULT_PREFS };
    try {
        const v = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<Record<keyof EditorPrefs, unknown>> | null;
        if (!v || typeof v !== "object") return prefs;
        if (SNAPS.includes(v.decalSnap as DecalSnap)) prefs.decalSnap = v.decalSnap as DecalSnap;
        if (typeof v.decalAuto === "boolean") prefs.decalAuto = v.decalAuto;
    } catch {
        // defaults
    }
    return prefs;
}

export function savePrefs(storage: KeyStorage | null, prefs: EditorPrefs): void {
    try {
        storage?.setItem(KEY, JSON.stringify(prefs));
    } catch {
        // storage full or denied: the choice lasts until the page closes
    }
}
