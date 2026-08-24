import { decode } from "fast-png";

function sampleAt(data, index, depth) {
  const value = data[index];
  return depth === 16 ? value >>> 8 : value;
}

export function decodePng(bytes) {
  const decoded = decode(bytes);
  const { width, height, channels, depth, data } = decoded;
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    if (channels === 1) {
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
      throw new Error(`Unsupported PNG channel count: ${channels}`);
    }
  }

  return { width, height, data: rgba };
}
