import type { MapDocument } from "../map/document";
import { entryText, parseDocument, scalar } from "../map/yaml";

/** Stores the chosen color on each pipe, keeping any unrelated fields in its existing override. */
export function colorPipeNetwork(doc: MapDocument, members: readonly number[], rgb: string): number {
    if (!/^#[0-9a-f]{6}$/i.test(rgb)) throw new Error("Enter a valid RGB color");
    const color = rgb.toUpperCase() + "FF";
    return doc.batch("Color pipe network", () => {
        let changed = 0;
        for (const uid of members) {
            const previous = doc.componentOverride(uid, "AtmosPipeColor");
            if (String(previous?.data.color).toUpperCase() === color) continue;
            const entries = previous?.text ? parseDocument(previous.text + "\n").root.entries : [];
            const at = entries.findIndex((e) => e.key.value === "color");
            const field = { key: scalar("color"), value: scalar(color) };
            if (at === -1) entries.push(field);
            else entries[at] = { ...field, lead: entries[at]!.lead };
            doc.setComponent(uid, "AtmosPipeColor", entries.map((e) => entryText(e, 0)).join("\n"));
            changed++;
        }
        return changed;
    });
}
