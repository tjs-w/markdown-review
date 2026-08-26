import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReviewDocument, ReviewDocumentSummary } from "@markdown-review/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { LoadedAssetChunk, OpenedMarkdownReview } from "@markdown-review/markdown-node";

import { createFileReviewUiAssetLoader } from "../src/assets.js";
import {
  createMarkdownReviewServer,
  developerModeEnabled,
  MARKDOWN_REVIEW_TEMPLATE_URI,
} from "../src/server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const reviewSessionId = "00000000-0000-4000-8000-000000000001";
const recoveredReviewSessionId = "00000000-0000-4000-8000-000000000002";
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
const recoveredDocument: ReviewDocument = {
  ...document,
  reviewSessionId: recoveredReviewSessionId,
};
const recoveredOpened: OpenedMarkdownReview = { summary, document: recoveredDocument };
const chunkRequest = {
  reviewSessionId,
  revision: summary.revision,
  imageId: "image-1",
  chunkIndex: 0,
};
const chunkSummary = {
  kind: "markdown-review-image-chunk" as const,
  ...chunkRequest,
  imageRevision: "image-revision",
  mimeType: "image/png" as const,
  chunkCount: 1,
  byteOffset: 0,
  byteLength: 3,
};
const loadedChunk: LoadedAssetChunk = {
  summary: chunkSummary,
  privateChunk: { ...chunkSummary, data: "YWJj" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolVisibility(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value["ui"])) return undefined;
  return value["ui"]["visibility"];
}

