import {
  ErrorReviewDocumentSchema,
  ReviewDocumentRecoveryRequestSchema,
  ReviewDocumentSummarySchema,
  ReviewImageChunkRequestSchema,
  ReviewImageChunkSummarySchema,
} from "@markdown-review/contracts";
import {
  MarkdownReviewService,
  type LoadedAssetChunk,
  type OpenedMarkdownReview,
} from "@markdown-review/markdown-node";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ReviewUiAssetLoader } from "./assets.js";

export const MARKDOWN_REVIEW_TEMPLATE_URI = "ui://markdown-review/v26.html";
const REVIEW_BUNDLE_MARKER = "<!-- MARKDOWN_REVIEW_APP -->";

const SERVER_INSTRUCTIONS =
  "Use open_markdown_review only to render an absolute .md or .markdown path. The Markdown file is canonical. Review comments have stable #N serials within one queued review round and may reference earlier queued comments by serial; treat #N as a reference only when the feedback payload explicitly lists it as one, because literal #N text is supported. The component submits the full queue as one batch, clears it after a successful submission, and restarts numbering at #1. Discuss question-only items without editing, apply explicit change requests with normal filesystem tools, then reopen the review after any edits.";

export interface MarkdownReviewBackend {
  open(path: string): Promise<OpenedMarkdownReview>;
  loadDocument(reviewSessionId: string): Promise<OpenedMarkdownReview>;
  recoverDocument?(
    request: z.infer<typeof ReviewDocumentRecoveryRequestSchema>,
  ): Promise<OpenedMarkdownReview>;
  loadAssetChunk(request: z.infer<typeof ReviewImageChunkRequestSchema>): LoadedAssetChunk;
}

export interface CreateMarkdownReviewServerOptions {
  readonly assetLoader: ReviewUiAssetLoader;
  readonly backend?: MarkdownReviewBackend;
  readonly version?: string;
  readonly allowNativeDevTools?: boolean;
}

