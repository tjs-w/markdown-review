import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";

import {
  DefaultMarkdownPathPolicy,
  MAX_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_REFERENCES,
  MAX_MARKDOWN_BYTES,
  MarkdownReviewService,
  inspectLocalImage,
  readFileHandleBounded,
  readPngDimensions,
} from "../src/index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function jpegSegment(marker: number, data: Buffer): Buffer {
  const segment = Buffer.allocUnsafe(data.length + 4);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(data.length + 2, 2);
  data.copy(segment, 4);
  return segment;
}

function jpegFixture(width = 1, height = 1, frameMarker = 0xc0): Buffer {
  const frame = Buffer.from([
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    1,
    1,
    0x11,
    0,
  ]);
  const scan = Buffer.from([1, 1, 0, 0, 63, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(frameMarker, frame),
    jpegSegment(0xda, scan),
    Buffer.from([0, 0xff, 0xd9]),
  ]);
}

function webpChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1)]);
}

function webpFixture(width = 1, height = 1): Buffer {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  const frame = Buffer.alloc(5);
  frame[0] = 0x2f;
  frame.writeUInt32LE(bits, 1);
  const chunks = webpChunk("VP8L", frame);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(chunks.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, chunks]);
}

function extendedWebpFixture(width = 1, height = 1): Buffer {
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(width - 1, 4, 3);
  extended.writeUIntLE(height - 1, 7, 3);
  const primary = webpFixture(width, height).subarray(12);
  const chunks = Buffer.concat([webpChunk("VP8X", extended), primary]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(chunks.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, chunks]);
}

function animatedWebpFixture(): Buffer {
  const extended = Buffer.alloc(10);
  extended[0] = 0x02;
  const chunks = Buffer.concat([webpChunk("VP8X", extended), webpChunk("ANIM", Buffer.alloc(6))]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(chunks.length + 4, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, chunks]);
}
const temporaryDirectories: string[] = [];

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function insertAfterIhdr(png: Buffer, type: string, data: Buffer): Buffer {
  return Buffer.concat([png.subarray(0, 33), pngChunk(type, data), png.subarray(33)]);
}

function insertChunksAfterIhdr(png: Buffer, chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "markdown-review-security-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function rejectionMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to reject");
}

