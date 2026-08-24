import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DefaultMarkdownPathPolicy,
  MAX_IMAGE_DIMENSION,
  MAX_INLINE_IMAGE_BYTES,
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
    const dimensions = readPngDimensions(header);
    expect(
      failureMessage(() => {
        validatePng(header, dimensions);
      }),
    ).toMatch(/complete valid PNG/);

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

  test("enforces local-image count, byte, and decoded-dimension budgets", async () => {
    const directory = await temporaryDirectory();
    const markdown = join(directory, "review.md");
    const oversized = join(directory, "oversized.png");
    const hugeDimensions = join(directory, "huge.png");
    await writeFile(oversized, Buffer.alloc(MAX_INLINE_IMAGE_BYTES + 1));
    const hugeHeader = Buffer.from(ONE_PIXEL_PNG);
    hugeHeader.writeUInt32BE(MAX_IMAGE_DIMENSION + 1, 16);
    await writeFile(hugeDimensions, hugeHeader);
    await writeFile(join(directory, "pixel.png"), ONE_PIXEL_PNG);
    await writeFile(
      markdown,
      [
        "# Review",
        "![Oversized](oversized.png)",
        "![Huge](huge.png)",
        ...Array.from({ length: 9 }, (_, index) => `![Pixel ${index + 1}](pixel.png)`),
      ].join("\n\n"),
    );

    const opened = await new MarkdownReviewService().open(markdown);
    expect(opened.document.images).toHaveLength(8);
    expect(opened.document.html).toContain(`exceeds the ${MAX_INLINE_IMAGE_BYTES}-byte limit`);
    expect(opened.document.html).toContain("decoded dimensions exceed the safety limit");
    expect(opened.document.html).toContain("supports up to 8 local images");
  });
});
