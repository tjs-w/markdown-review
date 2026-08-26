import { createHash } from "node:crypto";
import { basename } from "node:path";

import {
  PrivateReviewImageChunkSchema,
  ReviewDocumentSchema,
  ReviewDocumentSummarySchema,
  ReviewDocumentUpdateStatusSchema,
  ReviewImageChunkSummarySchema,
  type PrivateReviewImageChunk,
  type ReviewDocument,
  type ReviewDocumentRecoveryRequest,
  type ReviewDocumentSummary,
  type ReviewDocumentUpdateStatus,
  type ReviewImageChunkRequest,
  type ReviewImageChunkSummary,
} from "@markdown-review/contracts";

import { readFileHandleBounded } from "./bounded-read.js";
import { IMAGE_CHUNK_BYTES, MAX_MARKDOWN_BYTES } from "./constants.js";
import { DefaultMarkdownPathPolicy, type MarkdownPathPolicy } from "./path-policy.js";
import { renderMarkdown } from "./render.js";
import { ReviewSessionStore } from "./session-store.js";

export interface OpenedMarkdownReview {
  readonly summary: ReviewDocumentSummary;
  readonly document: ReviewDocument;
}

export interface LoadedAssetChunk {
  readonly summary: ReviewImageChunkSummary;
  readonly privateChunk: PrivateReviewImageChunk;
}

interface MarkdownSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly markdown: string;
  readonly revision: string;
  readonly modifiedAt: string;
  readonly sizeBytes: number;
}

export interface MarkdownReviewServiceOptions {
  readonly pathPolicy?: MarkdownPathPolicy;
  readonly sessions?: ReviewSessionStore;
}

function summarize(document: ReviewDocument): ReviewDocumentSummary {
  return ReviewDocumentSummarySchema.parse({
    path: document.path,
    filename: document.filename,
    title: document.title,
    revision: document.revision,
    modifiedAt: document.modifiedAt,
    sizeBytes: document.sizeBytes,
    lineCount: document.lineCount,
    blockCount: document.blockCount,
  });
}

async function readMarkdownSnapshot(
  pathPolicy: MarkdownPathPolicy,
  pathInput: string,
): Promise<MarkdownSnapshot> {
  const path = await pathPolicy.resolveMarkdownPath(pathInput);
  const snapshot = await readFileHandleBounded(path, MAX_MARKDOWN_BYTES, "The Markdown file", {
    expectedCanonicalPath: path,
  });
  return {
    path,
    bytes: snapshot.bytes,
    markdown: snapshot.bytes.toString("utf8"),
    revision: createHash("sha256").update(snapshot.bytes).digest("hex").slice(0, 16),
    modifiedAt: snapshot.modifiedAt,
    sizeBytes: snapshot.sizeBytes,
  };
}

export class MarkdownReviewService {
  readonly #pathPolicy: MarkdownPathPolicy;
  readonly #sessions: ReviewSessionStore;

  constructor(options: MarkdownReviewServiceOptions = {}) {
    this.#pathPolicy = options.pathPolicy ?? new DefaultMarkdownPathPolicy();
    this.#sessions = options.sessions ?? new ReviewSessionStore();
  }

  async open(pathInput: string): Promise<OpenedMarkdownReview> {
    const snapshot = await readMarkdownSnapshot(this.#pathPolicy, pathInput);
    const rendered = await renderMarkdown(snapshot.markdown, snapshot.path, this.#pathPolicy);
    const filename = basename(snapshot.path);
    const documentWithoutSession: Omit<ReviewDocument, "reviewSessionId"> = {
      kind: "markdown-review-document",
      path: snapshot.path,
      filename,
      title: rendered.title ?? filename,
      revision: snapshot.revision,
      modifiedAt: snapshot.modifiedAt,
      sizeBytes: snapshot.sizeBytes,
      lineCount: snapshot.markdown.length === 0 ? 0 : snapshot.markdown.split(/\r?\n/).length,
      blockCount: rendered.blockCount,
      html: rendered.html,
      images: rendered.images.map((image) => image.descriptor),
    };
    const session = this.#sessions.create(documentWithoutSession, rendered.images);
    const document = ReviewDocumentSchema.parse(session.document);
    return { document, summary: summarize(document) };
  }

  async loadDocument(reviewSessionId: string): Promise<OpenedMarkdownReview> {
    const session = this.#sessions.get(reviewSessionId);
    return this.open(session.document.path);
  }

  async checkDocument(request: ReviewDocumentRecoveryRequest): Promise<ReviewDocumentUpdateStatus> {
    const session = this.#sessions.get(request.reviewSessionId);
    if (session.document.path !== request.path || session.document.revision !== request.revision) {
      throw new Error("The Markdown review update reference did not match the session.");
    }
    const snapshot = await readMarkdownSnapshot(this.#pathPolicy, session.document.path);
    return ReviewDocumentUpdateStatusSchema.parse({
      kind: "markdown-review-update-status",
      reviewSessionId: session.id,
      path: session.document.path,
      revision: snapshot.revision,
      changed: snapshot.revision !== session.document.revision,
    });
  }

  async recoverDocument(request: ReviewDocumentRecoveryRequest): Promise<OpenedMarkdownReview> {
    try {
      const session = this.#sessions.get(request.reviewSessionId);
      if (
        session.document.path !== request.path ||
        session.document.revision !== request.revision
      ) {
        throw new Error("The Markdown review recovery reference did not match the session.");
      }
      return await this.open(session.document.path);
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        error.message !==
          "The Markdown review session is unavailable or expired; reopen the review."
      ) {
        throw error;
      }
      return this.open(request.path);
    }
  }

  loadAssetChunk(request: ReviewImageChunkRequest): LoadedAssetChunk {
    const session = this.#sessions.get(request.reviewSessionId);
    if (request.revision !== session.document.revision) {
      throw new Error("The Markdown changed; refresh the review before loading its images.");
    }
    const image = session.images.get(request.imageId);
    if (!image) throw new Error("The requested image is not part of this Markdown review session.");
    if (request.chunkIndex < 0 || request.chunkIndex >= image.descriptor.chunkCount) {
      throw new Error("The requested image chunk is out of range.");
    }

    const byteOffset = request.chunkIndex * IMAGE_CHUNK_BYTES;
    const bytes = image.bytes.subarray(
      byteOffset,
      Math.min(byteOffset + IMAGE_CHUNK_BYTES, image.bytes.byteLength),
    );
    const summary = ReviewImageChunkSummarySchema.parse({
      kind: "markdown-review-image-chunk",
      reviewSessionId: session.id,
      revision: session.document.revision,
      imageId: image.descriptor.id,
      imageRevision: image.sha256,
      mimeType: image.descriptor.mimeType,
      chunkIndex: request.chunkIndex,
      chunkCount: image.descriptor.chunkCount,
      byteOffset,
      byteLength: bytes.byteLength,
    });
    const privateChunk = PrivateReviewImageChunkSchema.parse({
      ...summary,
      data: bytes.toString("base64"),
    });
    return { summary, privateChunk };
  }
}
