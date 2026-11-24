import { languageReady } from "./i18n";

try {
    await languageReady;
    await import("./main");
} catch (error) {
    const status = document.getElementById("start-status");
    if (status) {
        status.hidden = false;
        status.textContent = "The editor could not start. Try reloading the page. The mapping guide is still available.";
    }
    console.error(error);
}
