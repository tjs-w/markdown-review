import {
  ErrorReviewDocumentSchema,
  ReviewDocumentRecoveryRequestSchema,
  ReviewDocumentSchema,
  ReviewDocumentSummarySchema,
  ReviewDocumentUpdateStatusSchema,
  ReviewImageChunkRequestSchema,
  ReviewImageChunkSummarySchema,
  type ReviewDocumentUpdateStatus,
} from "@markdown-review/contracts";
import {
  MarkdownReviewService,
  type LoadedAssetChunk,
  type OpenedMarkdownReview,
} from "@markdown-review/markdown-node";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { adaptReviewUiAssetLoader, type ReviewUiAssetLoader } from "../assets.js";
import { FlowZoneExecutionError } from "../errors.js";
import type { FlowZoneAppTool, FlowZonePlugin } from "../plugin.js";
import { createFlowZoneServer } from "../server.js";
import { FLOWZONE_TEMPLATE_URI } from "../ui-resource.js";

export const MARKDOWN_REVIEW_PLUGIN_ID = "markdown-review";
/** @deprecated FlowZone now owns the universal UI resource URI. */
export const MARKDOWN_REVIEW_TEMPLATE_URI = FLOWZONE_TEMPLATE_URI;

const OpenMarkdownReviewInputSchema = z
  .object({
    path: z.string().min(1).max(4096).describe("Absolute path to a .md or .markdown file"),
  })
  .strict();

const LoadMarkdownReviewDocumentInputSchema = z
  .object({
    reviewSessionId: z.uuid().describe("Opaque identifier returned to the review component"),
  })
  .strict();

const READ_ONLY_IDEMPOTENT = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

export interface MarkdownReviewBackend {
  open(path: string): Promise<OpenedMarkdownReview>;
  loadDocument(reviewSessionId: string): Promise<OpenedMarkdownReview>;
  checkDocument?(
    request: z.infer<typeof ReviewDocumentRecoveryRequestSchema>,
  ): Promise<ReviewDocumentUpdateStatus>;
  recoverDocument?(
    request: z.infer<typeof ReviewDocumentRecoveryRequestSchema>,
  ): Promise<OpenedMarkdownReview>;
  loadAssetChunk(request: z.infer<typeof ReviewImageChunkRequestSchema>): LoadedAssetChunk;
}

export interface MarkdownReviewPluginOptions {
  readonly backend?: MarkdownReviewBackend;
}