describe("filesystem and image trust boundaries", () => {
  test("accepts only absolute Markdown paths with supported extensions", async () => {
    const directory = await temporaryDirectory();
    const markdown = join(directory, "review.md");
    const text = join(directory, "review.txt");
    await writeFile(markdown, "# Review\n");
    await writeFile(text, "not markdown\n");
    const disguisedMarkdown = join(directory, "disguised.md");
    await symlink(text, disguisedMarkdown);
    const policy = new DefaultMarkdownPathPolicy();

    expect(await policy.resolveMarkdownPath(markdown)).toBe(await realpath(markdown));
    expect(await rejectionMessage(() => policy.resolveMarkdownPath("review.md"))).toMatch(
      /absolute/,
    );
    expect(await rejectionMessage(() => policy.resolveMarkdownPath(text))).toMatch(
      /\.md and \.markdown/,
    );
    expect(await rejectionMessage(() => policy.resolveMarkdownPath(disguisedMarkdown))).toMatch(
      /resolved file/,
    );
  });

  test("allows supported extensions and denies traversal, remote, executable, and symlink escapes", async () => {
    const root = await temporaryDirectory();
    const documentDirectory = join(root, "document");
    await mkdir(documentDirectory);
    const markdown = join(documentDirectory, "review.md");
    const outsidePng = join(root, "outside.png");
    const text = join(documentDirectory, "image.txt");
    const localPng = join(documentDirectory, "local.png");
    const localJpeg = join(documentDirectory, "local.JPEG");
    const localWebp = join(documentDirectory, "local.webp");
    const escape = join(documentDirectory, "escape.png");
    await writeFile(markdown, "# Review\n");
    await writeFile(outsidePng, ONE_PIXEL_PNG);
    await writeFile(localPng, ONE_PIXEL_PNG);
    await writeFile(localJpeg, jpegFixture());
    await writeFile(localWebp, webpFixture());
    await writeFile(text, "not png");
    await Promise.all(
      ["image.gif", "image.svg", "image.avif"].map((name) =>
        writeFile(join(documentDirectory, name), "unsupported image"),
      ),
    );
    await symlink(outsidePng, escape);
    const policy = new DefaultMarkdownPathPolicy();

    expect(await policy.resolveLocalImagePath(markdown, "local.png")).toBe(
      await realpath(localPng),
    );
    expect(await policy.resolveLocalImagePath(markdown, "local.JPEG")).toBe(
      await realpath(localJpeg),
    );
    expect(await policy.resolveLocalImagePath(markdown, "local.webp")).toBe(
      await realpath(localWebp),
    );
    for (const source of [
      "../outside.png",
      "..%2Foutside.png",
      "https://example.com/image.png",
      "//example.com/image.png",
      outsidePng,
      "image.txt",
      "image.gif",
      "image.svg",
      "image.avif",
      "escape.png",
    ]) {
      expect(await rejectionMessage(() => policy.resolveLocalImagePath(markdown, source))).not.toBe(
        "",
      );
    }
    expect(
      await rejectionMessage(() => policy.resolveLocalImagePath(markdown, "image.svg")),
    ).toMatch(/PNG, JPEG, or WebP/);
  });

  test("bounds reads and rejects nonregular files", async () => {
    const directory = await temporaryDirectory();
    const oversized = join(directory, "oversized.md");
    await writeFile(oversized, Buffer.alloc(MAX_MARKDOWN_BYTES + 1));

    expect(
      await rejectionMessage(() =>
        readFileHandleBounded(oversized, MAX_MARKDOWN_BYTES, "Document"),
      ),
    ).toMatch(/exceeds/);
    expect(await rejectionMessage(() => readFileHandleBounded(directory, 100, "Document"))).toMatch(
      /regular file/,
    );
  });

  test("rejects a truncated or CRC-corrupted PNG before session creation", () => {
    const header = ONE_PIXEL_PNG.subarray(0, 24);
    expect(() => readPngDimensions(header)).toThrow(/valid PNG/);

    const corrupted = Buffer.from(ONE_PIXEL_PNG);
    const lastByte = corrupted[corrupted.length - 1];
    if (lastByte === undefined) throw new Error("Expected a non-empty PNG fixture");
    corrupted[corrupted.length - 1] = lastByte ^ 1;
    expect(() => readPngDimensions(corrupted)).toThrow(/invalid checksum/);
  });

  test("rejects animated PNG without raster-decoding static image data in Node", () => {
    const animated = insertAfterIhdr(ONE_PIXEL_PNG, "acTL", Buffer.alloc(8));
    expect(() => readPngDimensions(animated)).toThrow(/animated PNG/);
  });

  test("identifies bounded JPEG and static WebP containers with extension agreement", () => {
    expect(inspectLocalImage(jpegFixture(2, 3), "fixture.jpg")).toEqual({
      mimeType: "image/jpeg",
      width: 2,
      height: 3,
      pixels: 6,
    });
    expect(inspectLocalImage(jpegFixture(), "fixture.JPEG").mimeType).toBe("image/jpeg");
    expect(inspectLocalImage(jpegFixture(3, 2, 0xc2), "progressive.jpeg")).toMatchObject({
      mimeType: "image/jpeg",
      width: 3,
      height: 2,
    });
    expect(inspectLocalImage(webpFixture(4, 5), "fixture.webp")).toEqual({
      mimeType: "image/webp",
      width: 4,
      height: 5,
      pixels: 20,
    });
    expect(inspectLocalImage(extendedWebpFixture(5, 4), "extended.webp")).toEqual({
      mimeType: "image/webp",
      width: 5,
      height: 4,
      pixels: 20,
    });

    expect(() => inspectLocalImage(ONE_PIXEL_PNG, "fixture.jpg")).toThrow(/does not match/);
    expect(() => inspectLocalImage(jpegFixture(), "fixture.webp")).toThrow(/does not match/);
    expect(() => inspectLocalImage(Buffer.from("GIF89a"), "fixture.png")).toThrow(/does not match/);
  });

  test("rejects animated, malformed, oversized, and pathologically segmented containers", () => {
    expect(() => inspectLocalImage(animatedWebpFixture(), "animated.webp")).toThrow(
      /animated WebP/,
    );
    expect(() => inspectLocalImage(jpegFixture().subarray(0, -2), "truncated.jpg")).toThrow(
      /end marker/,
    );
    expect(() => inspectLocalImage(webpFixture(MAX_IMAGE_DIMENSION + 1, 1), "huge.webp")).toThrow(
      /dimensions exceed/,
    );

    const jpegMarkerStorm = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      ...Array.from({ length: 4097 }, () => Buffer.from([0xff, 0x01])),
      jpegFixture().subarray(2),
    ]);
    expect(() => inspectLocalImage(jpegMarkerStorm, "storm.jpg")).toThrow(/more than 4096/);

    const junkChunks = Buffer.concat(
      Array.from({ length: 1025 }, () => webpChunk("JUNK", Buffer.alloc(0))),
    );
    const webpHeader = Buffer.alloc(12);
    webpHeader.write("RIFF", 0, 4, "ascii");
    webpHeader.writeUInt32LE(junkChunks.length + 4, 4);
    webpHeader.write("WEBP", 8, 4, "ascii");
    expect(() => inspectLocalImage(Buffer.concat([webpHeader, junkChunks]), "storm.webp")).toThrow(
      /more than 1024/,
    );
  });

  test("accepts the pixel boundary and rejects one pixel-budget step beyond it", () => {
    expect(inspectLocalImage(jpegFixture(4000, 4000), "boundary.jpg").pixels).toBe(16_000_000);
    expect(() => inspectLocalImage(jpegFixture(4001, 4000), "over.jpg")).toThrow(
      /dimensions exceed/,
    );
  });

  test("bounds PNG structural work and requires consecutive image-data chunks", () => {
    const emptyTextChunk = pngChunk("tEXt", Buffer.alloc(0));
    const chunkStorm = insertChunksAfterIhdr(
      ONE_PIXEL_PNG,
      Array.from({ length: 1022 }, () => emptyTextChunk),
    );
    expect(() => readPngDimensions(chunkStorm)).toThrow(/more than 1024 chunks/);

    const emptyImageData = pngChunk("IDAT", Buffer.alloc(0));
    const imageDataStorm = insertChunksAfterIhdr(
      ONE_PIXEL_PNG,
      Array.from({ length: 256 }, () => emptyImageData),
    );
    expect(() => readPngDimensions(imageDataStorm)).toThrow(/more than 256 image-data chunks/);

    const splitImageData = insertChunksAfterIhdr(ONE_PIXEL_PNG, [emptyImageData, emptyTextChunk]);
    expect(() => readPngDimensions(splitImageData)).toThrow(/must be consecutive/);
  });

  test("renders hostile image sources as inert notices without reading them", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, "document");
    await mkdir(directory);
    const markdown = join(directory, "review.md");
    const outside = join(root, "secret.png");
    await writeFile(outside, ONE_PIXEL_PNG);
    await writeFile(
      markdown,
      "# Review\n\n![Traversal](../secret.png)\n\n![Remote](https://example.com/a.png)\n",
    );

    const opened = await new MarkdownReviewService().open(markdown);
    expect(opened.document.images).toEqual([]);
    expect(opened.document.html).toContain("Image not rendered");
    expect(opened.document.html).not.toContain(ONE_PIXEL_PNG.toString("base64"));
  });

  test("enforces local-image byte and decoded-dimension budgets", async () => {
    const directory = await temporaryDirectory();
    const markdown = join(directory, "review.md");
    const oversized = join(directory, "oversized.png");
    const hugeDimensions = join(directory, "huge.png");
    await writeFile(oversized, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1));
    const hugeHeader = Buffer.from(ONE_PIXEL_PNG);
    hugeHeader.writeUInt32BE(MAX_IMAGE_DIMENSION + 1, 16);
    hugeHeader.writeUInt32BE(crc32(hugeHeader.subarray(12, 29)), 29);
    await writeFile(hugeDimensions, hugeHeader);
    await writeFile(
      markdown,
      ["# Review", "![Oversized](oversized.png)", "![Huge](huge.png)"].join("\n\n"),
    );

    const opened = await new MarkdownReviewService().open(markdown);
    expect(opened.document.images).toHaveLength(0);
    expect(opened.document.html).toContain(`exceeds the ${MAX_INLINE_IMAGE_BYTES}-byte limit`);
    expect(opened.document.html).toContain("decoded dimensions exceed the safety limit");
  });

  test("deduplicates canonical image snapshots and bounds local image references", async () => {
    const directory = await temporaryDirectory();
    const markdown = join(directory, "review.md");
    await writeFile(join(directory, "pixel.png"), ONE_PIXEL_PNG);
    await writeFile(
      markdown,
      [
        "# Review",
        ...Array.from(
          { length: MAX_INLINE_IMAGE_REFERENCES + 1 },
          (_, index) => `![Pixel ${index + 1}](${index % 2 === 0 ? "pixel.png" : "./pixel.png"})`,
        ),
      ].join("\n\n"),
    );

    const opened = await new MarkdownReviewService().open(markdown);
    const renderedReferences =
      opened.document.html.match(/data-local-image-id="local-image-1"/g) ?? [];
    expect(opened.document.images).toHaveLength(1);
    expect(renderedReferences).toHaveLength(MAX_INLINE_IMAGE_REFERENCES);
    expect(opened.document.html).toContain(
      `processes up to ${MAX_INLINE_IMAGE_REFERENCES} local image references`,
    );
  });

  test("deduplicates byte-identical snapshots across paths and preserves detected MIME types", async () => {
    const directory = await temporaryDirectory();
    const markdown = join(directory, "review.md");
    const jpeg = jpegFixture(2, 3);
    await Promise.all([
      writeFile(join(directory, "first.jpg"), jpeg),
      writeFile(join(directory, "copy.jpeg"), jpeg),
      writeFile(join(directory, "static.webp"), webpFixture(4, 5)),
      writeFile(join(directory, "pixel.png"), ONE_PIXEL_PNG),
      writeFile(join(directory, "disguised.jpg"), ONE_PIXEL_PNG),
    ]);
    await writeFile(
      markdown,
      [
        "# Review",
        "![First](first.jpg)",
        "![Copy](copy.jpeg)",
        "![WebP](static.webp)",
        "![PNG](pixel.png)",
        "![Mismatch](disguised.jpg)",
      ].join("\n\n"),
    );

    const service = new MarkdownReviewService();
    const opened = await service.open(markdown);
    expect(opened.document.images.map((image) => image.mimeType)).toEqual([
      "image/jpeg",
      "image/webp",
      "image/png",
    ]);
    for (const image of opened.document.images) {
      const chunk = service.loadAssetChunk({
        reviewSessionId: opened.document.reviewSessionId,
        revision: opened.document.revision,
        imageId: image.id,
        chunkIndex: 0,
      });
      expect(chunk.summary.mimeType).toBe(image.mimeType);
      expect(chunk.privateChunk.mimeType).toBe(image.mimeType);
    }
    expect(opened.document.html.match(/data-local-image-id="local-image-1"/g)).toHaveLength(2);
    expect(opened.document.html).toContain("extension does not match");
  });

  test("counts invalid image tags against the local reference work budget", async () => {
    const directory = await temporaryDirectory();
    const markdown = join(directory, "review.md");
    await writeFile(join(directory, "pixel.png"), ONE_PIXEL_PNG);
    await writeFile(
      markdown,
      [
        "# Review",
        ...Array.from(
          { length: MAX_INLINE_IMAGE_REFERENCES },
          (_, index) => `![Missing ${index + 1}](missing-${index + 1}.png)`,
        ),
        "![Valid but over budget](pixel.png)",
      ].join("\n\n"),
    );

    const opened = await new MarkdownReviewService().open(markdown);
    expect(opened.document.images).toHaveLength(0);
    expect(opened.document.html).not.toContain("data-local-image-id");
    expect(opened.document.html).toContain(
      `processes up to ${MAX_INLINE_IMAGE_REFERENCES} local image references`,
    );
  });
});
