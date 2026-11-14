// Settings changed in another tab of this browser arrive as `storage` events. The key bindings and the palette's
// categories are read again from storage; nothing is written or pushed to the account from here (the tab that
// made the change does that), so there is no echo.
import { storageKey as categoriesKey } from "../ui/categories";
import { STORAGE_KEY as KEYS_KEY } from "./keymap";

const CATEGORIES_PREFIX = categoriesKey("");

export interface CrossTabTarget {
    /** The stored key overrides changed. */
    keysChanged(): void;
    /** The stored categories of these builds changed. */
    categoriesChanged(forks: string[]): void;
}

export interface StorageEventLike {
    key: string | null;
    storageArea?: unknown;
}

/** Applies one storage event; `area` is this browser's localStorage (events of other areas are ignored). */
export function handleStorageEvent(e: StorageEventLike, area: unknown, target: CrossTabTarget): void {
    if (area && e.storageArea && e.storageArea !== area) return;
    if (e.key === null) {
        // storage was cleared
        target.keysChanged();
        return;
    }
    if (e.key === KEYS_KEY) target.keysChanged();
    else if (e.key.startsWith(CATEGORIES_PREFIX)) target.categoriesChanged([e.key.slice(CATEGORIES_PREFIX.length)]);
}

/** Listens for settings changed in other tabs; returns the stop function. */
export function watchOtherTabs(target: CrossTabTarget, win: Pick<Window, "addEventListener" | "removeEventListener"> = window, area: unknown = safeArea()): () => void {
    const on = (e: Event) => handleStorageEvent(e as StorageEvent, area, target);
    win.addEventListener("storage", on);
    return () => win.removeEventListener("storage", on);
}

function safeArea(): unknown {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}
