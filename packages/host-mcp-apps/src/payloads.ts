import { FlowZoneUiEnvelopeBaseSchema, type FlowZoneUiEnvelopeBase } from "@flowzone/contracts";
import {
  PrivateReviewImageChunkSchema,
  ReviewDocumentSchema,
  ReviewDocumentSummarySchema,
  ReviewDocumentUpdateStatusSchema,
  ReviewImageChunkSummarySchema,
  type PrivateReviewImageChunk,
  type ReviewDocument,
  type ReviewDocumentUpdateStatus,
} from "@markdown-review/contracts";
import type { ReviewPortErrorCode, ReviewServerErrorCode } from "@markdown-review/review-ui";

const MAX_TOOL_ERROR_MESSAGE_LENGTH = 320;
const MAX_TOOL_ERROR_INPUT_LENGTH = 2_048;
const FALLBACK_TOOL_ERROR_MESSAGE = "The component tool reported an error.";

export interface ToolPayloadSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface ToolPayloadFailure {
  readonly success: false;
  readonly code: ReviewPortErrorCode;
  readonly message: string;
  readonly serverCode?: ReviewServerErrorCode;
}

export type ToolPayloadResult<T> = ToolPayloadSuccess<T> | ToolPayloadFailure;

export function findFlowZoneUiEnvelope(value: unknown): FlowZoneUiEnvelopeBase | null {
  const direct = FlowZoneUiEnvelopeBaseSchema.safeParse(value);
  if (direct.success) return direct.data;
  const record = asRecord(value);
  const meta = asRecord(record?.["_meta"]);
  const parsed = FlowZoneUiEnvelopeBaseSchema.safeParse(meta?.["flowzone"]);
  return parsed.success ? parsed.data : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function sanitizeToolErrorText(value: string): string {
  const sanitized = value
    .slice(0, MAX_TOOL_ERROR_INPUT_LENGTH)
    .normalize("NFKC")
    .replace(/\p{Cc}+/gu, " ")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      "[redacted]",
    )
    .replace(/\b[0-9a-f]{32,}\b/giu, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{64,}={0,2}\b/gu, "[redacted]")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/gu, "[redacted path]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!sanitized) return FALLBACK_TOOL_ERROR_MESSAGE;
  if (sanitized.length <= MAX_TOOL_ERROR_MESSAGE_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_TOOL_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function privateToolErrorMessage(record: Readonly<Record<string, unknown>>): string | null {
  const meta = asRecord(record["_meta"]);
  const reviewError = asRecord(meta?.["reviewError"]);
  return typeof reviewError?.["message"] === "string"
    ? sanitizeToolErrorText(reviewError["message"])
    : null;
}

function privateToolErrorCode(
  record: Readonly<Record<string, unknown>>,
): ReviewServerErrorCode | undefined {
  const meta = asRecord(record["_meta"]);
  const reviewError = asRecord(meta?.["reviewError"]);
  const code = reviewError?.["code"];
  return code === "session_expired" ||
    code === "stale_revision" ||
    code === "image_not_found" ||
    code === "chunk_out_of_range" ||
    code === "image_load_failed"
    ? code
    : undefined;
}

function contentToolErrorMessage(record: Readonly<Record<string, unknown>>): string | null {
  const content = record["content"];
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    const block = asRecord(item);
    if (block?.["type"] === "text" && typeof block["text"] === "string") {
      return sanitizeToolErrorText(block["text"]);
    }
  }
  return null;
}

function parseCallToolResult(
  value: unknown,
):
  | { readonly success: true; readonly result: Readonly<Record<string, unknown>> }
  | ToolPayloadFailure {
  const result = asRecord(value);
  if (!result || !Array.isArray(result["content"])) {
    return {
      success: false,
      code: "host_contract_mismatch",
      message: "The host returned an invalid component tool response.",
    };
  }
  if (result["isError"] !== undefined && typeof result["isError"] !== "boolean") {
    return {
      success: false,
      code: "host_contract_mismatch",
      message: "The host returned an invalid component tool response.",
    };
  }
  if (result["isError"] === true) {
    const serverCode = privateToolErrorCode(result);
    return {
      success: false,
      code: "server_error",
      message:
        privateToolErrorMessage(result) ??
        contentToolErrorMessage(result) ??
        FALLBACK_TOOL_ERROR_MESSAGE,
      ...(serverCode ? { serverCode } : {}),
    };
  }
  return { success: true, result };
}

function summariesMatch(
  summary: Readonly<Record<string, unknown>>,
  chunk: PrivateReviewImageChunk,
): boolean {
  const expected = ReviewImageChunkSummarySchema.parse({
    kind: chunk.kind,
    reviewSessionId: chunk.reviewSessionId,
    revision: chunk.revision,
    imageId: chunk.imageId,
    imageRevision: chunk.imageRevision,
    mimeType: chunk.mimeType,
    chunkIndex: chunk.chunkIndex,
    chunkCount: chunk.chunkCount,
    byteOffset: chunk.byteOffset,
    byteLength: chunk.byteLength,
  });
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (summary[key] !== expectedValue) return false;
  }
  return Object.keys(summary).length === Object.keys(expected).length;
}

