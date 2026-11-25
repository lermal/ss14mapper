import { language, languageReady, t } from "./i18n";

try {
    await languageReady;
    await import("./main");
} catch (error) {
    const status = document.getElementById("start-status");
    if (status) {
        status.hidden = false;
        status.lang = language();
        status.textContent = t("Could not start the editor. Reload the page or open the mapping guide.");
    }
    console.error(error);
}
