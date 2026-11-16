// Editor: open a map file or make a new one, draw it with the asset pack of a build, edit it, keep it in the
// browser's map library (Save) or download it as a file.
import { api } from "./api/client";
import { SettingsSync } from "./api/settings-sync";
import { EditorController } from "./editor/controller";
import { watchOtherTabs } from "./editor/cross-tab";
import { browserStorage, Keymap } from "./editor/keymap";
import { SettingsWindow } from "./editor/settings";
import { i18n, language, languageUrl, t as translate } from "./i18n";
import { MapDocument } from "./map/document";
import { mapEntity, mapParallax, ownParallax, setMapParallax } from "./map/map-props";
import { loadForks } from "./pack/forks";
import { Pack, indexOf, loadBuildIndex } from "./pack/loader";
import { pickBuild } from "./pack/pick";
import { MapCanvas } from "./render/canvas";
import { ParallaxBackground } from "./render/parallax";
import { Scene } from "./render/scene";
import { confirmUnsaved, dialog, showAbout } from "./ui/dialog";
import { formatSize, formatWhen, indexedDbBackend, MapLibrary, type LibraryEntry } from "./ui/library";
import { askMapName, manageLibrary, newMapDialog } from "./ui/map-dialogs";
import { Inspector } from "./ui/inspector";
import { LinkPanel } from "./ui/link-panel";
import { Loading } from "./ui/loading";
import type { MenuItem } from "./ui/menus";
import type { Session } from "./editor/controller";
import type { BuildIndex, ParallaxData } from "./pack/format";
import { Palette } from "./ui/palette";
import { ParallaxPicker } from "./ui/parallax-picker";
import { Shell, type Fork } from "./ui/shell";
import { ShortcutsOverlay } from "./ui/shortcuts";
import { StartScreen } from "./ui/start-screen";
import { Account } from "./ui/account";
import { installTheme } from "./ui/theme";
import { showToast } from "./ui/toast";

installTheme();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const app = $("app");
const fileInput = $<HTMLInputElement>("file");
const canvasEl = $<HTMLCanvasElement>("map");
const propertiesEl = $("properties");
document.documentElement.lang = language();
document.documentElement.dir = i18n.dir();
for (const [id, label] of [["rail", "Tools"], ["palette", "Palette"], ["view", "Map"], ["properties", "Properties"]] as const) {
    $(id).setAttribute("aria-label", translate(label));
}
const map = new MapCanvas(canvasEl, $<HTMLCanvasElement>("overlay"));
const palette = new Palette($("palette"));
const inspector = new Inspector($("inspector"));
const linkPanel = new LinkPanel($("link-panel"));
const storage = browserStorage();
const keymap = new Keymap(undefined, storage);
const parallax = new ParallaxBackground($<HTMLCanvasElement>("parallax"), storage);
map.background = parallax;
const picker = new ParallaxPicker();
const controller = new EditorController({
    canvas: canvasEl,
    map,
    palette,
    keymap,
    inspector,
    linkPanel,
    properties: (shown) => {
        propertiesEl.hidden = !shown;
    },
    prefs: storage,
    parallax,
    propertiesTop: (s, uid) => {
        // the map entity, or a grid of a file without one (a shuttle: the background is a preview)
        const m = mapEntity(s.doc);
        if (uid !== m && (m !== null || !s.doc.listedGrids().includes(uid))) return null;
        pickerFor = { session: s, uid };
        refreshPicker();
        return picker.element;
    },
});
inspector.onEdit = (message) => controller.say(message);

// ---- parallax

/** Backgrounds chosen for files without a map entity: shown, never written. */
const previews = new WeakMap<MapDocument, string>();
/** What the picker in the Properties column edits. */
let pickerFor: { session: Session; uid: number } | null = null;
let parallaxDoc: { doc: MapDocument; stop: () => void } | null = null;

/** The parallax the editor shows for a file: the map's, or the preview chosen for a file without a map entity. */
function shownParallax(doc: MapDocument, data: ParallaxData): string | null {
    const m = mapEntity(doc);
    if (m !== null) return mapParallax(doc, m, data.default);
    return previews.get(doc) ?? data.default;
}

/** Shows the open file's parallax; resolves once its images are loaded (nothing loads while it is off). */
async function updateParallax(doc: MapDocument, pack: Pack): Promise<void> {
    const data = await pack.parallax().catch(() => null);
    if (current?.doc !== doc) return;
    await parallax.show(pack, data ? shownParallax(doc, data) : null);
}

