export interface PngDimensions {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readPngDimensions(bytes: Buffer): PngDimensions {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("The file is not a valid PNG.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error("The PNG has invalid dimensions.");
  return { width, height, pixels: width * height };
}

export function validatePng(bytes: Buffer, expected: PngDimensions): void {
  try {
    const decoded = decode(bytes, { checkCrc: true });
    if (decoded.width !== expected.width || decoded.height !== expected.height) {
      throw new Error("the decoded dimensions do not match the PNG header");
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "PNG decoding failed";
    throw new Error(`The file is not a complete valid PNG: ${reason}.`);
  }
}
import { decode } from "fast-png";
