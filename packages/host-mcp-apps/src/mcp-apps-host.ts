import {
  App,
  McpUiHostCapabilitiesSchema,
  McpUiHostContextSchema,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps";
import {
  PrivateReviewImageChunkSchema,
  ReviewDocumentSchema,
  ReviewImageChunkRequestSchema,
  ReviewSubmissionSchema,
  type ReviewDocument,
  type ReviewSubmission,
} from "@markdown-review/contracts";
import type {
  HostContext,
  HostContextListener,
  MarkdownReviewPorts,
} from "@markdown-review/review-ui";

import { findPrivateImageChunk, findReviewDocument } from "./payloads";
import { createReviewStateStore } from "./state-store";

export interface McpAppsHostOptions {
  readonly hostWindow?: Window;
  /**
   * Overrides the browser postMessage transport for protocol harnesses and
   * non-iframe embedders. Browser builds should leave this unset.
   */
  readonly transport?: Parameters<App["connect"]>[0];
  readonly onDocument: (document: ReviewDocument) => void | Promise<void>;
  readonly onError?: (error: Error) => void;
  readonly onTeardown?: () => void;
  readonly submissionFormatter?: (submission: ReviewSubmission) => string;
}

export interface McpAppsHost {
  readonly ports: MarkdownReviewPorts;
  connect(): Promise<void>;
  close(): Promise<void>;
}

function normalizeHostContext(value: unknown): HostContext {
  const result = McpUiHostContextSchema.safeParse(value);
  if (!result.success) return { displayMode: "inline", theme: "light" };
  const context = result.data;
  return {
    displayMode: context.displayMode ?? "inline",
    theme: context.theme ?? "light",
    ...(context.availableDisplayModes
      ? { availableDisplayModes: context.availableDisplayModes }
      : {}),
    ...(context.containerDimensions ? { containerDimensions: context.containerDimensions } : {}),
    ...(context.locale ? { locale: context.locale } : {}),
  };
}

function normalizeHostCapabilities(value: unknown): {
  readonly externalLinks: boolean;
  readonly messages: boolean;
  readonly serverTools: boolean;
} {
  const result = McpUiHostCapabilitiesSchema.safeParse(value);
  return {
    externalLinks: result.success && result.data.openLinks !== undefined,
    messages: result.success && result.data.message !== undefined,
    serverTools: result.success && result.data.serverTools !== undefined,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createMcpAppsHost(options: McpAppsHostOptions): McpAppsHost {
  const hostWindow = options.hostWindow ?? window;
  const app = new App(
    { name: "markdown-review", version: "0.1.0" },
    { availableDisplayModes: ["inline", "fullscreen"] },
    { strict: true, allowUnsafeEval: false, autoResize: false },
  );
  const contextListeners = new Set<HostContextListener>();
  let connected = false;
  let context: HostContext = { displayMode: "inline", theme: "light" };
  let externalLinks = false;
  let messages = false;
  let serverTools = false;
  let acceptedInitialSessionId: string | undefined;
  let pendingInitialSessionId: string | undefined;
  let pendingIntrinsicHeight: number | undefined;
  let intrinsicHeightQueued = false;
  let closing: Promise<void> | undefined;

  const reportError = (error: unknown): void => {
    options.onError?.(asError(error));
  };
  const acceptUnknownPayload = (value: unknown): boolean => {
    const reviewDocument = findReviewDocument(value);
    if (!reviewDocument) return false;
    if (acceptedInitialSessionId || pendingInitialSessionId) return true;
    pendingInitialSessionId = reviewDocument.reviewSessionId;
    void Promise.resolve(options.onDocument(reviewDocument))
      .then(() => {
        acceptedInitialSessionId = reviewDocument.reviewSessionId;
      })
      .catch(reportError)
      .finally(() => {
        pendingInitialSessionId = undefined;
      });
    return true;
  };
  const syncContext = (): void => {
    context = normalizeHostContext(app.getHostContext());
    const capabilities = normalizeHostCapabilities(app.getHostCapabilities());
    externalLinks = capabilities.externalLinks;
    messages = capabilities.messages;
    serverTools = capabilities.serverTools;
    for (const listener of contextListeners) listener(context);
  };
  const closeApp = (): Promise<void> => {
    if (!closing) {
      connected = false;
      closing = app.close().catch(reportError);
    }
    return closing;
  };

  app.addEventListener("toolinput", (params) => {
    acceptUnknownPayload(params);
  });
  app.addEventListener("toolresult", (params) => {
    if (!acceptUnknownPayload(params) && !acceptedInitialSessionId) {
      reportError(new Error("The Markdown Review host returned an invalid document payload"));
    }
  });
  app.addEventListener("hostcontextchanged", () => {
    syncContext();
  });
  app.onteardown = () => {
    connected = false;
    options.onTeardown?.();
    return {};
  };

  const presentationCapabilities = {
    get documentTools(): boolean {
      return serverTools;
    },
    get displayMode(): boolean {
      return context.availableDisplayModes?.includes("fullscreen") ?? false;
    },
    get externalLinks(): boolean {
      return externalLinks;
    },
    get intrinsicHeight(): boolean {
      return connected && context.displayMode === "inline";
    },
    get submission(): boolean {
      return messages;
    },
  };

  const ports: MarkdownReviewPorts = {
    documents: {
      async refresh(reviewSessionId) {
        if (!serverTools) throw new Error("This MCP Apps host does not allow component tools");
        const result = await app.callServerTool({
          name: "load_markdown_review_document",
          arguments: { reviewSessionId },
        });
        const reviewDocument = findReviewDocument(result);
        if (!reviewDocument)
          throw new Error("The document payload was not returned to the component");
        return ReviewDocumentSchema.parse(reviewDocument);
      },
      async loadAssetChunk(request) {
        if (!serverTools) throw new Error("This MCP Apps host does not allow component tools");
        const validatedRequest = ReviewImageChunkRequestSchema.parse(request);
        const result = await app.callServerTool({
          name: "load_markdown_review_image_chunk",
          arguments: validatedRequest,
        });
        const chunk = findPrivateImageChunk(result);
        if (!chunk) throw new Error("The image chunk payload was not returned to the component");
        return PrivateReviewImageChunkSchema.parse(chunk);
      },
    },
    submissions: {
      async submit(request) {
        const submission = ReviewSubmissionSchema.parse(request);
        if (!messages) throw new Error("This MCP Apps host does not accept review submissions");
        const text = options.submissionFormatter
          ? options.submissionFormatter(submission)
          : JSON.stringify(submission);
        const result = await app.sendMessage({
          role: "user",
          content: [{ type: "text", text }],
        });
        if (result.isError) throw new Error("The host rejected the review submission");
      },
    },
    presentation: {
      capabilities: presentationCapabilities,
      getContext() {
        return context;
      },
      subscribe(listener) {
        contextListeners.add(listener);
        return () => {
          contextListeners.delete(listener);
        };
      },
      async requestDisplayMode(mode) {
        if (!context.availableDisplayModes?.includes(mode)) {
          throw new Error(`The host does not support ${mode} display mode`);
        }
        const result = await app.requestDisplayMode({ mode });
        context = { ...context, displayMode: result.mode };
        return result.mode;
      },
      async openExternal(url) {
        if (!externalLinks) throw new Error("The host does not allow external links");
        const result = await app.openLink({ url: url.href });
        if (result.isError) throw new Error("The host could not open the link");
      },
      notifyIntrinsicHeight(height) {
        pendingIntrinsicHeight = Math.min(1_200, Math.max(68, Math.ceil(height)));
        if (intrinsicHeightQueued) return;
        intrinsicHeightQueued = true;
        queueMicrotask(() => {
          intrinsicHeightQueued = false;
          const nextHeight = pendingIntrinsicHeight;
          pendingIntrinsicHeight = undefined;
          if (!connected || context.displayMode !== "inline" || nextHeight === undefined) return;
          void app.sendSizeChanged({ height: nextHeight }).catch(reportError);
        });
      },
    },
    state: createReviewStateStore(hostWindow),
  };

  return {
    ports,
    async connect(): Promise<void> {
      if (connected) return;
      closing = undefined;
      await app.connect(
        options.transport ?? new PostMessageTransport(hostWindow.parent, hostWindow.parent),
      );
      connected = true;
      syncContext();
    },
    async close(): Promise<void> {
      await closeApp();
    },
  };
}