function refreshPicker(): void {
    const target = pickerFor;
    if (!target) return picker.set(null);
    const { session, uid } = target;
    const { doc, pack } = session;
    void pack.parallax().catch(() => null).then((data) => {
        if (pickerFor !== target) return;
        if (!data) return picker.set(null);
        const isMap = uid === mapEntity(doc);
        picker.set({
            pack,
            data,
            mode: isMap ? "map" : "preview",
            current: isMap ? (ownParallax(doc, uid) ?? data.default) : (previews.get(doc) ?? data.default),
            onPick: (id) => {
                if (isMap) {
                    if (setMapParallax(doc, uid, id, data.default)) controller.say(translate("Parallax: {{1}}", { 1: id }));
                } else {
                    previews.set(doc, id);
                    void updateParallax(doc, pack);
                    refreshPicker();
                }
            },
        });
    });
}

/** Follows edits of the map entity (its Parallax component, undo and redo) for the background and the picker. */
function watchParallax(doc: MapDocument, pack: Pack): void {
    parallaxDoc?.stop();
    const stop = doc.onChange((change) => {
        const m = mapEntity(doc);
        if (m === null || !change.entities.includes(m)) return;
        void updateParallax(doc, pack);
        if (pickerFor?.session.doc === doc) refreshPicker();
    });
    parallaxDoc = { doc, stop };
}

const settings = new SettingsWindow(keymap);
const shortcuts = new ShortcutsOverlay(keymap);
shortcuts.onCustomize = () => settings.open();
const library = new MapLibrary(indexedDbBackend(), {
    // asked on the first save; without it the browser may clear the library when space runs low
    persist: () => void navigator.storage?.persist?.().catch(() => false),
});
/** The library's maps as of the last change, newest first (menus are built from it synchronously). */
let entries: LibraryEntry[] = [];
// the old list of recent files (names only; the files were not kept)
try {
    storage?.removeItem("ss14mapper.recent");
} catch {
    // denied
}

const loadingScreen = new Loading();
const params = new URLSearchParams(location.search);
const packs = new Map<string, Promise<Pack>>();
let forks: Fork[] = [];
/** The open map and its library record (null when the browser could not keep it); switching builds keeps the document. */
let current: { name: string; doc: MapDocument; id: string | null } | null = null;
/** A map has been drawn (the editor shows instead of the start screen). */
let shown = false;
let palettePack: Pack | null = null;

const fork = () => shell.forkSelect.value;
const forkName = (id: string) => forks.find((f) => f.id === id)?.name ?? id;
const RECENT_MENU = 10;

function openAbout(): void {
    const f = controller.current?.pack.manifest.fork;
    void showAbout(f ? translate("{{1}}, {{2}} at {{3}}", { 1: forkName(f.id), 2: f.branch, 3: f.commit.slice(0, 7) }) : "");
}

const shell = new Shell(
    { topbar: $("topbar"), optionsbar: $("optionsbar"), rail: $("rail"), statusbar: $("statusbar"), controls: $("map-controls") },
    controller,
    keymap,
    {
        setFork,
        recent: (): MenuItem[] => {
            const items: MenuItem[] = entries.slice(0, RECENT_MENU).map((m) => ({
                label: m.name,
                note: `${forkName(m.build)} · ${formatWhen(m.savedAt)} · ${formatSize(m.size)}`,
                checked: m.id === current?.id ? true : undefined,
                run: () => void reopen(m),
            }));
            if (entries.length > RECENT_MENU) items.push("-", { label: translate("All {{1}} maps…", { 1: entries.length }), run: () => void manage() });
            return items;
        },
        library: () => void manage(),
        settings: () => settings.open(),
        shortcuts: () => shortcuts.toggle(),
        about: openAbout,
        setLanguage: (code) => void setLanguage(code),
        ...(api ? { addBuild: () => void account?.addBuild(), reportBug: () => void account?.reportBug() } : {}),
    },
);
controller.onRefresh = () => shell.update();
controller.handle("help.shortcuts", () => shortcuts.toggle());
controller.handle("file.open", () => pickFile());
controller.handle("file.new", () => void newMap());
controller.handle("file.save", () => void save());
controller.handle("file.saveAs", () => void saveAs());

const start = new StartScreen($("start"), {
    setFork,
    open: () => pickFile(),
    newMap: () => void newMap(),
    reopen: (m) => void reopen(m),
    manage: () => void manage(),
    shortcuts: () => shortcuts.open(),
    about: openAbout,
    setLanguage,
    ...(api ? { addBuild: () => void account?.addBuild() } : {}),
});

