import { validatePngSafety } from "@markdown-review/contracts/png-safety";
import { decode } from "fast-png";

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

function sampleAt(
  data: Uint8Array | Uint8ClampedArray | Uint16Array,
  index: number,
  depth: number,
): number {
  const value = data[index];
  if (value === undefined) {
    throw new Error("PNG pixel data ended unexpectedly");
  }
  return depth === 16 ? value >>> 8 : value;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const safety = validatePngSafety(bytes);
  const decoded = decode(bytes, { checkCrc: true });
  const { width, height, channels, depth, data } = decoded;
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (safety.colorType === 3) {
      const paletteIndex = data[pixel];
      const color = paletteIndex === undefined ? undefined : decoded.palette?.[paletteIndex];
      if (!color) throw new Error("PNG palette data is incomplete");
      rgba[target] = color[0] ?? 0;
      rgba[target + 1] = color[1] ?? 0;
      rgba[target + 2] = color[2] ?? 0;
      rgba[target + 3] = color[3] ?? 255;
    } else if (channels === 1) {
      const gray = sampleAt(data, source, depth);
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = 255;
    } else if (channels === 2) {
      const gray = sampleAt(data, source, depth);
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] = sampleAt(data, source + 1, depth);
    } else if (channels === 3) {
      rgba[target] = sampleAt(data, source, depth);
      rgba[target + 1] = sampleAt(data, source + 1, depth);
      rgba[target + 2] = sampleAt(data, source + 2, depth);
      rgba[target + 3] = 255;
    } else if (channels === 4) {
      rgba[target] = sampleAt(data, source, depth);
      rgba[target + 1] = sampleAt(data, source + 1, depth);
      rgba[target + 2] = sampleAt(data, source + 2, depth);
      rgba[target + 3] = sampleAt(data, source + 3, depth);
    } else {
      throw new Error(`Unsupported PNG channel count: ${String(channels)}`);
    }
  }

  return { width, height, data: rgba };
}
