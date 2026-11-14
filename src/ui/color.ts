// Decal colours: "#RRGGBBAA" as the map has it, split into the colour picker's "#rrggbb" and an alpha field.

/** "#RRGGBBAA" → ["#rrggbb", alpha 0..255]; no color is opaque white. */
export function splitColor(color: string | null): [string, number] {
    if (!color || !/^#[0-9A-Fa-f]{8}$/.test(color)) return ["#ffffff", 255];
    return [color.slice(0, 7).toLowerCase(), parseInt(color.slice(7, 9), 16)];
}

/** "#rrggbb" and alpha 0..255 → "#RRGGBBAA". */
export function joinColor(rgb: string, alpha: number): string {
    const a = Math.max(0, Math.min(255, Math.round(alpha) || 0));
    return (rgb + a.toString(16).padStart(2, "0")).toUpperCase();
}