// ---- account (only with the API; local development has none)

/** Key bindings and palette categories kept in the account while signed in. */
const sync = api
    ? new SettingsSync({
          api,
          // the same localStorage, with its listing of keys (categories are stored per build)
          storage: storage as Storage | null,
          keys: {
              known: (id) => !!keymap.action(id),
              get: () => keymap.overridesById(),
              set: (bindings) => keymap.replaceOverrides(bindings),
          },
          categoriesChanged: (forks) => palette.reloadCategories(forks),
      })
    : null;
// Settings changed in another tab of this browser are applied live; they are not pushed from here
// (the tab that made the change syncs them).
let fromOtherTab = false;
watchOtherTabs({
    keysChanged: () => {
        fromOtherTab = true;
        try {
            keymap.reload();
        } finally {
            fromOtherTab = false;
        }
    },
    categoriesChanged: (forks) => palette.reloadCategories(forks),
});
if (sync) {
    keymap.onChange(() => {
        if (!fromOtherTab) sync.changed("keys");
    });
    palette.onCategoriesSaved = () => sync.changed("categories");
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") sync.flush();
    });
}

const account = api
    ? new Account(api, {
          // the page is left for GitHub: unsaved edits are saved to the browser first, or the sign-in is cancelled
          beforeSignIn: async () => (controller.leaving = await leaveCurrent()),
          signedIn: (me) => void sync?.start(me.id),
          signedOut: () => sync?.stop(),
          buildsChanged: () => void refreshForks(),
          bugContext: () => ({
              build: controller.current?.pack.manifest.fork?.id ?? fork(),
              buildName: forkName,
              mapName: controller.current?.name ?? null,
              mapText: () => controller.text(),
          }),
      })
    : null;
if (account) {
    account.mount(start.header);
    account.mount($("topbar"));
    // read in the background: opening maps does not wait for it
    void account.load();
}
// back from a failed sign-in
if (params.get("signin") === "failed") {
    showToast(translate("Sign-in failed."), undefined, 6000);
    const url = new URL(location.href);
    url.searchParams.delete("signin");
    history.replaceState(null, "", url);
}

const loadPack = (id: string) => {
    let p = packs.get(id);
    if (!p) {
        packs.set(id, (p = Pack.load(forks.find((f) => f.id === id)?.pack ?? `/packs/${id}/`)));
        // a failed load is tried again next time
        p.catch(() => packs.delete(id));
    }
    return p;
};

/** Reads the library's list again (after a change, or when another tab may have changed it). */
async function refreshLibrary(): Promise<void> {
    entries = await library.list();
    if (!start.container.hidden) start.setRecent(entries);
}

/**
 * Points the address at the open map's library record, so reloading the page opens the same map again
 * (as last saved to this browser).
 */
function syncUrl(): void {
    const url = new URL(location.href);
    url.searchParams.delete("map");
    url.searchParams.delete("fork");
    if (current?.id) url.searchParams.set("open", current.id);
    else url.searchParams.delete("open");
    if (url.href !== location.href) history.replaceState(null, "", url);
}

function showStart(error = ""): void {
    app.hidden = true;
    start.container.hidden = false;
    start.setError(error);
    start.setRecent(entries);
}

/** A failure: on the start screen while no map is shown, else as a notice. */
function fail(message: string): void {
    loadingScreen.hide();
    if (!shown) return showStart(message);
    controller.say(message);
    showToast(message);
}

/** Loads run one after another; one that a newer load has superseded is skipped or abandoned. */
let loading = 0;
let queue: Promise<void> = Promise.resolve();

function show(): Promise<void> {
    const load = ++loading;
    return (queue = queue.then(() => showNow(load)));
}

