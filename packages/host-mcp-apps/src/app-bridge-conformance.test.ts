import { describe, expect, test } from "bun:test";
import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiMessageRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PrivateReviewImageChunkSchema,
  ReviewDocumentSchema,
  ReviewDocumentSummarySchema,
  ReviewSubmissionSchema,
  type ReviewDocument,
} from "@markdown-review/contracts";
import { ReviewPortError } from "@markdown-review/review-ui";

import { createMcpAppsHost, type McpAppsHost } from "./mcp-apps-host";

const firstDocument = ReviewDocumentSchema.parse({
  kind: "markdown-review-document",
  reviewSessionId: "123e4567-e89b-42d3-a456-426614174000",
  path: "/tmp/review.md",
  filename: "review.md",
  title: "Review",
  revision: "revision-a",
  modifiedAt: "2026-08-23T20:00:00.000Z",
  sizeBytes: 20,
  lineCount: 2,
  blockCount: 1,
  html: '<p class="review-block" data-start-line="1" data-end-line="2">Review</p>',
  images: [],
});

const laterDocument = ReviewDocumentSchema.parse({
  ...firstDocument,
  reviewSessionId: "223e4567-e89b-42d3-a456-426614174000",
  revision: "revision-b",
  title: "Later review",
});

const submission = ReviewSubmissionSchema.parse({
  submissionId: "stable-submission-id",
  itemIds: ["feedback-1"],
  batch: {
    schema: "markdown-review/v1",
    file: firstDocument.path,
    revision: firstDocument.revision,
    items: [
      {
        id: "#1",
        refs: [],
        lines: [1, 1],
        quote: "Review",
        comment: "Tighten this.",
      },
    ],
  },
});

const privateImageChunk = PrivateReviewImageChunkSchema.parse({
  kind: "markdown-review-image-chunk",
  reviewSessionId: firstDocument.reviewSessionId,
  revision: firstDocument.revision,
  imageId: "local-image-1",
  imageRevision: "image-revision-a",
  mimeType: "image/png",
  chunkIndex: 0,
  chunkCount: 1,
  byteOffset: 0,
  byteLength: 3,
  data: "AAEC",
});
const { data: privateImageData, ...imageChunkSummary } = privateImageChunk;

interface AppBridgeHarness {
  readonly bridge: AppBridge;
  readonly documents: ReviewDocument[];
  readonly errors: Error[];
  readonly host: McpAppsHost;
}

async function createHarness({
  capabilities = {},
  context = {},
  onCallTool,
  onTeardown,
}: {
  readonly capabilities?: McpUiHostCapabilities;
  readonly context?: McpUiHostContext;
  readonly onCallTool?: NonNullable<AppBridge["oncalltool"]>;
  readonly onTeardown?: () => void;
} = {}): Promise<AppBridgeHarness> {
  const [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  const documents: ReviewDocument[] = [];
  const errors: Error[] = [];
  const bridge = new AppBridge(
    null,
    { name: "markdown-review-test-host", version: "1.0.0" },
    capabilities,
    { hostContext: context },
  );
  bridge.oncalltool = onCallTool;
  const host = createMcpAppsHost({
    hostWindow: { innerWidth: 1024 } as Window,
    transport: appTransport,
    onDocument(document) {
      documents.push(document);
    },
    onError(error) {
      errors.push(error);
    },
    ...(onTeardown ? { onTeardown } : {}),
  });

  await bridge.connect(bridgeTransport);
  await host.connect();
  return { bridge, documents, errors, host };
}

async function closeHarness({ bridge, host }: AppBridgeHarness): Promise<void> {
  await host.close();
  await bridge.close();
}

async function rejectionMessage(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to reject");
}

async function rejectionError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the operation to reject");
}