export function developerModeEnabled(value: string | undefined): boolean {
  return value === "1";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ImageLoadErrorCode =
  | "session_expired"
  | "stale_revision"
  | "image_not_found"
  | "chunk_out_of_range"
  | "image_load_failed";

interface ImageLoadError {
  readonly code: ImageLoadErrorCode;
  readonly message: string;
}

function classifyImageLoadError(error: unknown): ImageLoadError {
  const message = errorMessage(error);
  if (message === "The Markdown review session is unavailable or expired; reopen the review.") {
    return { code: "session_expired", message };
  }
  if (message === "The Markdown changed; refresh the review before loading its images.") {
    return { code: "stale_revision", message };
  }
  if (message === "The requested image is not part of this Markdown review session.") {
    return { code: "image_not_found", message };
  }
  if (message === "The requested image chunk is out of range.") {
    return { code: "chunk_out_of_range", message };
  }
  return {
    code: "image_load_failed",
    message: "The Markdown review image could not be loaded.",
  };
}

function safeDocumentLoadError(error: unknown): string {
  const message = errorMessage(error);
  return message === "The Markdown review session is unavailable or expired; reopen the review."
    ? message
    : "The Markdown review document could not be loaded.";
}

export function createMarkdownReviewServer(options: CreateMarkdownReviewServerOptions): McpServer {
  const backend = options.backend ?? new MarkdownReviewService();
  const server = new McpServer(
    { name: "markdown-review", version: options.version ?? "0.1.0" },
    { capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  registerAppResource(
    server,
    "markdown-review-ui",
    MARKDOWN_REVIEW_TEMPLATE_URI,
    {
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { connectDomains: [], resourceDomains: [] },
          permissions: { clipboardWrite: {} },
        },
      },
    },
    async () => {
      const { template, reviewBundle } = await options.assetLoader.load();
      if (!template.includes(REVIEW_BUNDLE_MARKER)) {
        throw new Error("The Markdown Review template is missing its application bundle marker.");
      }
      const html = template.replace(
        REVIEW_BUNDLE_MARKER,
        () => `<script>${reviewBundle.replaceAll("</script", "<\\/script")}</script>`,
      );
      const configuredHtml = options.allowNativeDevTools
        ? html.replace("<html", '<html data-markdown-review-developer-mode="true"')
        : html;
      return {
        contents: [
          {
            uri: MARKDOWN_REVIEW_TEMPLATE_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: configuredHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                csp: { connectDomains: [], resourceDomains: [] },
                permissions: { clipboardWrite: {} },
              },
              "openai/widgetDescription":
                "Fullscreen rendered Markdown review with copy and queued passage, image, and whole-document feedback for the underlying source file.",
              "openai/widgetPrefersBorder": true,
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "open_markdown_review",
    {
      title: "Open Markdown review",
      description:
        "Render a local Markdown file in an interactive review UI. Pass the absolute .md or .markdown path. The tool is read-only; the active coding agent edits the source file with its normal filesystem tools after the user submits feedback.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Absolute path to a .md or .markdown file"),
      },
      outputSchema: ReviewDocumentSummarySchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: {
        ui: { resourceUri: MARKDOWN_REVIEW_TEMPLATE_URI, visibility: ["model"] },
        "openai/outputTemplate": MARKDOWN_REVIEW_TEMPLATE_URI,
        "openai/widgetAccessible": false,
        "openai/toolInvocation/invoking": "Opening Markdown…",
        "openai/toolInvocation/invoked": "Markdown ready",
      },
    },
    async ({ path }) => {
      try {
        const opened = await backend.open(path);
        return {
          structuredContent: opened.summary,
          content: [
            {
              type: "text" as const,
              text: `Opened ${opened.document.filename} for review (${opened.document.lineCount} lines, revision ${opened.document.revision}). The full rendered document is available only to the review component.`,
            },
          ],
          _meta: { document: opened.document },
        };
      } catch (error: unknown) {
        const message = errorMessage(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Could not open Markdown review: ${message}` }],
          _meta: {
            document: ErrorReviewDocumentSchema.parse({
              kind: "markdown-review-document",
              path,
              error: message,
            }),
          },
        };
      }
    },
  );

  registerAppTool(
    server,
    "load_markdown_review_document",
    {
      title: "Load Markdown review document",
      description:
        "Load the rendered Markdown document for an active review session. This read-only tool is available only to the component UI.",
      inputSchema: {
        reviewSessionId: z.uuid().describe("Opaque identifier returned to the review component"),
      },
      outputSchema: ReviewDocumentSummarySchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
      },
    },
    async ({ reviewSessionId }) => {
      try {
        const loaded = await backend.loadDocument(reviewSessionId);
        return {
          structuredContent: loaded.summary,
          content: [],
          _meta: { document: loaded.document },
        };
      } catch (error: unknown) {
        const message = safeDocumentLoadError(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
          _meta: {
            document: ErrorReviewDocumentSchema.parse({
              kind: "markdown-review-document",
              reviewSessionId,
              error: message,
            }),
          },
        };
      }
    },
  );

  registerAppTool(
    server,
    "recover_markdown_review_document",
    {
      title: "Recover Markdown review document",
      description:
        "Create a fresh rendered snapshot for the same Markdown path after an active component review session expires or is lost during host reconnection.",
      inputSchema: ReviewDocumentRecoveryRequestSchema.shape,
      outputSchema: ReviewDocumentSummarySchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
      },
    },
    async (request) => {
      try {
        if (!backend.recoverDocument) {
          throw new Error("Document recovery is unavailable for this Markdown review host.");
        }
        const recovered = await backend.recoverDocument(request);
        if (
          recovered.document.path !== request.path ||
          recovered.document.reviewSessionId === request.reviewSessionId
        ) {
          throw new Error("The Markdown review host returned an invalid recovery snapshot.");
        }
        return {
          structuredContent: recovered.summary,
          content: [],
          _meta: { document: recovered.document },
        };
      } catch (error: unknown) {
        const message = safeDocumentLoadError(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: message }],
          _meta: {
            document: ErrorReviewDocumentSchema.parse({
              kind: "markdown-review-document",
              path: request.path,
              reviewSessionId: request.reviewSessionId,
              error: message,
            }),
          },
        };
      }
    },
  );

  registerAppTool(
    server,
    "load_markdown_review_image_chunk",
    {
      title: "Load Markdown review image chunk",
      description:
        "Load one bounded immutable binary chunk for an image captured by the active Markdown review session. This read-only transport tool is available only to the component UI.",
      inputSchema: ReviewImageChunkRequestSchema.shape,
      outputSchema: ReviewImageChunkSummarySchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: {
        ui: { visibility: ["app"] },
        "openai/visibility": "private",
        "openai/widgetAccessible": true,
      },
    },
    (request) => {
      try {
        const chunk = backend.loadAssetChunk(request);
        return {
          structuredContent: chunk.summary,
          content: [],
          _meta: { imageChunk: chunk.privateChunk },
        };
      } catch (error: unknown) {
        const reviewError = classifyImageLoadError(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: reviewError.message }],
          _meta: { reviewError },
        };
      }
    },
  );

  return server;
}