async function showNow(load: number): Promise<void> {
    if (!current || load !== loading) return;
    const { name, doc } = current;
    const started = performance.now();
    // the editor is laid out before the map is drawn, so the view has its size
    start.container.hidden = true;
    app.hidden = false;
    shell.loading(translate("Loading {{1}}…", { 1: name }));
    try {
        await loadingScreen.show(name, translate("Loading {{1}}", { 1: forkName(fork()) }));
        const pack = await loadPack(fork());
        if (load !== loading) return;
        if (pack !== palettePack) palette.setPack((palettePack = pack));
        await loadingScreen.step(translate("Building"));
        const scene = new Scene(doc, pack);
        await loadingScreen.step(translate("Drawing"));
        await map.show(scene, pack);
        if (load !== loading) return;
        if (parallax.enabled) await loadingScreen.step(translate("Loading parallax"));
        watchParallax(doc, pack);
        await updateParallax(doc, pack);
        if (load !== loading) return;
        loadingScreen.hide();
        controller.open({ name: current.name, libraryId: current.id, doc, scene, pack });
        // development: the open map for the console and measurements
        if (import.meta.env.DEV) Object.assign(window, { mapper: { doc, scene, map, pack, palette, controller, inspector, shell, library } });
        controller.fit();
        shown = true;
        syncUrl();
        shell.loadInfo = translate("Loaded in {{1}} ms", { 1: Math.round(performance.now() - started) });
        shell.update();
    } catch (e) {
        if (load !== loading) return;
        console.error(e);
        fail(`${name}: ${(e as Error).message}`);
    }
}

/** How many prototypes a map uses that a build does not have (renamed ones followed, removed ones not counted). */
function missingPrototypes(doc: MapDocument, pack: Pack): number {
    const seen = new Set<string>();
    for (const uid of doc.uids()) {
        const proto = doc.proto(uid);
        if (!proto || seen.has(proto)) continue;
        seen.add(proto);
    }
    let n = 0;
    for (const proto of seen) {
        const now = pack.migrate(proto);
        if (now !== null && !pack.prototypes.entities[now]) n++;
    }
    return n;
}

/** The small index of a build; a pack built without one is loaded in full. */
const buildIndexes = new Map<string, Promise<BuildIndex>>();
function buildIndex(id: string): Promise<BuildIndex> {
    let p = buildIndexes.get(id);
    if (!p) {
        const loaded = packs.get(id);
        p = loaded ? loaded.then(indexOf) : loadBuildIndex(forks.find((f) => f.id === id)?.pack ?? `/packs/${id}/`).then((x) => x ?? loadPack(id).then(indexOf));
        buildIndexes.set(id, p);
        p.catch(() => buildIndexes.delete(id));
    }
    return p;
}

/** The build whose prototypes cover the map best, when it beats the current one; null to keep the current. */
async function betterBuild(doc: MapDocument): Promise<{ id: string; missing: number; was: number } | null> {
    try {
        const used: string[] = [];
        for (const uid of doc.uids()) {
            const proto = doc.proto(uid);
            if (proto) used.push(proto);
        }
        return await pickBuild(used, forks.map((f) => f.id), fork(), buildIndex);
    } catch {
        return null;
    }
}

/** Switches the build of the open map after saying what it costs; the start screen's choice applies at once. */
async function setFork(id: string): Promise<void> {
    if (id === fork()) return;
    if (!shown || !current) return useFork(id);
    let missing = 0;
    try {
        missing = missingPrototypes(current.doc, await loadPack(id));
    } catch (e) {
        return void showToast(translate("Could not load {{1}}: {{2}}", { 1: forkName(id), 2: (e as Error).message }), undefined, 6000);
    }
    const note = missing
        ? translate("{{1}} prototypes are missing in {{2}}.", { 1: missing, 2: forkName(id) })
        : "";
    const choice = await dialog<"switch" | "cancel">(
        translate("Change build?"),
        [note || translate("Switch to {{1}}.", { 1: forkName(id) })],
        [{ label: translate("Cancel"), value: "cancel", spaceAfter: true }, { label: translate("Change build"), value: "switch", kind: "primary" }],
        "cancel",
    );
    if (choice !== "switch") return;
    shell.forkSelect.value = id;
    start.setFork(id);
    // the library remembers the build the map belongs to
    if (current.id) void library.update(current.id, { build: id }).then(refreshLibrary);
    void show();
}

/** Picks a build without drawing (the next load uses it). */
function useFork(id: string | undefined): void {
    if (!id || !forks.some((f) => f.id === id)) return;
    shell.forkSelect.value = id;
    start.setFork(id);
}

// ---- saving

const SAVE_FAILED = translate("Could not save to this browser");

/** Writes the open map into its library record (or a new one) and marks it saved; false when it failed. */
async function save(): Promise<boolean> {
    if (!current) return false;
    const text = controller.text();
    if (text === null) return false;
    const target = current;
    // an edit made while the record is written stays unsaved
    let edited = false;
    const stop = target.doc.onChange(() => (edited = true));
    const entry = target.id ? await library.save({ id: target.id, name: target.name, build: fork() }, text) : await library.create(target.name, fork(), text);
    stop();
    if (!entry) {
        showToast(SAVE_FAILED, { label: translate("Download"), run: () => controller.run("file.download") }, 8000);
        return false;
    }
    target.id = entry.id;
    syncUrl();
    if (!edited) target.doc.markSaved();
    controller.say(translate("Saved {{1}}", { 1: target.name }));
    showToast(translate("Saved"), undefined, 2500);
    void refreshLibrary();
    return true;
}

