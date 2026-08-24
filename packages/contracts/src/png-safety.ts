import { Unzlib } from "fflate";

export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_DECODED_BYTES = 64 * 1024 * 1024;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const INFLATE_INPUT_CHUNK_BYTES = 1024;
const MAX_PNG_CHUNKS = 1024;
const MAX_PNG_IDAT_CHUNKS = 256;
const MAX_PNG_PALETTE_BYTES = 256 * 3;
const FORBIDDEN_CHUNKS = new Set(["acTL", "fcTL", "fdAT", "iCCP"]);

export interface PngSafetyInfo {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly channels: number;
  readonly decodedBytes: number;
  readonly expectedInflatedBytes: number;
}

interface ScannedPng extends PngSafetyInfo {
  readonly imageData: readonly Uint8Array[];
}

function pngSafetyInfo(scanned: ScannedPng): PngSafetyInfo {
  return {
    width: scanned.width,
    height: scanned.height,
    pixels: scanned.pixels,
    bitDepth: scanned.bitDepth,
    colorType: scanned.colorType,
    channels: scanned.channels,
    decodedBytes: scanned.decodedBytes,
    expectedInflatedBytes: scanned.expectedInflatedBytes,
  };
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

function channelCount(colorType: number): number {
  switch (colorType) {
    case 0:
    case 3:
      return 1;
    case 4:
      return 2;
    case 2:
      return 3;
    case 6:
      return 4;
    default:
      throw new Error(`The PNG uses unsupported color type ${colorType}.`);
  }
}

function validBitDepth(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return [2, 4, 6].includes(colorType) && [8, 16].includes(bitDepth);
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function scanlineBytes(width: number, channels: number, bitDepth: number): number {
  return Math.ceil((width * channels * bitDepth) / 8);
}

function expectedInflatedBytes(
  width: number,
  height: number,
  channels: number,
  bitDepth: number,
  interlace: number,
): number {
  if (interlace === 0) return height * (1 + scanlineBytes(width, channels, bitDepth));
  if (interlace !== 1) throw new Error(`The PNG uses unsupported interlace method ${interlace}.`);

  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  return passes.reduce((total, [startX, startY, stepX, stepY]) => {
    const passWidth = passSize(width, startX, stepX);
    const passHeight = passSize(height, startY, stepY);
    return passWidth === 0 || passHeight === 0
      ? total
      : total + passHeight * (1 + scanlineBytes(passWidth, channels, bitDepth));
  }, 0);
}

function scanPng(bytes: Uint8Array): ScannedPng {
  if (
    bytes.length < 45 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value) ||
    chunkType(bytes, 12) !== "IHDR"
  ) {
    throw new Error("The file is not a valid PNG.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13) throw new Error("The PNG has an invalid IHDR chunk.");
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? -1;
  const compression = bytes[26] ?? -1;
  const filter = bytes[27] ?? -1;
  const interlace = bytes[28] ?? -1;
  if (!width || !height) throw new Error("The PNG has invalid dimensions.");
  const pixels = width * height;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || pixels > MAX_IMAGE_PIXELS) {
    throw new Error("The PNG decoded dimensions exceed the safety limit.");
  }
  const channels = channelCount(colorType);
  if (!validBitDepth(colorType, bitDepth)) {
    throw new Error(`The PNG uses invalid bit depth ${bitDepth} for color type ${colorType}.`);
  }
  if (bitDepth !== 8) throw new Error("Only 8-bit PNG samples are supported.");
  if (compression !== 0 || filter !== 0) {
    throw new Error("The PNG uses unsupported compression or filtering.");
  }
  const decodedBytes = pixels * channels;
  if (decodedBytes > MAX_IMAGE_DECODED_BYTES) {
    throw new Error("The PNG decoded samples exceed the memory limit.");
  }
  const inflatedBytes = expectedInflatedBytes(width, height, channels, bitDepth, interlace);
  if (inflatedBytes > MAX_IMAGE_DECODED_BYTES + MAX_IMAGE_DIMENSION * 7) {
    throw new Error("The PNG inflated image data exceeds the memory limit.");
  }

  const imageData: Uint8Array[] = [];
  let offset = 8;
  let chunkCount = 0;
  let ihdrCount = 0;
  let paletteCount = 0;
  let paletteEntries = 0;
  let transparencyCount = 0;
  let foundImageData = false;
  let finishedImageData = false;
  let foundEnd = false;
  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) {
      throw new Error(`The PNG contains more than ${MAX_PNG_CHUNKS} chunks.`);
    }
    const length = view.getUint32(offset, false);
    const type = chunkType(bytes, offset + 4);
    const dataStart = offset + 8;
    const nextOffset = dataStart + length + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      throw new Error(`The PNG ${type || "unknown"} chunk is truncated.`);
    }
    if (type === "IHDR") ihdrCount += 1;
    if (FORBIDDEN_CHUNKS.has(type)) {
      throw new Error(
        type === "iCCP"
          ? "Embedded PNG color profiles are not supported."
          : "Animated PNG chunks are not supported.",
      );
    }
    if (foundImageData && type !== "IDAT" && type !== "IEND") finishedImageData = true;
    if (type === "PLTE") {
      paletteCount += 1;
      if (paletteCount > 1) throw new Error("The PNG contains more than one color palette.");
      if (foundImageData) throw new Error("The PNG color palette must precede image data.");
      if (colorType === 0 || colorType === 4) {
        throw new Error("Grayscale PNGs cannot contain a color palette.");
      }
      if (length < 3 || length > MAX_PNG_PALETTE_BYTES || length % 3 !== 0) {
        throw new Error("The PNG color palette must contain 1 to 256 RGB entries.");
      }
      if (colorType === 3 && length / 3 > 2 ** bitDepth) {
        throw new Error("The PNG color palette has more entries than its bit depth permits.");
      }
      paletteEntries = length / 3;
    }
    if (type === "tRNS") {
      transparencyCount += 1;
      if (transparencyCount > 1) {
        throw new Error("The PNG contains more than one transparency chunk.");
      }
      if (foundImageData) throw new Error("PNG transparency metadata must precede image data.");
      if (colorType !== 3) {
        throw new Error(
          "PNG color-key transparency is not supported; use an explicit alpha channel.",
        );
      }
      if (paletteCount !== 1 || length < 1 || length > paletteEntries) {
        throw new Error("Indexed PNG transparency must match its preceding color palette.");
      }
    }
    if (type === "IDAT") {
      if (finishedImageData) throw new Error("The PNG image-data chunks must be consecutive.");
      foundImageData = true;
      if (imageData.length >= MAX_PNG_IDAT_CHUNKS) {
        throw new Error(`The PNG contains more than ${MAX_PNG_IDAT_CHUNKS} image-data chunks.`);
      }
      imageData.push(bytes.subarray(dataStart, dataStart + length));
    }
    if (type === "IEND") {
      if (length !== 0) throw new Error("The PNG has an invalid IEND chunk.");
      foundEnd = true;
      offset = nextOffset;
      break;
    }
    offset = nextOffset;
  }
  if (ihdrCount !== 1 || imageData.length === 0 || !foundEnd || offset !== bytes.length) {
    throw new Error("The PNG chunk structure is incomplete or invalid.");
  }
  if (colorType === 3 && paletteCount !== 1) {
    throw new Error("Indexed-color PNGs require one color palette.");
  }

  return {
    width,
    height,
    pixels,
    bitDepth,
    colorType,
    channels,
    decodedBytes,
    expectedInflatedBytes: inflatedBytes,
    imageData,
  };
}

export function inspectPngSafety(bytes: Uint8Array): PngSafetyInfo {
  return pngSafetyInfo(scanPng(bytes));
}

export function validatePngSafety(bytes: Uint8Array): PngSafetyInfo {
  const scanned = scanPng(bytes);
  let inflatedBytes = 0;
  const inflator = new Unzlib((chunk) => {
    inflatedBytes += chunk.length;
    if (inflatedBytes > scanned.expectedInflatedBytes) {
      throw new Error("The PNG image data expands beyond its decoded-size limit.");
    }
  });
  try {
    for (const data of scanned.imageData) {
      for (let offset = 0; offset < data.length; offset += INFLATE_INPUT_CHUNK_BYTES) {
        inflator.push(data.subarray(offset, offset + INFLATE_INPUT_CHUNK_BYTES), false);
      }
    }
    inflator.push(new Uint8Array(0), true);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "image data decompression failed";
    throw new Error(`The PNG image data could not be decompressed safely: ${reason}.`);
  }
  if (inflatedBytes !== scanned.expectedInflatedBytes) {
    throw new Error("The PNG image data length does not match its dimensions.");
  }
  return pngSafetyInfo(scanned);
}