export interface CreateMarkdownReviewServerOptions extends MarkdownReviewPluginOptions {
  readonly assetLoader: ReviewUiAssetLoader;
  readonly allowNativeDevTools?: boolean;
  readonly version?: string;
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

function documentLoadErrorMetadata(
  error: unknown,
):
  | { readonly reviewError: { readonly code: "session_expired"; readonly message: string } }
  | undefined {
  const message = errorMessage(error);
  return message === "The Markdown review session is unavailable or expired; reopen the review."
    ? { reviewError: { code: "session_expired", message } }
    : undefined;
}

function createAppTools(backend: MarkdownReviewBackend): readonly FlowZoneAppTool[] {
  return [
    {
      name: "check_markdown_review_document",
      title: "Check Markdown review document",
      description:
        "Check whether the canonical Markdown source changed for an active review session without creating a new rendered snapshot.",
      inputSchema: ReviewDocumentRecoveryRequestSchema,
      outputSchema: ReviewDocumentUpdateStatusSchema,
      annotations: READ_ONLY_IDEMPOTENT,
      async handler(input) {
        const request = ReviewDocumentRecoveryRequestSchema.parse(input);
        try {
          if (!backend.checkDocument) {
            throw new Error("Document update checks are unavailable for this host.");
          }
          const status = await backend.checkDocument(request);
          if (
            status.reviewSessionId !== request.reviewSessionId ||
            status.path !== request.path ||
            status.changed !== (status.revision !== request.revision)
          ) {
            throw new Error("The Markdown review host returned an invalid update status.");
          }
          return { structuredContent: status, content: [] };
        } catch (error: unknown) {
          const message = safeDocumentLoadError(error);
          return {
            isError: true,
            content: [{ type: "text" as const, text: message }],
            _meta: documentLoadErrorMetadata(error),
          };
        }
      },
    },
    {
      name: "load_markdown_review_document",
      title: "Load Markdown review document",
      description: "Load the rendered Markdown document for an active review session.",
      inputSchema: LoadMarkdownReviewDocumentInputSchema,
      outputSchema: ReviewDocumentSummarySchema,
      annotations: READ_ONLY_IDEMPOTENT,
      async handler(input) {
        const { reviewSessionId } = LoadMarkdownReviewDocumentInputSchema.parse(input);
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
              ...(documentLoadErrorMetadata(error) ?? {}),
            },
          };
        }
      },
    },
    {
      name: "recover_markdown_review_document",
      title: "Recover Markdown review document",
      description:
        "Create a fresh rendered snapshot for the same Markdown path after an active component session expires.",
      inputSchema: ReviewDocumentRecoveryRequestSchema,
      outputSchema: ReviewDocumentSummarySchema,
      annotations: { ...READ_ONLY_IDEMPOTENT, idempotentHint: false },
      async handler(input) {
        const request = ReviewDocumentRecoveryRequestSchema.parse(input);
        try {
          if (!backend.recoverDocument) {
            throw new Error("Document recovery is unavailable for this host.");
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
    },
    {
      name: "load_markdown_review_image_chunk",
      title: "Load Markdown review image chunk",
      description:
        "Load one bounded immutable binary chunk for an image captured by the active Markdown review session.",
      inputSchema: ReviewImageChunkRequestSchema,
      outputSchema: ReviewImageChunkSummarySchema,
      annotations: READ_ONLY_IDEMPOTENT,
      handler(input) {
        const request = ReviewImageChunkRequestSchema.parse(input);
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
    },
  ];
}

export function createMarkdownReviewPlugin(
  options: MarkdownReviewPluginOptions = {},
): FlowZonePlugin {
  const backend = options.backend ?? new MarkdownReviewService();
  return {
    id: MARKDOWN_REVIEW_PLUGIN_ID,
    displayName: "Markdown Review",
    version: "0.1.0",
    actions: [
      {
        id: "open",
        title: "Open Markdown review",
        description:
          "Render an absolute local .md or .markdown path in the interactive Markdown Review view.",
        inputSchema: OpenMarkdownReviewInputSchema,
        outputSchema: ReviewDocumentSummarySchema,
        risk: {
          readOnly: true,
          destructive: false,
          openWorld: false,
          idempotent: false,
        },
        ui: {
          view: "review",
          payloadSchema: ReviewDocumentSchema,
          legacyMetaKey: "document",
        },
        executor: {
          kind: "module",
          async execute(input) {
            const { path } = OpenMarkdownReviewInputSchema.parse(input);
            try {
              const opened = await backend.open(path);
              return { result: opened.summary, uiPayload: opened.document };
            } catch {
              throw new FlowZoneExecutionError(
                "internal_error",
                "The Markdown review could not be opened.",
              );
            }
          },
        },
        summarize(result) {
          const summary = ReviewDocumentSummarySchema.parse(result);
          return `Opened ${summary.filename} for review (${String(summary.lineCount)} lines, revision ${summary.revision}). The full rendered document is available only to the FlowZone UI.`;
        },
      },
    ],
    appTools: createAppTools(backend),
  };
}

/** Compatibility factory for hosts that only need the bundled Markdown Review plugin. */
export function createMarkdownReviewServer(options: CreateMarkdownReviewServerOptions): McpServer {
  return createFlowZoneServer({
    ...(options.version ? { version: options.version } : {}),
    assetLoader: adaptReviewUiAssetLoader(options.assetLoader),
    ...(options.allowNativeDevTools !== undefined
      ? { allowNativeDevTools: options.allowNativeDevTools }
      : {}),
    plugins: [createMarkdownReviewPlugin(options.backend ? { backend: options.backend } : {})],
  });
}