const taken = (file: string) => entries.some((e) => e.name === file);

/** Save as: a new library record under another name; the open map continues as that one. */
async function saveAs(): Promise<void> {
    if (!current) return;
    await refreshLibrary();
    const base = current.name.replace(/\.ya?ml$/i, "");
    let suggestion = `${base} copy.yml`;
    for (let i = 2; taken(suggestion); i++) suggestion = `${base} copy ${i}.yml`;
    const name = await askMapName(translate("Save as"), suggestion, translate("Save"), taken);
    if (!name || !current) return;
    const text = controller.text();
    if (text === null) return;
    const target = current;
    let edited = false;
    const stop = target.doc.onChange(() => (edited = true));
    const entry = await library.create(name, fork(), text);
    stop();
    if (!entry) return void showToast(SAVE_FAILED, { label: translate("Download"), run: () => controller.run("file.download") }, 8000);
    target.id = entry.id;
    target.name = name;
    syncUrl();
    controller.rename(name);
    if (!edited) target.doc.markSaved();
    controller.say(translate("Saved as {{1}}", { 1: name }));
    showToast(translate("Saved as {{1}}", { 1: name }), undefined, 2500);
    void refreshLibrary();
}

/** Before another map replaces the open one: Save, Discard or Cancel when it has unsaved edits. */
async function leaveCurrent(note?: string): Promise<boolean> {
    if (!current || !controller.modified) return true;
    const choice = await confirmUnsaved(current.name, note);
    if (choice === "cancel") return false;
    if (choice === "save") return (await save()) && !controller.modified;
    return true;
}

let changingLanguage = false;
async function setLanguage(code: string): Promise<void> {
    if (code === language() || changingLanguage) return;
    changingLanguage = true;
    try {
        const target = current;
        const reloadNote = translate("Changing the language reloads the editor and clears undo history.");
        if (target && controller.modified) {
            if (!(await leaveCurrent(reloadNote))) return;
        } else if (target && (target.doc.canUndo || target.doc.canRedo)) {
            const confirmed = await dialog(translate("Change language?"), [reloadNote], [
                { label: translate("Cancel"), value: false }, { label: translate("Reload"), value: true, kind: "primary" },
            ], false);
            if (!confirmed || controller.modified) return;
        }
        if (target !== current) return;
        if (target && !target.id) {
            const confirmed = await dialog(translate("Change language?"), [translate("This map is outside the library. Reloading will close it.")], [
                { label: translate("Cancel"), value: false }, { label: translate("Reload"), value: true, kind: "primary" },
            ], false);
            if (!confirmed || target !== current) return;
        }
        const url = languageUrl(code);
        if (!current && fork()) url.searchParams.set("fork", fork());
        controller.leaving = true;
        location.replace(url);
    } finally {
        changingLanguage = false;
    }
}

// ---- opening

interface Opened {
    name: string;
    text: string;
    /** Its library record, when opened from the library. */
    id?: string;
    /** The build to show it with. */
    build?: string;
    /** A new map: always a record of its own. */
    fresh?: boolean;
}

async function openText(o: Opened): Promise<void> {
    // the question about unsaved edits must not sit under the loading screen
    if (current && controller.modified) loadingScreen.hide();
    if (!(await leaveCurrent())) return loadingScreen.hide();
    await loadingScreen.show(o.name, translate("Reading map"));
    let doc: MapDocument;
    try {
        doc = new MapDocument(o.text);
    } catch (e) {
        return fail(`${o.name}: ${(e as Error).message}`);
    }
    useFork(o.build);
    // a file of no known build is shown with the build that covers its prototypes best
    let suggested: Awaited<ReturnType<typeof betterBuild>> = null;
    if (!o.build && !o.id && !o.fresh && forks.length > 1) {
        await loadingScreen.step(translate("Choosing build"));
        suggested = await betterBuild(doc);
        if (suggested) useFork(suggested.id);
    }
    let id = o.id ?? null;
    if (!id) {
        // kept in the library right away, so it reopens without the file
        const entry = o.fresh ? await library.create(o.name, fork(), o.text) : await library.addOpened(o.name, fork(), o.text);
        id = entry?.id ?? null;
        if (!entry && library.available) showToast(translate("Could not store the map in this browser"), undefined, 8000);
    }
    current = { name: o.name, doc, id };
    void refreshLibrary();
    await show();
    if (suggested) showToast(translate("Opened with {{1}}", { 1: forkName(suggested.id) }), undefined, 8000);
}

