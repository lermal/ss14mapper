/** Open known forms from URL fragments without reloading the editor or changing its query. */
export function bindFormLinks(forms: ReadonlyMap<string, () => Promise<void>>, onError: (error: unknown) => void): () => void {
    let active = false;
    let disposed = false;
    const open = async (): Promise<void> => {
        if (active || disposed) return;
        const hash = location.hash;
        const form = forms.get(hash.slice(1));
        if (!form) return;
        active = true;
        try {
            // Auth forms keep the fragment while signIn captures the return URL.
            await form();
        } catch (error) {
            onError(error);
        } finally {
            active = false;
            if (disposed) return;
            if (location.hash === hash) {
                const url = new URL(location.href);
                url.hash = "";
                history.replaceState(history.state, "", url);
            } else {
                // If another link was followed while a form was open, handle the latest one next.
                void open();
            }
        }
    };
    const changed = () => void open();
    window.addEventListener("hashchange", changed);
    void open();
    return () => { disposed = true; window.removeEventListener("hashchange", changed); };
}
