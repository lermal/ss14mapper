// The author's credit: a link to the project page, shown on the start screen and in the editor's status bar.
import { h } from "./icons";

export const CREDIT_URL = "https://forged.by/projects/ss14mapper";

export function creditLink(cls: string): HTMLAnchorElement {
    const a = h("a", cls, "Developed by Forged");
    a.href = CREDIT_URL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
}
