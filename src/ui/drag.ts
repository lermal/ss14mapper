// What is being dragged between the palette, the Properties column and the map (HTML5 drag and drop). The
// browser hides drag data until the drop, so the drop targets read what is dragged from here while hovering.

/** Data type of a palette entry being dragged (`{kind, id}` as JSON). */
export const ENTRY_TYPE = "application/x-ss14-entry";
/** Data type of a stored entity being dragged out of the Contents section (its uid). */
export const UID_TYPE = "application/x-ss14-uid";

export type Dragged = { kind: "entry"; entry: { kind: "entity" | "tile" | "decal"; id: string } } | { kind: "uid"; uid: number };

let current: Dragged | null = null;

export function setDragged(d: Dragged | null): void {
    current = d;
}

/** What is being dragged, or null (nothing, or a drag from elsewhere such as a file). */
export function dragged(): Dragged | null {
    return current;
}

/** Whether a drag event carries something of ours. */
export function isOurs(e: DragEvent): boolean {
    const types = e.dataTransfer?.types ?? [];
    return !!current && (types.includes(ENTRY_TYPE) || types.includes(UID_TYPE));
}
