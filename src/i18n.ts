import i18next, { type TOptions } from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import resourcesToBackend from "i18next-resources-to-backend";
import english from "./locales/en.json";

const preference = "ss14mapper.language";
const catalogs = import.meta.glob<{ default: Record<string, string> }>(["./locales/*.json", "!./locales/en.json"]);
const codes = ["en", ...Object.keys(catalogs).map((file) => file.slice("./locales/".length, -".json".length))];

export const languages = codes.map((code) => {
    const native = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return { code, name: native.charAt(0).toLocaleUpperCase(code) + native.slice(1) };
});
export const i18n = i18next.createInstance().use(resourcesToBackend((code: string) => catalogs[`./locales/${code}.json`]?.() ?? Promise.resolve({})));
if (typeof window !== "undefined") i18n.use(LanguageDetector);

// English is bundled as a fallback. The browser loads the selected translation before mounting the editor.
export const languageReady = i18n.init({
    initAsync: false,
    fallbackLng: "en",
    supportedLngs: codes,
    keySeparator: false,
    nsSeparator: false,
    resources: { en: { translation: english } },
    partialBundledLanguages: true,
    detection: { order: ["querystring", "htmlTag", "localStorage", "navigator"], lookupQuerystring: "lang", lookupLocalStorage: preference, caches: [] },
    // Text is passed to DOM text/attributes or the canvas rather than HTML.
    interpolation: { escapeValue: false },
});

export const language = (): string => i18n.resolvedLanguage ?? "en";
export const t = (key: string, values: TOptions = {}): string => i18n.t(key, values);

export function shortDate(date: Date, withYear: boolean): string {
    const code = language();
    return new Intl.DateTimeFormat(code === "en" ? "en-GB" : code, {
        day: "numeric",
        month: "short",
        ...(withYear ? { year: "numeric" } : {}),
    }).format(date);
}

/** Keep shareable URLs and the browser preference in sync, including when storage is blocked. */
export function languageUrl(code: string): URL {
    const url = new URL(location.href);
    if (code === "en" || code === "ru") {
        url.pathname = code === "ru" ? "/ru/" : "/";
        url.searchParams.delete("lang");
    } else {
        url.searchParams.set("lang", code);
    }
    try {
        localStorage.setItem(preference, code);
    } catch {
        // The URL still carries the chosen locale.
    }
    return url;
}
