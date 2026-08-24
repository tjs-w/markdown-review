import { extname } from "node:path";

import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  type ReviewImageMimeType,
} from "@markdown-review/contracts";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
const MAX_CONTAINER_CHUNKS = 1024;
const MAX_JPEG_MARKERS = 4096;
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const IMAGE_MIME_BY_EXTENSION = new Map<string, ReviewImageMimeType>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
}

export interface LocalImageInfo extends ImageDimensions {
  readonly mimeType: ReviewImageMimeType;
}

function boundedDimensions(format: string, width: number, height: number): ImageDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`the ${format} has invalid dimensions`);
  }
  const pixels = width * height;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`the ${format} decoded dimensions exceed the safety limit`);
  }
  return { width, height, pixels };
}

function chunkType(bytes: Buffer, offset: number): string {
  return bytes.toString("ascii", offset, offset + 4);
}

// PNG uses CRC-32 for accidental-corruption detection; SHA-256 separately binds snapshots.
function pngCrc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (PNG_CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes: Buffer): ImageDimensions {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("the file is not a valid PNG");
  }
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let imageDataChunks = 0;
  let imageDataFinished = false;
  let foundEnd = false;
  let dimensions: ImageDimensions | undefined;
  while (offset + 12 <= bytes.length) {
    chunks += 1;
    if (chunks > MAX_CONTAINER_CHUNKS) {
      throw new Error(`the PNG contains more than ${MAX_CONTAINER_CHUNKS} chunks`);
    }
    const dataLength = bytes.readUInt32BE(offset);
    const type = chunkType(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = offset + 8 + dataLength;
    const nextOffset = dataEnd + 4;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      throw new Error(`the PNG ${type || "unknown"} chunk is truncated`);
    }
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = pngCrc32(bytes.subarray(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) {
      throw new Error(`the PNG ${type} chunk has an invalid checksum`);
    }

    if (chunks === 1) {
      if (type !== "IHDR" || dataLength !== 13) throw new Error("the PNG has an invalid header");
      const bitDepth = bytes[dataStart + 8] ?? 0;
      const colorType = bytes[dataStart + 9] ?? -1;
      const allowedDepths =
        colorType === 0
          ? [1, 2, 4, 8, 16]
          : colorType === 3
            ? [1, 2, 4, 8]
            : [2, 4, 6].includes(colorType)
              ? [8, 16]
              : [];
      if (!allowedDepths.includes(bitDepth)) {
        throw new Error("the PNG header has an invalid color type or bit depth");
      }
      if (
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        ![0, 1].includes(bytes[dataStart + 12] ?? -1)
      ) {
        throw new Error("the PNG header uses unsupported encoding methods");
      }
      dimensions = boundedDimensions(
        "PNG",
        bytes.readUInt32BE(dataStart),
        bytes.readUInt32BE(dataStart + 4),
      );
    } else if (type === "IHDR") {
      throw new Error("the PNG contains more than one header");
    }

    if (type === "acTL" || type === "fcTL" || type === "fdAT") {
      throw new Error("animated PNG images are not supported");
    }
    if (imageDataChunks > 0 && type !== "IDAT" && type !== "IEND") imageDataFinished = true;
    if (type === "IDAT") {
      if (imageDataFinished) throw new Error("the PNG image-data chunks must be consecutive");
      imageDataChunks += 1;
      if (imageDataChunks > 256) {
        throw new Error("the PNG contains more than 256 image-data chunks");
      }
    }
    if (type === "IEND") {
      if (dataLength !== 0 || imageDataChunks === 0) {
        throw new Error("the PNG has an invalid end chunk");
      }
      foundEnd = true;
    }
    offset = nextOffset;
    if (type === "IEND") break;
  }
  if (!dimensions || !foundEnd || offset !== bytes.length) {
    throw new Error("the PNG contains trailing or incomplete data");
  }
  return dimensions;
}

function inspectJpeg(bytes: Buffer): ImageDimensions {
  if (bytes.length < 6 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("the file is not a valid JPEG");
  }

  let offset = 2;
  let markers = 0;
  let frame: ImageDimensions | undefined;
  let foundScan = false;
  let inEntropyData = false;

  while (offset < bytes.length) {
    if (inEntropyData) {
      let foundMarker = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const markerOffset = offset;
        while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
        const marker = bytes[offset];
        if (marker === undefined) throw new Error("the JPEG entropy data is truncated");
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 1;
          continue;
        }
        offset = markerOffset;
        inEntropyData = false;
        foundMarker = true;
        break;
      }
      if (!foundMarker) throw new Error("the JPEG is missing its end marker");
    }

    if (bytes[offset] !== 0xff) throw new Error("the JPEG marker structure is invalid");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined || marker === 0x00 || marker === 0xff) {
      throw new Error("the JPEG marker structure is invalid");
    }
    offset += 1;
    markers += 1;
    if (markers > MAX_JPEG_MARKERS) {
      throw new Error(`the JPEG contains more than ${MAX_JPEG_MARKERS} markers`);
    }

    if (marker === 0xd9) {
      if (!frame || !foundScan) throw new Error("the JPEG frame structure is incomplete");
      if (offset !== bytes.length) throw new Error("the JPEG contains trailing data");
      return frame;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error("the JPEG contains a misplaced standalone marker");
    }
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) throw new Error("the JPEG segment length is truncated");

    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2) throw new Error("the JPEG contains an invalid segment length");
    const dataStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (segmentEnd > bytes.length) throw new Error("the JPEG contains a truncated segment");

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (frame) throw new Error("the JPEG contains more than one frame header");
      if (segmentLength < 11) throw new Error("the JPEG frame header is truncated");
      const componentCount = bytes[dataStart + 5] ?? 0;
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 8 + componentCount * 3) {
        throw new Error("the JPEG frame header has an invalid component layout");
      }
      const height = bytes.readUInt16BE(dataStart + 1);
      const width = bytes.readUInt16BE(dataStart + 3);
      frame = boundedDimensions("JPEG", width, height);
    }

    if (marker === 0xda) {
      if (!frame) throw new Error("the JPEG scan precedes its frame header");
      const componentCount = bytes[dataStart] ?? 0;
      if (componentCount < 1 || componentCount > 4 || segmentLength !== 6 + componentCount * 2) {
        throw new Error("the JPEG scan header has an invalid component layout");
      }
      foundScan = true;
      inEntropyData = true;
    }
    offset = segmentEnd;
  }

  throw new Error("the JPEG is missing its end marker");
}

