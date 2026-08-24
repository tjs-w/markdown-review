import { describe, expect, test } from "bun:test";
import {
  AppBridge,
  type McpUiHostCapabilities,
  type McpUiHostContext,
  type McpUiMessageRequest,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ReviewDocumentSchema,
  ReviewDocumentSummarySchema,
  ReviewSubmissionSchema,
  type ReviewDocument,
} from "@markdown-review/contracts";

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

interface AppBridgeHarness {
  readonly bridge: AppBridge;
  readonly documents: ReviewDocument[];
  readonly errors: Error[];
  readonly host: McpAppsHost;
}

async function createHarness({
  capabilities = {},
  context = {},
  onTeardown,
}: {
  readonly capabilities?: McpUiHostCapabilities;
  readonly context?: McpUiHostContext;
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

  test("accepts only the first valid initial document despite duplicate and out-of-order events", async () => {
    const harness = await createHarness();

    await harness.bridge.sendToolResult({
      content: [],
      structuredContent: { document: { ...firstDocument, reviewSessionId: "forged" } },
    });
    await harness.bridge.sendToolResult({
      content: [],
      structuredContent: { document: laterDocument },
    });
    await harness.bridge.sendToolInput({ arguments: { document: firstDocument } });
    await harness.bridge.sendToolResult({
      content: [],
      structuredContent: { document: firstDocument },
    });

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
});
