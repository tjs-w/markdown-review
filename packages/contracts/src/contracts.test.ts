import { describe, expect, test } from "bun:test";

import {
  ErrorReviewDocumentSchema,
  IMAGE_CHUNK_BYTES,
  MAX_INLINE_IMAGES,
  PersistedReviewStateSchema,
  PrivateReviewImageChunkSchema,
  ReviewBatchV1Schema,
  ReviewDocumentSchema,
  ReviewDocumentRecoveryRequestSchema,
  ReviewImageDescriptorSchema,
  ReviewImageMimeTypeSchema,
  ReviewSelectionSchema,
  ReviewSubmissionSchema,
} from "./index";

describe("portable review contracts", () => {
  test("keeps reconnect recovery bound to a document identity and expired session reference", () => {
    const request = {
      reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
      path: "/tmp/review.md",
      revision: "r1",
    };
    expect(ReviewDocumentRecoveryRequestSchema.parse(request)).toEqual(request);
    expect(
      ReviewDocumentRecoveryRequestSchema.safeParse({ ...request, path: undefined }).success,
    ).toBe(false);
    expect(ReviewDocumentRecoveryRequestSchema.safeParse({ ...request, extra: true }).success).toBe(
      false,
    );
  });

  test("keeps the markdown-review/v1 batch wire shape exact", () => {
    const parsed = ReviewBatchV1Schema.parse({
      schema: "markdown-review/v1",
      file: "/tmp/review.md",
      revision: "document-revision",
      items: [
        {
          id: "#1",
          refs: [],
          lines: [2, 3],
          quote: "A selected passage",
          comment: "Make this more specific.",
        },
      ],
    });

    expect(parsed).toEqual({
      schema: "markdown-review/v1",
      file: "/tmp/review.md",
      revision: "document-revision",
      items: [
        {
          id: "#1",
          refs: [],
          lines: [2, 3],
          quote: "A selected passage",
          comment: "Make this more specific.",
        },
      ],
    });
    expect(
      ReviewBatchV1Schema.safeParse({ ...parsed, submissionId: "outside-the-batch" }).success,
    ).toBe(false);
  });

  test("wraps submission identity outside the stable batch", () => {
    const result = ReviewSubmissionSchema.safeParse({
      submissionId: "submission-1",
      itemIds: ["queue-item-1"],
      batch: {
        schema: "markdown-review/v1",
        file: "/tmp/review.md",
        revision: "r1",
        items: [{ id: "#1", refs: [], lines: [1, 1], quote: "q", comment: "c" }],
      },
    });

    expect(result.success).toBe(true);
  });

  test("separates private image bytes from public document descriptors", () => {
    const documentResult = ReviewDocumentSchema.safeParse({
      kind: "markdown-review-document",
      path: "/tmp/review.md",
      filename: "review.md",
      title: "Review",
      revision: "r1",
      modifiedAt: "2026-08-23T00:00:00.000Z",
      sizeBytes: 10,
      lineCount: 1,
      blockCount: 1,
      reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
      html: "<p>Review</p>",
      images: [
        {
          id: "image-1",
          mimeType: "image/png",
          revision: "i1",
          modifiedAt: "2026-08-23T00:00:00.000Z",
          byteLength: 4,
          chunkCount: 1,
          width: 1,
          height: 1,
          data: "AAAA",
        },
      ],
    });
    expect(documentResult.success).toBe(false);

    expect(
      PrivateReviewImageChunkSchema.safeParse({
        kind: "markdown-review-image-chunk",
        reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
        revision: "r1",
        imageId: "image-1",
        imageRevision: "i1",
        mimeType: "image/png",
        chunkIndex: 0,
        chunkCount: 1,
        byteOffset: 0,
        byteLength: 3,
        data: "AAAA",
      }).success,
    ).toBe(true);
  });

  test("allows only supported static raster MIME types across image contracts", () => {
    const descriptor = {
      id: "image-1",
      revision: "i1",
      modifiedAt: "2026-08-23T00:00:00.000Z",
      byteLength: 4,
      chunkCount: 1,
      width: 1,
      height: 1,
    };

    for (const mimeType of ["image/png", "image/jpeg", "image/webp"] as const) {
      expect(ReviewImageMimeTypeSchema.parse(mimeType)).toBe(mimeType);
      expect(ReviewImageDescriptorSchema.safeParse({ ...descriptor, mimeType }).success).toBe(true);
      expect(
        PrivateReviewImageChunkSchema.safeParse({
          kind: "markdown-review-image-chunk",
          reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
          revision: "r1",
          imageId: descriptor.id,
          imageRevision: descriptor.revision,
          mimeType,
          chunkIndex: 0,
          chunkCount: 1,
          byteOffset: 0,
          byteLength: 3,
          data: "AAAA",
        }).success,
      ).toBe(true);
    }

    for (const mimeType of ["image/gif", "image/avif", "image/svg+xml"]) {
      expect(ReviewImageMimeTypeSchema.safeParse(mimeType).success).toBe(false);
      expect(ReviewImageDescriptorSchema.safeParse({ ...descriptor, mimeType }).success).toBe(
        false,
      );
    }
  });

  test("requires descriptor chunk counts to match the encoded byte length", () => {
    const descriptor = {
      id: "image-1",
      mimeType: "image/png",
      revision: "i1",
      modifiedAt: "2026-08-23T00:00:00.000Z",
      width: 1,
      height: 1,
    } as const;

    expect(
      ReviewImageDescriptorSchema.safeParse({ ...descriptor, byteLength: 1, chunkCount: 1 })
        .success,
    ).toBe(true);
    expect(
      ReviewImageDescriptorSchema.safeParse({ ...descriptor, byteLength: 1, chunkCount: 2 })
        .success,
    ).toBe(false);
    expect(
      ReviewImageDescriptorSchema.safeParse({
        ...descriptor,
        byteLength: IMAGE_CHUNK_BYTES + 1,
        chunkCount: 1,
      }).success,
    ).toBe(false);
  });

  test("accepts the unique-image boundary and rejects one descriptor beyond it", () => {
    const document = {
      kind: "markdown-review-document" as const,
      path: "/tmp/review.md",
      filename: "review.md",
      title: "Review",
      revision: "r1",
      modifiedAt: "2026-08-23T00:00:00.000Z",
      sizeBytes: 10,
      lineCount: 1,
      blockCount: 1,
      reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
      html: "<p>Review</p>",
    };
    const images = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_, index) => ({
      id: `local-image-${index + 1}`,
      mimeType: "image/png" as const,
      revision: "a".repeat(64),
      modifiedAt: "2026-08-23T00:00:00.000Z",
      byteLength: 1,
      chunkCount: 1,
      width: 1,
      height: 1,
    }));

    expect(
      ReviewDocumentSchema.safeParse({ ...document, images: images.slice(0, MAX_INLINE_IMAGES) })
        .success,
    ).toBe(true);
    expect(ReviewDocumentSchema.safeParse({ ...document, images }).success).toBe(false);

    const firstImage = images[0];
    const secondImage = images[1];
    if (!firstImage || !secondImage) throw new Error("Expected image boundary fixtures");
    const duplicateId = [firstImage, { ...secondImage, id: firstImage.id }];
    expect(ReviewDocumentSchema.safeParse({ ...document, images: duplicateId }).success).toBe(
      false,
    );
    expect(
      ReviewDocumentSchema.safeParse({
        ...document,
        images: [{ ...firstImage, id: "image-1", revision: "i1" }],
      }).success,
    ).toBe(true);

    expect(
      ReviewDocumentSchema.safeParse({
        ...document,
        images: [
          { ...firstImage, width: 4_000, height: 4_000 },
          { ...secondImage, width: 4_000, height: 4_000 },
        ],
      }).success,
    ).toBe(true);
  });

  test("rejects malformed persisted state at the contract boundary", () => {
    expect(
      PersistedReviewStateSchema.safeParse({
        path: "/tmp/review.md",
        theme: "system",
        queue: [],
        nextSerial: 0,
        lastSubmission: null,
      }).success,
    ).toBe(false);
  });

  test("accepts bounded text anchors and rejects inverted or oversized anchors", () => {
    const selection = {
      startLine: 1,
      endLine: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      quote: "selected",
      textAnchor: { version: 1, start: 2, end: 10, prefix: "a", suffix: "b" },
    } as const;
    expect(ReviewSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      ReviewSelectionSchema.safeParse({
        ...selection,
        textAnchor: { ...selection.textAnchor, end: 2 },
      }).success,
    ).toBe(false);
    expect(
      ReviewSelectionSchema.safeParse({
        ...selection,
        textAnchor: { ...selection.textAnchor, prefix: "x".repeat(65) },
      }).success,
    ).toBe(false);
  });

  test("accepts bounded image anchors and rejects ambiguous anchor types", () => {
    const selection = {
      startLine: 4,
      endLine: 4,
      anchorX: 0.8,
      anchorY: 0.5,
      quote: "Image: Architecture diagram",
      imageId: "local-image-1",
    } as const;
    expect(ReviewSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      ReviewSelectionSchema.safeParse({
        ...selection,
        textAnchor: { version: 1, start: 2, end: 10, prefix: "a", suffix: "b" },
      }).success,
    ).toBe(false);
    expect(
      ReviewSelectionSchema.safeParse({ ...selection, imageId: "x".repeat(129) }).success,
    ).toBe(false);
  });

  test("accepts explicit document scope and rejects anchored document feedback", () => {
    const selection = {
      startLine: 1,
      endLine: 4,
      anchorX: 0.5,
      anchorY: 0,
      quote: "Whole document: review.md",
      scope: "document",
    } as const;
    expect(ReviewSelectionSchema.safeParse(selection).success).toBe(true);
    expect(
      ReviewSelectionSchema.safeParse({ ...selection, imageId: "local-image-1" }).success,
    ).toBe(false);
    expect(
      ReviewSelectionSchema.safeParse({
        ...selection,
        textAnchor: { version: 1, start: 2, end: 10, prefix: "a", suffix: "b" },
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate persisted queue IDs", () => {
    const item = {
      id: "duplicate",
      serial: 1,
      path: "/tmp/review.md",
      revision: "r1",
      startLine: 1,
      endLine: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      quote: "q",
      feedback: "c",
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    expect(
      PersistedReviewStateSchema.safeParse({
        path: "/tmp/review.md",
        theme: "light",
        queue: [item, { ...item, serial: 2 }],
        nextSerial: 3,
        lastSubmission: null,
        pendingSubmission: null,
      }).success,
    ).toBe(false);
  });

  test("rejects duplicate serials and mixed document paths", () => {
    const base = {
      id: "one",
      serial: 1,
      path: "/tmp/review.md",
      revision: "r1",
      startLine: 1,
      endLine: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      quote: "q",
      feedback: "c",
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    const state = {
      path: "/tmp/review.md",
      theme: "light",
      nextSerial: 2,
      lastSubmission: null,
      pendingSubmission: null,
    };
    expect(
      PersistedReviewStateSchema.safeParse({
        ...state,
        queue: [base, { ...base, id: "two" }],
      }).success,
    ).toBe(false);
    expect(
      PersistedReviewStateSchema.safeParse({
        ...state,
        queue: [base, { ...base, id: "two", serial: 2, path: "/tmp/other.md" }],
      }).success,
    ).toBe(false);
    expect(
      PersistedReviewStateSchema.safeParse({
        ...state,
        queue: [base],
        nextSerial: 1,
      }).success,
    ).toBe(false);
  });

  test("keeps private error metadata narrow and session-aware", () => {
    expect(
      ErrorReviewDocumentSchema.parse({
        kind: "markdown-review-document",
        error: "The session expired.",
        reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
      }),
    ).toEqual({
      kind: "markdown-review-document",
      error: "The session expired.",
      reviewSessionId: "8707d8a0-b84e-4a46-98e1-68ca135945de",
    });
    expect(
      ErrorReviewDocumentSchema.safeParse({
        kind: "markdown-review-document",
        error: "The session expired.",
        html: "must not cross the error boundary",
      }).success,
    ).toBe(false);
  });
});