function inspectSimpleWebpChunk(bytes: Buffer, type: "VP8 " | "VP8L", start: number, size: number) {
  if (type === "VP8 ") {
    if (
      size < 10 ||
      ((bytes[start] ?? 1) & 1) !== 0 ||
      bytes[start + 3] !== 0x9d ||
      bytes[start + 4] !== 0x01 ||
      bytes[start + 5] !== 0x2a
    ) {
      throw new Error("the WebP VP8 frame header is invalid");
    }
    return boundedDimensions(
      "WebP",
      bytes.readUInt16LE(start + 6) & 0x3fff,
      bytes.readUInt16LE(start + 8) & 0x3fff,
    );
  }

  if (size < 5 || bytes[start] !== 0x2f) {
    throw new Error("the WebP lossless frame header is invalid");
  }
  const bits = bytes.readUInt32LE(start + 1);
  if (bits >>> 29 !== 0) throw new Error("the WebP lossless frame version is unsupported");
  return boundedDimensions("WebP", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}

function inspectWebp(bytes: Buffer): ImageDimensions {
  if (bytes.length < 20 || chunkType(bytes, 0) !== "RIFF" || chunkType(bytes, 8) !== "WEBP") {
    throw new Error("the file is not a valid WebP image");
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error("the WebP RIFF size does not match the file length");
  }

  let offset = 12;
  let chunks = 0;
  let canvas: ImageDimensions | undefined;
  let primary: ImageDimensions | undefined;
  while (offset < bytes.length) {
    chunks += 1;
    if (chunks > MAX_CONTAINER_CHUNKS) {
      throw new Error(`the WebP contains more than ${MAX_CONTAINER_CHUNKS} chunks`);
    }
    if (offset + 8 > bytes.length) throw new Error("the WebP chunk header is truncated");
    const type = chunkType(bytes, offset);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const nextOffset = dataEnd + (size & 1);
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      throw new Error(`the WebP ${type || "unknown"} chunk is truncated`);
    }

    if (type === "ANIM" || type === "ANMF") {
      throw new Error("animated WebP images are not supported");
    }
    if (type === "VP8X") {
      if (canvas || size !== 10) throw new Error("the WebP extended header is invalid");
      const flags = bytes[dataStart] ?? 0;
      if ((flags & 0x02) !== 0) throw new Error("animated WebP images are not supported");
      if (
        (flags & 0xc1) !== 0 ||
        bytes[dataStart + 1] ||
        bytes[dataStart + 2] ||
        bytes[dataStart + 3]
      ) {
        throw new Error("the WebP extended header uses reserved fields");
      }
      const width = 1 + bytes.readUIntLE(dataStart + 4, 3);
      const height = 1 + bytes.readUIntLE(dataStart + 7, 3);
      canvas = boundedDimensions("WebP", width, height);
    }
    if (type === "VP8 " || type === "VP8L") {
      if (primary) throw new Error("the WebP contains more than one primary image chunk");
      primary = inspectSimpleWebpChunk(bytes, type, dataStart, size);
    }
    offset = nextOffset;
  }

  if (!primary) throw new Error("the WebP is missing its primary image chunk");
  if (canvas && (canvas.width !== primary.width || canvas.height !== primary.height)) {
    throw new Error("the WebP canvas dimensions do not match its primary image");
  }
  return canvas ?? primary;
}

function detectImageMimeType(bytes: Buffer): ReviewImageMimeType | null {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 12 && chunkType(bytes, 0) === "RIFF" && chunkType(bytes, 8) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export function imageMimeTypeForPath(imagePath: string): ReviewImageMimeType | null {
  return IMAGE_MIME_BY_EXTENSION.get(extname(imagePath).toLowerCase()) ?? null;
}

export function inspectLocalImage(bytes: Buffer, imagePath: string): LocalImageInfo {
  const expectedMimeType = imageMimeTypeForPath(imagePath);
  if (!expectedMimeType) {
    throw new Error("use a PNG, JPEG, or WebP file for local review images");
  }
  const detectedMimeType = detectImageMimeType(bytes);
  if (!detectedMimeType || detectedMimeType !== expectedMimeType) {
    throw new Error("the image extension does not match its supported file signature");
  }

  const dimensions =
    detectedMimeType === "image/png"
      ? inspectPng(bytes)
      : detectedMimeType === "image/jpeg"
        ? inspectJpeg(bytes)
        : inspectWebp(bytes);
  return { ...dimensions, mimeType: detectedMimeType };
}