describe("createMarkdownReviewServer", () => {
  test("preserves the public summary and keeps session data app-private", async () => {
    let documentLoadError: Error | undefined;
    let recoveryRequest: unknown;
    let recoveryError: Error | undefined;
    let returnExpiredRecoverySession = false;
    const backend = {
      open(): Promise<OpenedMarkdownReview> {
        return Promise.resolve(opened);
      },
      loadDocument(): Promise<OpenedMarkdownReview> {
        if (documentLoadError) return Promise.reject(documentLoadError);
        return Promise.resolve(opened);
      },
      recoverDocument(request: unknown): Promise<OpenedMarkdownReview> {
        recoveryRequest = request;
        if (recoveryError) return Promise.reject(recoveryError);
        return Promise.resolve(returnExpiredRecoverySession ? opened : recoveredOpened);
      },
      loadAssetChunk(): LoadedAssetChunk {
        throw new Error("No image fixture");
      },
    };
    const server = createMarkdownReviewServer({
      backend,
      allowNativeDevTools: true,
      assetLoader: {
        load() {
          return Promise.resolve({
            template: "<html><!-- MARKDOWN_REVIEW_APP --></html>",
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
        "recover_markdown_review_document",
        "load_markdown_review_image_chunk",
      ]);
      expect(toolVisibility(tools.tools[1]?._meta)).toEqual(["app"]);
      expect(toolVisibility(tools.tools[2]?._meta)).toEqual(["app"]);
      expect(toolVisibility(tools.tools[3]?._meta)).toEqual(["app"]);
      const resources = await client.listResources();
      expect(resources.resources[0]?._meta?.["ui"]).toEqual({
        prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [] },
        permissions: { clipboardWrite: {} },
      });

      const result = await client.callTool({
        name: "open_markdown_review",
        arguments: { path: summary.path },
      });
      expect(result.structuredContent).toEqual(summary);
      expect(JSON.stringify(result.structuredContent)).not.toContain(reviewSessionId);
      expect(result._meta?.["document"]).toEqual(document);

      documentLoadError = new Error("Sensitive document detail: /Users/example/private.md");
      const failedRefresh = await client.callTool({
        name: "load_markdown_review_document",
        arguments: { reviewSessionId },
      });
      expect(failedRefresh.isError).toBeTrue();
      expect(failedRefresh.content).toEqual([
        { type: "text", text: "The Markdown review document could not be loaded." },
      ]);
      expect(failedRefresh._meta?.["document"]).toEqual({
        kind: "markdown-review-document",
        reviewSessionId,
        error: "The Markdown review document could not be loaded.",
      });
      expect(JSON.stringify(failedRefresh)).not.toContain("/Users/example/private.md");

      documentLoadError = undefined;
      const recovered = await client.callTool({
        name: "recover_markdown_review_document",
        arguments: {
          reviewSessionId,
          path: summary.path,
          revision: summary.revision,
        },
      });
      expect(recoveryRequest).toEqual({
        reviewSessionId,
        path: summary.path,
        revision: summary.revision,
      });
      expect(recovered.structuredContent).toEqual(summary);
      expect(recovered.content).toEqual([]);
      expect(recovered._meta?.["document"]).toEqual(recoveredDocument);

      returnExpiredRecoverySession = true;
      const invalidRecovery = await client.callTool({
        name: "recover_markdown_review_document",
        arguments: {
          reviewSessionId,
          path: summary.path,
          revision: summary.revision,
        },
      });
      expect(invalidRecovery.isError).toBeTrue();
      expect(invalidRecovery.content).toEqual([
        { type: "text", text: "The Markdown review document could not be loaded." },
      ]);

      returnExpiredRecoverySession = false;
      recoveryError = new Error("Sensitive recovery detail: /Users/example/private.md");
      const failedRecovery = await client.callTool({
        name: "recover_markdown_review_document",
        arguments: {
          reviewSessionId,
          path: summary.path,
          revision: summary.revision,
        },
      });
      expect(failedRecovery.isError).toBeTrue();
      expect(failedRecovery.content).toEqual([
        { type: "text", text: "The Markdown review document could not be loaded." },
      ]);
      expect(failedRecovery._meta?.["document"]).toEqual({
        kind: "markdown-review-document",
        path: summary.path,
        reviewSessionId,
        error: "The Markdown review document could not be loaded.",
      });
      expect(JSON.stringify(failedRecovery.content)).not.toContain("/Users/example/private.md");

      const resource = await client.readResource({ uri: MARKDOWN_REVIEW_TEMPLATE_URI });
      const resourceContent = resource.contents[0];
      const html = resourceContent && "text" in resourceContent ? resourceContent.text : "";
      expect(html).toContain('data-markdown-review-developer-mode="true"');
      expect(html).toContain("window.review = '$&'");
      expect(html).not.toContain("MARKDOWN_REVIEW_APP");
      expect(html).toContain("<\\/script");
      expect(resourceContent?._meta?.["ui"]).toEqual({
        prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [] },
        permissions: { clipboardWrite: {} },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps image bytes private and returns stable safe image failure metadata", async () => {
    let loadError: Error | undefined;
    const backend = {
      open(): Promise<OpenedMarkdownReview> {
        return Promise.resolve(opened);
      },
      loadDocument(): Promise<OpenedMarkdownReview> {
        return Promise.resolve(opened);
      },
      loadAssetChunk(): LoadedAssetChunk {
        if (loadError) throw loadError;
        return loadedChunk;
      },
    };
    const server = createMarkdownReviewServer({
      backend,
      assetLoader: {
        load() {
          return Promise.resolve({
            template: "<html><!-- MARKDOWN_REVIEW_APP --></html>",
            reviewBundle: "window.review = true;",
          });
        },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "markdown-review-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const success = await client.callTool({
        name: "load_markdown_review_image_chunk",
        arguments: chunkRequest,
      });
      expect(success.structuredContent).toEqual(chunkSummary);
      expect(JSON.stringify(success.structuredContent)).not.toContain(
        loadedChunk.privateChunk.data,
      );
      expect(success._meta?.["imageChunk"]).toEqual(loadedChunk.privateChunk);

      const unsupportedRecovery = await client.callTool({
        name: "recover_markdown_review_document",
        arguments: {
          reviewSessionId,
          path: summary.path,
          revision: summary.revision,
        },
      });
      expect(unsupportedRecovery.isError).toBeTrue();
      expect(unsupportedRecovery.content).toEqual([
        { type: "text", text: "The Markdown review document could not be loaded." },
      ]);

      loadError = new Error(
        "The Markdown review session is unavailable or expired; reopen the review.",
      );
      const expired = await client.callTool({
        name: "load_markdown_review_image_chunk",
        arguments: chunkRequest,
      });
      expect(expired.isError).toBeTrue();
      expect(expired.content).toEqual([
        {
          type: "text",
          text: "The Markdown review session is unavailable or expired; reopen the review.",
        },
      ]);
      expect(expired._meta?.["reviewError"]).toEqual({
        code: "session_expired",
        message: "The Markdown review session is unavailable or expired; reopen the review.",
      });

      loadError = new Error(`Sensitive backend detail: ${summary.path} ${reviewSessionId}`);
      const unknown = await client.callTool({
        name: "load_markdown_review_image_chunk",
        arguments: chunkRequest,
      });
      expect(unknown.isError).toBeTrue();
      expect(unknown.content).toEqual([
        { type: "text", text: "The Markdown review image could not be loaded." },
      ]);
      expect(unknown._meta?.["reviewError"]).toEqual({
        code: "image_load_failed",
        message: "The Markdown review image could not be loaded.",
      });
      expect(JSON.stringify(unknown)).not.toContain(summary.path);
      expect(JSON.stringify(unknown)).not.toContain(reviewSessionId);

      const resource = await client.readResource({ uri: MARKDOWN_REVIEW_TEMPLATE_URI });
      const content = resource.contents[0];
      expect(content && "text" in content ? content.text : "").not.toContain(
        "data-markdown-review-developer-mode",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("developer mode flag", () => {
  test("enables native DevTools only for the exact value 1", () => {
    expect(developerModeEnabled("1")).toBe(true);
    for (const value of [undefined, "", "true", "yes", "TRUE", "01"]) {
      expect(developerModeEnabled(value)).toBe(false);
    }
  });
});

describe("file UI asset loader", () => {
  test("loads the two module-relative shipping assets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "markdown-review-assets-"));
    temporaryDirectories.push(directory);
    const templatePath = join(directory, "review.html");
    const reviewBundlePath = join(directory, "review.js");
    await Promise.all([writeFile(templatePath, "template"), writeFile(reviewBundlePath, "review")]);

    expect(
      await createFileReviewUiAssetLoader({
        templatePath,
        reviewBundlePath,
      }).load(),
    ).toEqual({ template: "template", reviewBundle: "review" });
  });
});
