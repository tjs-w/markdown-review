import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
import { encode } from "fast-png";

import {
  DefaultMarkdownPathPolicy,
  MAX_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_REFERENCES,
  MAX_MARKDOWN_BYTES,
  MarkdownReviewService,
  readFileHandleBounded,
  readPngDimensions,
  validatePng,
} from "../src/index.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
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

function replaceIdat(png: Buffer, data: Buffer): Buffer {
  const typeOffset = png.indexOf(Buffer.from("IDAT", "ascii"));
  if (typeOffset < 4) throw new Error("Expected an IDAT chunk");
  const chunkOffset = typeOffset - 4;
  const nextOffset = typeOffset + 4 + png.readUInt32BE(chunkOffset) + 4;
  return Buffer.concat([
    png.subarray(0, chunkOffset),
    pngChunk("IDAT", data),
    png.subarray(nextOffset),
  ]);
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

function failureMessage(operation: () => void): string {
  try {
    operation();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to fail");
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

  test("denies traversal, encoded traversal, remote, absolute, non-PNG, and symlink escapes", async () => {
    const root = await temporaryDirectory();
    const documentDirectory = join(root, "document");
    await mkdir(documentDirectory);
    const markdown = join(documentDirectory, "review.md");
    const outsidePng = join(root, "outside.png");
    const text = join(documentDirectory, "image.txt");
    const localPng = join(documentDirectory, "local.png");
    const escape = join(documentDirectory, "escape.png");
    await writeFile(markdown, "# Review\n");
    await writeFile(outsidePng, ONE_PIXEL_PNG);
    await writeFile(localPng, ONE_PIXEL_PNG);
    await writeFile(text, "not png");
    await symlink(outsidePng, escape);
    const policy = new DefaultMarkdownPathPolicy();

    expect(await policy.resolveLocalImagePath(markdown, "local.png")).toBe(
      await realpath(localPng),
    );
    for (const source of [
      "../outside.png",
      "..%2Foutside.png",
      "https://example.com/image.png",
      "//example.com/image.png",
      outsidePng,
      "image.txt",
      "escape.png",
    ]) {
      expect(await rejectionMessage(() => policy.resolveLocalImagePath(markdown, source))).not.toBe(
        "",
      );
    }
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
    expect(
      failureMessage(() => {
        validatePng(corrupted, readPngDimensions(corrupted));
      }),
    ).toMatch(/complete valid PNG/);
  });

  test("rejects unsafe PNG profiles, animation, palettes, inflation, and sample depths", () => {
    const profileBomb = insertAfterIhdr(
      ONE_PIXEL_PNG,
      "iCCP",
      Buffer.concat([
        Buffer.from("profile\0", "latin1"),
        Buffer.from([0]),
        deflateSync(Buffer.alloc(1024 * 1024)),
      ]),
    );
    expect(() => readPngDimensions(profileBomb)).toThrow(/color profiles/);

    const animated = insertAfterIhdr(ONE_PIXEL_PNG, "acTL", Buffer.alloc(8));
    expect(() => readPngDimensions(animated)).toThrow(/Animated PNG/);

    const indexed = Buffer.from(ONE_PIXEL_PNG);
    indexed[25] = 3;
    const paletteBomb = insertAfterIhdr(indexed, "PLTE", Buffer.alloc(30_000));
    expect(() => readPngDimensions(paletteBomb)).toThrow(/1 to 256 RGB entries/);

    const grayscale = Buffer.from(
      encode({ width: 1, height: 1, channels: 1, data: Uint8Array.from([42]) }),
    );
    const colorKeyTransparency = insertAfterIhdr(grayscale, "tRNS", Buffer.from([0, 42]));
    expect(() => readPngDimensions(colorKeyTransparency)).toThrow(/color-key transparency/);

    const imageDataBomb = replaceIdat(ONE_PIXEL_PNG, deflateSync(Buffer.alloc(1024 * 1024)));
    const bombDimensions = readPngDimensions(imageDataBomb);
    expect(() => {
      validatePng(imageDataBomb, bombDimensions);
    }).toThrow(/decoded-size limit/);

    const sixteenBit = Buffer.from(
      encode({
        width: 1,
        height: 1,
        channels: 4,
        depth: 16,
        data: Uint16Array.from([1, 2, 3, 4]),
      }),
    );
    expect(() => readPngDimensions(sixteenBit)).toThrow(/8-bit PNG samples/);
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
