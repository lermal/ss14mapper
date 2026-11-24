// The list of builds the editor can use: from the API in production, from the local packs in development.
import { t as translate } from "../i18n";
import type { Fork } from "../ui/shell";

/** The API's host, set when the site is built (`VITE_API_URL`); unset, the development server's packs are used. */
export const API_URL: string | undefined = import.meta.env.VITE_API_URL?.replace(/\/+$/, "") || undefined;

interface ApiFork {
    id: string;
    name: string;
    repo: string;
    branch: string;
    commit: string;
    pack: string;
}

/** Fetches JSON; any failure becomes one plain message. */
async function getJson<T>(url: string): Promise<T> {
    try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        if (r.ok) return (await r.json()) as T;
    } catch {
        // offline or blocked: the same message as a bad status
    }
    throw new Error(translate("Could not load the list of builds. Try reloading the page."));
}

export async function loadForks(): Promise<Fork[]> {
    if (API_URL) {
        const forks = await getJson<ApiFork[]>(`${API_URL}/forks`);
        return forks.map((f) => ({ id: f.id, name: f.name, repo: f.repo, pack: f.pack }));
    }
    const forks = await getJson<Omit<Fork, "pack">[]>("/packs/index.json");
    return forks.map((f) => ({ ...f, pack: `/packs/${f.id}/` }));
}
