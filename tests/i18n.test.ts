import { afterEach, describe, expect, it } from "vitest";
import { i18n, language, languageReady, languages, t } from "../src/i18n";
import english from "../src/locales/en.json";
import russian from "../src/locales/ru.json";

afterEach(async () => {
    await i18n.changeLanguage("en");
});

describe("interface localization", () => {
    it("loads Russian for a regional locale and falls back to English for an unsupported language", async () => {
        await languageReady;
        expect(languages.map(({ code }) => code)).toEqual(expect.arrayContaining(["en", "ru"]));
        await i18n.changeLanguage("ru-RU");
        expect(language()).toBe("ru");
        expect(t("Open file…")).toBe("Открыть файл…");
        expect(t("default")).toBe("по умолчанию");
        expect(t("Open {{1}}", { 1: "A&B <map>.yml" })).toBe("Открыть «A&B <map>.yml»");
        await i18n.changeLanguage("zz");
        expect(language()).toBe("en");
        expect(t("Open file…")).toBe("Open file…");
    });

    it("uses Russian plural forms for selection counts", async () => {
        await i18n.changeLanguage("ru");
        expect([1, 2, 5, 21, 1.5].map((count) => t("count.tiles", { count }))).toEqual([
            "1 тайл", "2 тайла", "5 тайлов", "21 тайл", "1.5 тайла",
        ]);
    });

    it("retains English keys and their interpolation tokens in the Russian catalog", () => {
        const tokens = (value: string) => [...value.matchAll(/{{(.*?)}}/g)].map((match) => match[1]).sort();
        const catalog: Record<string, string> = russian;
        for (const [key, value] of Object.entries(english)) {
            expect(catalog[key], key).toBeDefined();
            expect(tokens(catalog[key]!), key).toEqual(tokens(value));
        }
    });
});
