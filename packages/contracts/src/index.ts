import { z } from "zod";

export const MAX_QUEUE_ITEMS = 20;
export const MAX_IMAGE_DIMENSION = 8192;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_PATH_LENGTH = 4096;
export const MAX_QUEUE_ID_LENGTH = 120;
export const MAX_REVISION_LENGTH = 128;
export const MAX_IMAGE_ID_LENGTH = 128;
export const MAX_QUOTE_LENGTH = 1400;
export const MAX_TEXT_ANCHOR_CONTEXT_LENGTH = 64;
export const MAX_FEEDBACK_LENGTH = 2400;
export const MAX_CLIPBOARD_TEXT_LENGTH = 2 * 1024 * 1024;
export const MAX_DOCUMENT_TITLE_LENGTH = 256;
export const MAX_RENDERED_HTML_LENGTH = 16 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
export const MAX_INLINE_IMAGE_REFERENCES = 64;
export const MAX_INLINE_IMAGES = MAX_INLINE_IMAGE_REFERENCES;
// Browser output canvases share this budget; source images remain bounded per descriptor.
export const MAX_INLINE_IMAGE_TOTAL_PIXELS = 24_000_000;
export const IMAGE_CHUNK_BYTES = 24 * 1024;
export const MAX_IMAGE_CHUNKS = Math.ceil(MAX_INLINE_IMAGE_BYTES / IMAGE_CHUNK_BYTES);
export const MAX_BASE64_CHUNK_LENGTH = Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4;

const NonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const PathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const RevisionSchema = z.string().max(MAX_REVISION_LENGTH);
const TimestampSchema = z.string().min(1).max(128);
const CommentReferenceSchema = z.string().regex(/^#[1-9]\d*$/);

export const ReviewImageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);

export const ReviewTextAnchorSchema = z
  .object({
    version: z.literal(1),
    start: NonNegativeSafeIntegerSchema.max(MAX_RENDERED_HTML_LENGTH),
    end: NonNegativeSafeIntegerSchema.max(MAX_RENDERED_HTML_LENGTH),
    prefix: z.string().max(MAX_TEXT_ANCHOR_CONTEXT_LENGTH),
    suffix: z.string().max(MAX_TEXT_ANCHOR_CONTEXT_LENGTH),
  })
  .strict()
  .refine((anchor) => anchor.end > anchor.start, {
    message: "end must be greater than start",
    path: ["end"],
  });

export const ReviewDocumentIdentitySchema = z
  .object({
    path: PathSchema,
    revision: z.string().min(1).max(MAX_REVISION_LENGTH),
  })
  .strict();

export const ReviewDocumentSummarySchema = ReviewDocumentIdentitySchema.extend({
  filename: z.string().min(1).max(MAX_PATH_LENGTH),
  title: z.string().min(1).max(MAX_DOCUMENT_TITLE_LENGTH),
  modifiedAt: TimestampSchema,
  sizeBytes: NonNegativeSafeIntegerSchema,
  lineCount: NonNegativeSafeIntegerSchema,
  blockCount: NonNegativeSafeIntegerSchema,
}).strict();

export const ReviewImageDescriptorSchema = z
  .object({
    id: z.string().min(1).max(MAX_IMAGE_ID_LENGTH),
    mimeType: ReviewImageMimeTypeSchema,
    revision: z.string().min(1).max(MAX_REVISION_LENGTH),
    modifiedAt: TimestampSchema,
    byteLength: PositiveSafeIntegerSchema.max(MAX_INLINE_IMAGE_BYTES),
    chunkCount: PositiveSafeIntegerSchema.max(MAX_IMAGE_CHUNKS),
    width: PositiveSafeIntegerSchema.max(MAX_IMAGE_DIMENSION),
    height: PositiveSafeIntegerSchema.max(MAX_IMAGE_DIMENSION),
  })
  .strict()
  .refine((image) => image.width * image.height <= MAX_IMAGE_PIXELS, {
    message: "The decoded image exceeds the pixel limit",
  })
  .refine((image) => image.chunkCount === Math.ceil(image.byteLength / IMAGE_CHUNK_BYTES), {
    message: "The chunk count must match the encoded image length",
    path: ["chunkCount"],
  });

