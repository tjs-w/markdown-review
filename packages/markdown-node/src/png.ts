import { inspectPngSafety, validatePngSafety } from "@markdown-review/contracts/png-safety";
import { decode } from "fast-png";

export interface PngDimensions {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
}

export function readPngDimensions(bytes: Buffer): PngDimensions {
  const { width, height, pixels } = inspectPngSafety(bytes);
  return { width, height, pixels };
}

export function validatePng(bytes: Buffer, expected: PngDimensions): void {
  try {
    validatePngSafety(bytes);
    const decoded = decode(bytes, { checkCrc: true });
    if (decoded.width !== expected.width || decoded.height !== expected.height) {
      throw new Error("the decoded dimensions do not match the PNG header");
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "PNG decoding failed";
    throw new Error(`The file is not a complete valid PNG: ${reason}.`);
  }
}
