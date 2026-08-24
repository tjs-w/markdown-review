import { inspectLocalImage, type ImageDimensions } from "./image.js";

export type PngDimensions = ImageDimensions;

export function readPngDimensions(bytes: Buffer): PngDimensions {
  const { width, height, pixels } = inspectLocalImage(bytes, "image.png");
  return { width, height, pixels };
}

export function validatePng(bytes: Buffer, expected: PngDimensions): void {
  try {
    const inspected = inspectLocalImage(bytes, "image.png");
    if (inspected.width !== expected.width || inspected.height !== expected.height) {
      throw new Error("the dimensions do not match the PNG header");
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "PNG validation failed";
    throw new Error(`The file is not a complete valid PNG: ${reason}.`);
  }
}