export const ReviewDocumentSchema = ReviewDocumentSummarySchema.extend({
  kind: z.literal("markdown-review-document"),
  reviewSessionId: z.uuid(),
  html: z.string().max(MAX_RENDERED_HTML_LENGTH),
  images: z.array(ReviewImageDescriptorSchema).max(MAX_INLINE_IMAGES),
})
  .strict()
  .superRefine((document, context) => {
    const imageIds = new Set<string>();
    for (const [index, image] of document.images.entries()) {
      if (imageIds.has(image.id)) {
        context.addIssue({
          code: "custom",
          message: "Image descriptor IDs must be unique",
          path: ["images", index, "id"],
        });
      }
      imageIds.add(image.id);
    }
    const totalBytes = document.images.reduce((total, image) => total + image.byteLength, 0);
    if (totalBytes > MAX_INLINE_IMAGE_TOTAL_BYTES) {
      context.addIssue({ code: "custom", message: "The document exceeds the image byte limit" });
    }
  });

export const ErrorReviewDocumentSchema = z
  .object({
    kind: z.literal("markdown-review-document"),
    error: z.string().min(1),
    path: PathSchema.optional(),
    reviewSessionId: z.uuid().optional(),
  })
  .strict();

export const ReviewImageChunkRequestSchema = z
  .object({
    reviewSessionId: z.uuid(),
    revision: z.string().min(1).max(MAX_REVISION_LENGTH),
    imageId: z.string().min(1).max(MAX_IMAGE_ID_LENGTH),
    chunkIndex: NonNegativeSafeIntegerSchema,
  })
  .strict();

export const ReviewImageChunkSummarySchema = z
  .object({
    kind: z.literal("markdown-review-image-chunk"),
    reviewSessionId: z.uuid(),
    revision: z.string().min(1).max(MAX_REVISION_LENGTH),
    imageId: z.string().min(1).max(MAX_IMAGE_ID_LENGTH),
    imageRevision: z.string().min(1).max(MAX_REVISION_LENGTH),
    mimeType: ReviewImageMimeTypeSchema,
    chunkIndex: NonNegativeSafeIntegerSchema,
    chunkCount: PositiveSafeIntegerSchema,
    byteOffset: NonNegativeSafeIntegerSchema.max(MAX_INLINE_IMAGE_BYTES),
    byteLength: PositiveSafeIntegerSchema.max(IMAGE_CHUNK_BYTES),
  })
  .strict();

