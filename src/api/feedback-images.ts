// Image attachments of a feedback report: the limits (the API's) and the checks made before sending.
import type { BugReportInput } from "./client";

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_TOTAL = 30 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export const MSG_TYPE = "Images must be PNG, JPEG, WebP or GIF files.";
export const MSG_SIZE = "Each image must not be larger than 5 MB.";
export const MSG_COUNT = `You can attach up to ${MAX_IMAGES} images.`;
export const MSG_TOTAL = "The images must not be larger than 30 MB in total.";

interface Sized {
    type: string;
    size: number;
}

/** Why `file` cannot be added to `current`, or null when it can. */
export function imageProblem(file: Sized, current: readonly Sized[]): string | null {
    if (!IMAGE_TYPES.includes(file.type)) return MSG_TYPE;
    if (file.size > MAX_IMAGE_BYTES) return MSG_SIZE;
    if (current.length >= MAX_IMAGES) return MSG_COUNT;
    if (current.reduce((n, f) => n + f.size, file.size) > MAX_IMAGES_TOTAL) return MSG_TOTAL;
    return null;
}

/** Adds the acceptable files to `current` in order; the first problem found is returned with the new list. */
export function addImages<T extends Sized>(current: readonly T[], files: readonly T[]): { images: T[]; error: string | null } {
    const images = [...current];
    let error: string | null = null;
    for (const f of files) {
        const problem = imageProblem(f, images);
        if (problem) error ??= problem;
        else images.push(f);
    }
    return { images, error };
}

/** The multipart body of a report: its fields, the map as a text field and the images as `images[]`. */
export function reportForm(report: BugReportInput, images: readonly Blob[] = []): FormData {
    const form = new FormData();
    for (const [k, v] of Object.entries(report)) if (v !== undefined && v !== null) form.append(k, String(v));
    for (const f of images) form.append("images[]", f, (f as File).name);
    return form;
}
