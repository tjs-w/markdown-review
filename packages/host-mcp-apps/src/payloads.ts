import {
  PrivateReviewImageChunkSchema,
  ReviewDocumentSchema,
  type PrivateReviewImageChunk,
  type ReviewDocument,
} from "@markdown-review/contracts";
import type { z } from "zod";

const NESTED_RESULT_KEYS = [
  "structuredContent",
  "_meta",
  "meta",
  "mcp_tool_result",
  "call_tool_result",
  "toolResponseMetadata",
  "result",
  "params",
  "document",
  "imageChunk",
] as const;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function findParsed<T>(
  value: unknown,
  schema: z.ZodType<T>,
  depth = 0,
  seen = new Set<object>(),
): T | null {
  if (depth > 8) return null;
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;
  const record = asRecord(value);
  if (!record || seen.has(record)) return null;
  seen.add(record);
  for (const key of NESTED_RESULT_KEYS) {
    const found = findParsed(record[key], schema, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

export function findReviewDocument(value: unknown): ReviewDocument | null {
  return findParsed(value, ReviewDocumentSchema);
}

export function findPrivateImageChunk(value: unknown): PrivateReviewImageChunk | null {
  return findParsed(value, PrivateReviewImageChunkSchema);
}