describe("official MCP Apps AppBridge conformance", () => {
  test("completes the standard initialization handshake before accepting tool results", async () => {
    const [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
    const documents: ReviewDocument[] = [];
    let initialized = false;
    const bridge = new AppBridge(null, { name: "markdown-review-test-host", version: "1.0.0" }, {});
    bridge.addEventListener("initialized", () => {
      initialized = true;
    });
    const host = createMcpAppsHost({
      hostWindow: { innerWidth: 1024 } as Window,
      transport: appTransport,
      onDocument(document) {
        documents.push(document);
      },
    });

    await bridge.connect(bridgeTransport);
    expect(initialized).toBe(false);
    await host.connect();

    expect(initialized).toBe(true);
    expect(bridge.getAppVersion()).toEqual({ name: "markdown-review", version: "0.1.0" });
    expect(bridge.getAppCapabilities()?.availableDisplayModes).toEqual(["inline", "fullscreen"]);
    expect(documents).toEqual([]);

    await bridge.sendToolInput({ arguments: { path: firstDocument.path } });
    await bridge.sendToolResult({
      content: [],
      structuredContent: ReviewDocumentSummarySchema.parse({
        path: firstDocument.path,
        filename: firstDocument.filename,
        title: firstDocument.title,
        revision: firstDocument.revision,
        modifiedAt: firstDocument.modifiedAt,
        sizeBytes: firstDocument.sizeBytes,
        lineCount: firstDocument.lineCount,
        blockCount: firstDocument.blockCount,
      }),
      _meta: { document: firstDocument },
    });
    expect(documents).toEqual([firstDocument]);

    await host.close();
    await bridge.close();
  });

  test("runs without window.openai and disables methods absent from negotiated capabilities", async () => {
    const harness = await createHarness();
    const capabilities = harness.host.ports.presentation.capabilities;

    expect(capabilities.documentTools).toBe(false);
    expect(capabilities.externalLinks).toBe(false);
    expect(capabilities.submission).toBe(false);
    expect(capabilities.displayMode).toBe(false);
    expect(
      await rejectionMessage(harness.host.ports.documents.refresh(firstDocument.reviewSessionId)),
    ).toContain("does not allow component tools");
    expect(await rejectionMessage(harness.host.ports.submissions.submit(submission))).toContain(
      "does not accept review submissions",
    );
    expect(
      await rejectionMessage(
        harness.host.ports.presentation.openExternal?.(new URL("https://example.com")) ??
          Promise.reject(new Error("Missing external-link adapter")),
      ),
    ).toContain("does not allow external links");
    expect(
      await rejectionMessage(
        harness.host.ports.presentation.requestDisplayMode?.("fullscreen") ??
          Promise.reject(new Error("Missing display-mode adapter")),
      ),
    ).toContain("does not support fullscreen");
    expect(harness.errors).toEqual([]);

    await closeHarness(harness);
  });

  test("acknowledges host teardown and invokes the adapter teardown exactly once", async () => {
    let teardownCount = 0;
    const harness = await createHarness({
      onTeardown() {
        teardownCount += 1;
      },
    });

    expect(await harness.bridge.teardownResource({})).toEqual({});
    expect(teardownCount).toBe(1);
    expect(harness.host.ports.presentation.capabilities.intrinsicHeight).toBe(false);
    expect(harness.errors).toEqual([]);

    await closeHarness(harness);
  });

  test("accepts only the first private initial document despite model-visible and duplicate events", async () => {
    const harness = await createHarness();

    await harness.bridge.sendToolResult({
      content: [],
      structuredContent: { document: { ...firstDocument, reviewSessionId: "forged" } },
    });
    await harness.bridge.sendToolInput({ arguments: { document: firstDocument } });
    await harness.bridge.sendToolResult({
      content: [],
      _meta: { document: laterDocument },
    });
    await harness.bridge.sendToolResult({
      content: [],
      structuredContent: { document: firstDocument },
    });
    await harness.bridge.sendToolResult({ content: [], _meta: { document: firstDocument } });

    expect(harness.documents).toEqual([laterDocument]);
    expect(harness.errors.map((error) => error.message)).toEqual([
      "The Markdown Review host returned an invalid document payload",
    ]);

    await closeHarness(harness);
  });

  test("submits through ui/message when Codex advertises an empty message capability", async () => {
    const received: McpUiMessageRequest["params"][] = [];
    const [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
    const bridge = new AppBridge(
      null,
      { name: "markdown-review-test-host", version: "1.0.0" },
      { message: {} },
    );
    bridge.onmessage = (message) => {
      received.push(message);
      return Promise.resolve({});
    };
    const host = createMcpAppsHost({
      hostWindow: { innerWidth: 1024 } as Window,
      transport: appTransport,
      onDocument: () => undefined,
    });
    await bridge.connect(bridgeTransport);
    await host.connect();

    expect(host.ports.presentation.capabilities.submission).toBe(true);
    await host.ports.submissions.submit(submission);
    expect(received).toHaveLength(1);
    const content = received[0]?.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("Expected a text message");
    expect(JSON.parse(content.text)).toEqual(submission);
    expect(content.text).not.toContain("$markdown-review");

    await host.close();
    await bridge.close();
  });

  test("preserves container dimensions and reports inline height without owning host width", async () => {
    const harness = await createHarness({
      context: {
        displayMode: "inline",
        containerDimensions: { width: 420, height: 96 },
      },
    });
    const sizeChanges: { readonly width?: number; readonly height?: number }[] = [];
    harness.bridge.addEventListener("sizechange", (params) => {
      sizeChanges.push(params);
    });

    expect(harness.host.ports.presentation.getContext().containerDimensions).toEqual({
      width: 420,
      height: 96,
    });
    harness.host.ports.presentation.notifyIntrinsicHeight?.(63.2);
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(sizeChanges).toEqual([{ height: 68 }]);

    await harness.bridge.sendHostContextChange({ displayMode: "fullscreen" });
    harness.host.ports.presentation.notifyIntrinsicHeight?.(900);
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(sizeChanges).toEqual([{ height: 68 }]);

    await closeHarness(harness);
  });

  test("returns a private image chunk through an official component-originated tools/call", async () => {
    const requests: unknown[] = [];
    const harness = await createHarness({
      capabilities: { serverTools: {} },
      onCallTool(params) {
        requests.push(params);
        return Promise.resolve({
          content: [],
          structuredContent: imageChunkSummary,
          _meta: { imageChunk: privateImageChunk },
        });
      },
    });

    const chunk = await harness.host.ports.documents.loadAssetChunk({
      reviewSessionId: firstDocument.reviewSessionId,
      revision: firstDocument.revision,
      imageId: privateImageChunk.imageId,
      chunkIndex: 0,
    });

    expect(chunk).toEqual(privateImageChunk);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        name: "load_markdown_review_image_chunk",
        arguments: {
          reviewSessionId: firstDocument.reviewSessionId,
          revision: firstDocument.revision,
          imageId: privateImageChunk.imageId,
          chunkIndex: 0,
        },
      }),
    );
    expect(JSON.stringify(imageChunkSummary)).not.toContain(privateImageData);

    await closeHarness(harness);
  });

  test("preserves a component tool's server error reason", async () => {
    const harness = await createHarness({
      capabilities: { serverTools: {} },
      onCallTool() {
        return Promise.resolve({
          isError: true,
          content: [{ type: "text", text: "Fallback error text." }],
          _meta: {
            reviewError: {
              code: "session_expired",
              message: "Could not load image: review session expired.",
            },
          },
        });
      },
    });

    const error = await rejectionError(
      harness.host.ports.documents.loadAssetChunk({
        reviewSessionId: firstDocument.reviewSessionId,
        revision: firstDocument.revision,
        imageId: privateImageChunk.imageId,
        chunkIndex: 0,
      }),
    );
    expect(error).toBeInstanceOf(ReviewPortError);
    if (!(error instanceof ReviewPortError)) throw error;
    expect(error.code).toBe("server_error");
    expect(error.serverCode).toBe("session_expired");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("review session expired");

    await closeHarness(harness);
  });

  test("keeps a generic image load failure retryable", async () => {
    const harness = await createHarness({
      capabilities: { serverTools: {} },
      onCallTool() {
        return Promise.resolve({
          isError: true,
          content: [{ type: "text", text: "The Markdown review image could not be loaded." }],
          _meta: {
            reviewError: {
              code: "image_load_failed",
              message: "The Markdown review image could not be loaded.",
            },
          },
        });
      },
    });

    const error = await rejectionError(
      harness.host.ports.documents.loadAssetChunk({
        reviewSessionId: firstDocument.reviewSessionId,
        revision: firstDocument.revision,
        imageId: privateImageChunk.imageId,
        chunkIndex: 0,
      }),
    );
    expect(error).toBeInstanceOf(ReviewPortError);
    if (!(error instanceof ReviewPortError)) throw error;
    expect(error.serverCode).toBe("image_load_failed");
    expect(error.retryable).toBe(true);

    await closeHarness(harness);
  });

  test("classifies missing private image metadata", async () => {
    const harness = await createHarness({
      capabilities: { serverTools: {} },
      onCallTool() {
        return Promise.resolve({ content: [], structuredContent: imageChunkSummary });
      },
    });

    const error = await rejectionError(
      harness.host.ports.documents.loadAssetChunk({
        reviewSessionId: firstDocument.reviewSessionId,
        revision: firstDocument.revision,
        imageId: privateImageChunk.imageId,
        chunkIndex: 0,
      }),
    );
    expect(error).toBeInstanceOf(ReviewPortError);
    if (!(error instanceof ReviewPortError)) throw error;
    expect(error.code).toBe("private_metadata_missing");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("The image chunk response did not include private metadata.");

    await closeHarness(harness);
  });

  test("classifies invalid private image metadata", async () => {
    const harness = await createHarness({
      capabilities: { serverTools: {} },
      onCallTool() {
        return Promise.resolve({
          content: [],
          structuredContent: imageChunkSummary,
          _meta: { imageChunk: { ...privateImageChunk, data: "not-base64" } },
        });
      },
    });

    const error = await rejectionError(
      harness.host.ports.documents.loadAssetChunk({
        reviewSessionId: firstDocument.reviewSessionId,
        revision: firstDocument.revision,
        imageId: privateImageChunk.imageId,
        chunkIndex: 0,
      }),
    );
    expect(error).toBeInstanceOf(ReviewPortError);
    if (!(error instanceof ReviewPortError)) throw error;
    expect(error.code).toBe("private_metadata_invalid");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("The image chunk response contained invalid private metadata.");

    await closeHarness(harness);
  });
});
