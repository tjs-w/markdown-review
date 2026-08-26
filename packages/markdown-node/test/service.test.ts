import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MarkdownReviewService } from "../src/service.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const STATIC_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
  "base64",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixture(): Promise<{ directory: string; markdown: string; image: string }> {
  const directory = await mkdtemp(join(tmpdir(), "markdown-review-node-"));
  temporaryDirectories.push(directory);
  const markdown = join(directory, "review.md");
  const image = join(directory, "pixel.png");
  await writeFile(image, ONE_PIXEL_PNG);
  await writeFile(markdown, "# Review\n\n<script>alert(1)</script>\n\n![Pixel](pixel.png)\n");
  return { directory, markdown, image };
}

describe("MarkdownReviewService", () => {
  test("renders sanitized GFM and snapshots immutable image bytes", async () => {
    const paths = await fixture();
    const service = new MarkdownReviewService();
    const opened = await service.open(paths.markdown);

    expect(opened.document.reviewSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(opened.document.html).not.toContain("<script>");
    expect(opened.document.html).toContain('data-local-image-id="local-image-1"');
    expect(opened.document.images[0]?.revision).toHaveLength(64);

    await writeFile(paths.image, Buffer.from("changed after review"));
    const descriptor = opened.document.images[0];
    if (!descriptor) throw new Error("Expected the PNG fixture to be captured");
    const chunks: Buffer[] = [];
    for (let chunkIndex = 0; chunkIndex < descriptor.chunkCount; chunkIndex += 1) {
      const chunk = service.loadAssetChunk({
        reviewSessionId: opened.document.reviewSessionId,
        revision: opened.document.revision,
        imageId: descriptor.id,
        chunkIndex,
      });
      chunks.push(Buffer.from(chunk.privateChunk.data, "base64"));
    }
    expect(Buffer.concat(chunks)).toEqual(ONE_PIXEL_PNG);
  });

  test("binds private document and image access to the session and revision", async () => {
    const paths = await fixture();
    const service = new MarkdownReviewService();
    const opened = await service.open(paths.markdown);
    const descriptor = opened.document.images[0];
    if (!descriptor) throw new Error("Expected the PNG fixture to be captured");

    const refreshed = await service.loadDocument(opened.document.reviewSessionId);
    expect(refreshed.summary.path).toBe(opened.summary.path);
    expect(refreshed.document.reviewSessionId).not.toBe(opened.document.reviewSessionId);
    try {
      await service.loadDocument("00000000-0000-4000-8000-000000000000");
      throw new Error("Expected the forged session to be rejected");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/expired/);
    }
    expect(() =>
      service.loadAssetChunk({
        reviewSessionId: opened.document.reviewSessionId,
        revision: "stale-revision",
        imageId: descriptor.id,
        chunkIndex: 0,
      }),
    ).toThrow(/Markdown changed/);
  });

  test("recovers a fresh immutable snapshot after the original server loses its session", async () => {
    const paths = await fixture();
    const originalService = new MarkdownReviewService();
    const original = await originalService.open(paths.markdown);
    await writeFile(paths.image, STATIC_JPEG);
    const recoveredService = new MarkdownReviewService();

    const recovered = await recoveredService.recoverDocument({
      reviewSessionId: original.document.reviewSessionId,
      path: original.document.path,
      revision: original.document.revision,
    });

    expect(recovered.document.reviewSessionId).not.toBe(original.document.reviewSessionId);
    expect(recovered.summary.path).toBe(original.summary.path);
    expect(recovered.summary.revision).toBe(original.summary.revision);
    const image = recovered.document.images[0];
    if (!image) throw new Error("Expected the recovered image snapshot");
    expect(image.mimeType).toBe("image/jpeg");
    const chunk = recoveredService.loadAssetChunk({
      reviewSessionId: recovered.document.reviewSessionId,
      revision: recovered.document.revision,
      imageId: image.id,
      chunkIndex: 0,
    });
    expect(Buffer.from(chunk.privateChunk.data, "base64")).toEqual(STATIC_JPEG);
  });

  test("rejects a recovery identity that conflicts with a live session", async () => {
    const paths = await fixture();
    const service = new MarkdownReviewService();
    const opened = await service.open(paths.markdown);

    try {
      await service.recoverDocument({
        reviewSessionId: opened.document.reviewSessionId,
        path: `${opened.document.path}.forged.md`,
        revision: opened.document.revision,
      });
      throw new Error("Expected the conflicting recovery identity to be rejected");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/did not match/);
    }
  });
});