function documentSummariesMatch(
  summary: Readonly<Record<string, unknown>>,
  document: ReviewDocument,
): boolean {
  const expected = ReviewDocumentSummarySchema.parse({
    path: document.path,
    revision: document.revision,
    filename: document.filename,
    title: document.title,
    modifiedAt: document.modifiedAt,
    sizeBytes: document.sizeBytes,
    lineCount: document.lineCount,
    blockCount: document.blockCount,
  });
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (summary[key] !== expectedValue) return false;
  }
  return Object.keys(summary).length === Object.keys(expected).length;
}

export function parseReviewDocumentToolResult(value: unknown): ToolPayloadResult<ReviewDocument> {
  const parsedResult = parseCallToolResult(value);
  if (!parsedResult.success) return parsedResult;
  const meta = asRecord(parsedResult.result["_meta"]);
  if (!meta || !("document" in meta)) {
    return {
      success: false,
      code: "private_metadata_missing",
      message: "The document response did not include private metadata.",
    };
  }
  const parsedDocument = ReviewDocumentSchema.safeParse(meta["document"]);
  if (!parsedDocument.success) {
    return {
      success: false,
      code: "private_metadata_invalid",
      message: "The document response contained invalid private metadata.",
    };
  }
  const parsedSummary = ReviewDocumentSummarySchema.safeParse(
    parsedResult.result["structuredContent"],
  );
  if (!parsedSummary.success || !documentSummariesMatch(parsedSummary.data, parsedDocument.data)) {
    return {
      success: false,
      code: "summary_mismatch",
      message: "The public document summary did not match the private metadata.",
    };
  }
  return { success: true, data: parsedDocument.data };
}

export function parseReviewDocumentUpdateToolResult(
  value: unknown,
): ToolPayloadResult<ReviewDocumentUpdateStatus> {
  const parsedResult = parseCallToolResult(value);
  if (!parsedResult.success) return parsedResult;
  const parsedStatus = ReviewDocumentUpdateStatusSchema.safeParse(
    parsedResult.result["structuredContent"],
  );
  if (!parsedStatus.success) {
    return {
      success: false,
      code: "host_contract_mismatch",
      message: "The document update response was invalid.",
    };
  }
  return { success: true, data: parsedStatus.data };
}

export function parsePrivateImageChunkToolResult(
  value: unknown,
): ToolPayloadResult<PrivateReviewImageChunk> {
  const parsedResult = parseCallToolResult(value);
  if (!parsedResult.success) return parsedResult;
  const meta = asRecord(parsedResult.result["_meta"]);
  if (!meta || !("imageChunk" in meta)) {
    return {
      success: false,
      code: "private_metadata_missing",
      message: "The image chunk response did not include private metadata.",
    };
  }
  const parsedChunk = PrivateReviewImageChunkSchema.safeParse(meta["imageChunk"]);
  if (!parsedChunk.success) {
    return {
      success: false,
      code: "private_metadata_invalid",
      message: "The image chunk response contained invalid private metadata.",
    };
  }
  const parsedSummary = ReviewImageChunkSummarySchema.safeParse(
    parsedResult.result["structuredContent"],
  );
  if (!parsedSummary.success || !summariesMatch(parsedSummary.data, parsedChunk.data)) {
    return {
      success: false,
      code: "summary_mismatch",
      message: "The public image chunk summary did not match the private metadata.",
    };
  }
  return { success: true, data: parsedChunk.data };
}

export function findReviewDocument(value: unknown): ReviewDocument | null {
  const envelope = findFlowZoneUiEnvelope(value);
  if (
    envelope?.plugin === "markdown-review" &&
    envelope.action === "open" &&
    envelope.view === "review"
  ) {
    const document = ReviewDocumentSchema.safeParse(envelope.payload);
    if (document.success) return document.data;
  }
  const direct = ReviewDocumentSchema.safeParse(value);
  if (direct.success) return direct.data;
  const record = asRecord(value);
  const meta = asRecord(record?.["_meta"]);
  const privateDocument = ReviewDocumentSchema.safeParse(meta?.["document"]);
  if (privateDocument.success) return privateDocument.data;
  const parsed = parseReviewDocumentToolResult(value);
  return parsed.success ? parsed.data : null;
}

export function findPrivateImageChunk(value: unknown): PrivateReviewImageChunk | null {
  const parsed = parsePrivateImageChunkToolResult(value);
  return parsed.success ? parsed.data : null;
}