async function openFile(f: File | undefined): Promise<void> {
    if (!f) return;
    let text: string;
    try {
        await loadingScreen.show(f.name, translate("Reading file"));
        text = await f.text();
    } catch (e) {
        return fail(`${f.name}: ${(e as Error).message}`);
    }
    await openText({ name: f.name, text });
}

async function openUrl(url: string): Promise<void> {
    const name = url.split("/").pop() ?? url;
    try {
        await loadingScreen.show(name, translate("Downloading"));
        const r = await fetch(url);
        if (!r.ok) return fail(`${name}: ${r.status} ${r.statusText}`);
        await openText({ name, text: await r.text() });
    } catch (e) {
        fail(`${name}: ${(e as Error).message}`);
    }
}

function pickFile(): void {
    fileInput.click();
}

/** Opens a map kept in the library. */
async function reopen(m: LibraryEntry): Promise<void> {
    await loadingScreen.show(m.name, translate("Reading map"));
    const r = await library.open(m.id);
    if (!r) {
        await refreshLibrary();
        return fail(translate("{{1}} no longer exists", { 1: m.name }));
    }
    await openText({ name: r.name, text: r.text, id: r.id, build: r.build });
}

async function newMap(): Promise<void> {
    await refreshLibrary();
    const r = await newMapDialog({ forks, build: fork(), loadPack, taken });
    if (r) await openText({ name: r.file, text: r.text, build: r.build, fresh: true });
}

async function manage(): Promise<void> {
    await refreshLibrary();
    await manageLibrary({
        library,
        openId: current?.id ?? null,
        forkName,
        open: (id) => {
            const m = entries.find((e) => e.id === id);
            if (m) void reopen(m);
        },
        changed: ({ id, name }) => {
            // the open map renamed in the library takes the new name
            if (current && current.id === id && name && name !== current.name) {
                current.name = name;
                controller.rename(name);
            }
            void refreshLibrary();
        },
    });
}

// ---- inputs
fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    // cleared so that choosing the same file again (after an error or a cancel) fires "change" again
    fileInput.value = "";
    void openFile(f);
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
    e.preventDefault();
    void openFile(e.dataTransfer?.files[0]);
});
new ResizeObserver(() => map.paintNow()).observe($("view"));
/**
 * Reads the build list again (builds are added, hidden and rebuilt on the server). The open map's build stays
 * listed even when it is gone from the server; a build whose pack moved to a new version loads it next time.
 */
async function refreshForks(): Promise<void> {
    let fresh: Fork[];
    try {
        fresh = await loadForks();
    } catch {
        return;
    }
    const selected = fork();
    for (const f of fresh) {
        const old = forks.find((o) => o.id === f.id);
        if (old && old.pack !== f.pack) packs.delete(f.id);
    }
    const kept = current && !fresh.some((f) => f.id === selected) ? forks.filter((f) => f.id === selected) : [];
    forks = [...fresh, ...kept];
    const pick = forks.some((f) => f.id === selected) ? selected : forks[0]?.id ?? "";
    shell.setForks(forks, pick);
    start.setForks(forks, pick);
}

// another tab, or the server, may have changed the library and the build list
window.addEventListener("focus", () => {
    void refreshLibrary();
    void refreshForks();
});

// ---- start
try {
    forks = await loadForks();
} catch (e) {
    showToast((e as Error).message);
}
const initial = forks.some((f) => f.id === params.get("fork")) ? params.get("fork")! : forks[0]?.id ?? "";
shell.setForks(forks, initial);
start.setForks(forks, initial);
await refreshLibrary();
/** Opens a library record named by the address (a reload); false when it is gone. */
async function reopenId(id: string): Promise<boolean> {
    const r = await library.open(id);
    if (!r) return false;
    await openText({ name: r.name, text: r.text, id: r.id, build: r.build });
    return true;
}

const openId = params.get("open");
const mapUrl = params.get("map");
if (openId && (await reopenId(openId))) {
    // reopened after a reload
} else if (mapUrl) await openUrl(mapUrl);
else {
    syncUrl();
    showStart();
}
