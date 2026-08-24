import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewDocument, ReviewDocumentSummary } from "@markdown-review/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { LoadedAssetChunk, OpenedMarkdownReview } from "@markdown-review/markdown-node";

import { createFileReviewUiAssetLoader } from "../src/assets.js";
import { createMarkdownReviewServer, MARKDOWN_REVIEW_TEMPLATE_URI } from "../src/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const reviewSessionId = "00000000-0000-4000-8000-000000000001";
const summary: ReviewDocumentSummary = {
  path: "/tmp/review.md",
  filename: "review.md",
  title: "Review",
  revision: "revision",
  modifiedAt: "2026-08-23T00:00:00.000Z",
  sizeBytes: 10,
  lineCount: 1,
  blockCount: 1,
};
const document: ReviewDocument = {
  ...summary,
  kind: "markdown-review-document",
  reviewSessionId,
  html: "<h1>Private review</h1>",
  images: [],
};
const opened: OpenedMarkdownReview = { summary, document };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolVisibility(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value["ui"])) return undefined;
  return value["ui"]["visibility"];
}

describe("createMarkdownReviewServer", () => {
  test("preserves the public summary and keeps session data app-private", async () => {
    const backend = {
      open(): Promise<OpenedMarkdownReview> {
        return Promise.resolve(opened);
      },
      loadDocument(): Promise<OpenedMarkdownReview> {
        return Promise.resolve(opened);
      },
      loadAssetChunk(): LoadedAssetChunk {
        throw new Error("No image fixture");
      },
    };
    const server = createMarkdownReviewServer({
      backend,
      assetLoader: {
        load() {
          return Promise.resolve({
            template:
              "<html><!-- MARKDOWN_REVIEW_PNG_DECODER --><!-- MARKDOWN_REVIEW_APP --></html>",
            pngDecoder: "window.decoder = true; // </script",
            reviewBundle: "window.review = '$&'; // </script",
          });
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "markdown-review-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "open_markdown_review",
        "load_markdown_review_document",
        "load_markdown_review_image_chunk",
      ]);
      expect(toolVisibility(tools.tools[1]?._meta)).toEqual(["app"]);
      expect(toolVisibility(tools.tools[2]?._meta)).toEqual(["app"]);

      const result = await client.callTool({
        name: "open_markdown_review",
        arguments: { path: summary.path },
      });
      expect(result.structuredContent).toEqual(summary);
      expect(JSON.stringify(result.structuredContent)).not.toContain(reviewSessionId);
      expect(result._meta?.["document"]).toEqual(document);

      const resource = await client.readResource({ uri: MARKDOWN_REVIEW_TEMPLATE_URI });
      const resourceContent = resource.contents[0];
      const html = resourceContent && "text" in resourceContent ? resourceContent.text : "";
      expect(html).toContain("window.decoder = true");
      expect(html).toContain("window.review = '$&'");
      expect(html).not.toContain("MARKDOWN_REVIEW_PNG_DECODER");
      expect(html).not.toContain("MARKDOWN_REVIEW_APP");
      expect(html).toContain("<\\/script");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("file UI asset loader", () => {
  test("loads the three module-relative shipping assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "markdown-review-assets-"));
    temporaryDirectories.push(directory);
    const templatePath = join(directory, "review.html");
    const pngDecoderPath = join(directory, "png-decoder.js");
    const reviewBundlePath = join(directory, "review.js");
    await Promise.all([
      writeFile(templatePath, "template"),
      writeFile(pngDecoderPath, "decoder"),
      writeFile(reviewBundlePath, "review"),
    ]);

    expect(
      await createFileReviewUiAssetLoader({
        templatePath,
        pngDecoderPath,
        reviewBundlePath,
      }).load(),
    ).toEqual({ template: "template", pngDecoder: "decoder", reviewBundle: "review" });
  });
});