export const PrivateReviewImageChunkSchema = ReviewImageChunkSummarySchema.extend({
  data: z
    .string()
    .min(1)
    .max(MAX_BASE64_CHUNK_LENGTH)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();

// Host-neutral aliases use "asset" because the transport supports multiple raster formats.
export const AssetChunkRequestSchema = ReviewImageChunkRequestSchema;
export const AssetChunkSummarySchema = ReviewImageChunkSummarySchema;
export const PrivateAssetChunkSchema = PrivateReviewImageChunkSchema;

export const ReviewSelectionSchema = z
  .object({
    startLine: PositiveSafeIntegerSchema,
    endLine: PositiveSafeIntegerSchema,
    anchorX: z.number().min(0).max(1),
    anchorY: z.number().min(0).max(1),
    quote: z.string().max(MAX_QUOTE_LENGTH),
    textAnchor: ReviewTextAnchorSchema.optional(),
    imageId: z.string().min(1).max(MAX_IMAGE_ID_LENGTH).optional(),
    scope: z.literal("document").optional(),
  })
  .strict()
  .refine((selection) => selection.endLine >= selection.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  })
  .refine((selection) => !(selection.textAnchor && selection.imageId), {
    message: "A review selection cannot contain both text and image anchors",
    path: ["imageId"],
  })
  .refine(
    (selection) =>
      !(
        selection.scope !== undefined &&
        [selection.textAnchor, selection.imageId].some((anchor) => anchor !== undefined)
      ),
    {
      message: "A document-level review cannot contain a text or image anchor",
      path: ["scope"],
    },
  );

export const QueuedFeedbackSchema = ReviewSelectionSchema.extend({
  id: z.string().min(1).max(MAX_QUEUE_ID_LENGTH),
  serial: PositiveSafeIntegerSchema,
  path: PathSchema,
  revision: RevisionSchema,
  feedback: z.string().min(1).max(MAX_FEEDBACK_LENGTH),
  createdAt: TimestampSchema,
}).strict();

export const LastSubmissionSchema = z
  .object({
    count: PositiveSafeIntegerSchema.max(MAX_QUEUE_ITEMS),
    path: PathSchema,
    revision: z.string().min(1).max(MAX_REVISION_LENGTH),
    submittedAt: TimestampSchema,
  })
  .strict();

export const ReviewBatchItemSchema = z
  .object({
    id: CommentReferenceSchema,
    refs: z.array(CommentReferenceSchema),
    lines: z
      .tuple([PositiveSafeIntegerSchema, PositiveSafeIntegerSchema])
      .refine(([startLine, endLine]) => endLine >= startLine, {
        message: "The ending line must not precede the starting line",
      }),
    quote: z.string().max(MAX_QUOTE_LENGTH),
    comment: z.string().max(MAX_FEEDBACK_LENGTH),
    revision: RevisionSchema.optional(),
  })
  .strict();

export const ReviewBatchV1Schema = z
  .object({
    schema: z.literal("markdown-review/v1"),
    file: PathSchema,
    revision: z.string().min(1).max(MAX_REVISION_LENGTH),
    items: z.array(ReviewBatchItemSchema).min(1).max(MAX_QUEUE_ITEMS),
    missingRefs: z.array(CommentReferenceSchema).optional(),
  })
  .strict();

export const ReviewSubmissionSchema = z
  .object({
    submissionId: z.string().min(1).max(200),
    itemIds: z.array(z.string().min(1).max(MAX_QUEUE_ID_LENGTH)).min(1).max(MAX_QUEUE_ITEMS),
    batch: ReviewBatchV1Schema,
  })
  .strict()
  .refine((submission) => new Set(submission.itemIds).size === submission.itemIds.length, {
    message: "itemIds must be unique",
    path: ["itemIds"],
  });

export const PersistedReviewStateSchema = z
  .object({
    path: PathSchema.nullable(),
    theme: z.enum(["light", "dark"]),
    queue: z
      .array(QueuedFeedbackSchema)
      .max(MAX_QUEUE_ITEMS)
      .refine((queue) => new Set(queue.map((item) => item.id)).size === queue.length, {
        message: "Queue item IDs must be unique",
      })
      .refine((queue) => new Set(queue.map((item) => item.serial)).size === queue.length, {
        message: "Queue comment serials must be unique",
      }),
    nextSerial: PositiveSafeIntegerSchema,
    lastSubmission: LastSubmissionSchema.nullable(),
    pendingSubmission: ReviewSubmissionSchema.nullable().default(null),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.queue.length > 0 &&
      (!state.path || state.queue.some((item) => item.path !== state.path))
    ) {
      context.addIssue({
        code: "custom",
        message: "Every queued comment must match the review state path",
        path: ["queue"],
      });
    }
    const largestSerial = state.queue.reduce((largest, item) => Math.max(largest, item.serial), 0);
    if (state.nextSerial <= largestSerial) {
      context.addIssue({
        code: "custom",
        message: "nextSerial must be greater than every queued comment serial",
        path: ["nextSerial"],
      });
    }
  });

export type ReviewDocumentIdentity = z.infer<typeof ReviewDocumentIdentitySchema>;
export type ReviewDocumentSummary = z.infer<typeof ReviewDocumentSummarySchema>;
export type ReviewImageDescriptor = z.infer<typeof ReviewImageDescriptorSchema>;
export type ReviewImageMimeType = z.infer<typeof ReviewImageMimeTypeSchema>;
export type ReviewTextAnchor = z.infer<typeof ReviewTextAnchorSchema>;
export type ReviewDocument = z.infer<typeof ReviewDocumentSchema>;
export type ErrorReviewDocument = z.infer<typeof ErrorReviewDocumentSchema>;
export type ReviewImageChunkRequest = z.infer<typeof ReviewImageChunkRequestSchema>;
export type ReviewImageChunkSummary = z.infer<typeof ReviewImageChunkSummarySchema>;
export type PrivateReviewImageChunk = z.infer<typeof PrivateReviewImageChunkSchema>;
export type AssetChunkRequest = ReviewImageChunkRequest;
export type AssetChunkSummary = ReviewImageChunkSummary;
export type PrivateAssetChunk = PrivateReviewImageChunk;
export type ReviewSelection = z.infer<typeof ReviewSelectionSchema>;
export type QueuedFeedback = z.infer<typeof QueuedFeedbackSchema>;
export type LastSubmission = z.infer<typeof LastSubmissionSchema>;
export type PersistedReviewState = z.infer<typeof PersistedReviewStateSchema>;
export type ReviewBatchItem = z.infer<typeof ReviewBatchItemSchema>;
export type ReviewBatchV1 = z.infer<typeof ReviewBatchV1Schema>;
export type ReviewSubmission = z.infer<typeof ReviewSubmissionSchema>;
