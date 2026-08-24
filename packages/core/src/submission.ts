import {
  LastSubmissionSchema,
  PersistedReviewStateSchema,
  ReviewBatchV1Schema,
  ReviewSubmissionSchema,
  type QueuedFeedback,
  type ReviewBatchV1,
  type ReviewDocumentIdentity,
  type ReviewSubmission,
} from "@markdown-review/contracts";

import { parseCommentFeedback } from "./references";
import type { ReviewRoundState } from "./state";

function reference(serial: number): `#${number}` {
  return `#${serial}`;
}

export function buildReviewBatch(
  document: ReviewDocumentIdentity,
  items: readonly QueuedFeedback[],
): ReviewBatchV1 {
  if (items.length === 0)
    throw new Error("A review submission must contain at least one queued comment");
  if (items.some((item) => item.path !== document.path)) {
    throw new Error("Every queued comment must belong to the submitted Markdown document");
  }

  const parsedById = new Map(items.map((item) => [item.id, parseCommentFeedback(item.feedback)]));
  const submittedSerials = new Set(items.map((item) => item.serial));
  const referencedSerials = [
    ...new Set(items.flatMap((item) => parsedById.get(item.id)?.references ?? [])),
  ];
  const missingRefs = referencedSerials
    .filter((serial) => !submittedSerials.has(serial))
    .map(reference);

  return ReviewBatchV1Schema.parse({
    schema: "markdown-review/v1",
    file: document.path,
    revision: document.revision,
    items: items.map((item) => {
      const parsed = parsedById.get(item.id);
      if (!parsed) throw new Error(`Could not parse queued comment ${item.id}`);
      return {
        id: reference(item.serial),
        refs: parsed.references.map(reference),
        lines: [item.startLine, item.endLine],
        quote: item.quote,
        comment: parsed.text,
        ...(item.revision && item.revision !== document.revision
          ? { revision: item.revision }
          : {}),
      };
    }),
    ...(missingRefs.length > 0 ? { missingRefs } : {}),
  });
}

function submissionsMatch(left: ReviewSubmission, right: ReviewSubmission): boolean {
  return (
    JSON.stringify(left.itemIds) === JSON.stringify(right.itemIds) &&
    JSON.stringify(left.batch) === JSON.stringify(right.batch)
  );
}

export interface PreparedReviewSubmission {
  readonly state: ReviewRoundState;
  readonly submission: ReviewSubmission;
  readonly reused: boolean;
}

export function prepareReviewSubmission(
  state: ReviewRoundState,
  document: ReviewDocumentIdentity,
  submissionId: string,
): PreparedReviewSubmission | null {
  if (state.persisted.queue.length === 0) return null;
  const candidate = ReviewSubmissionSchema.parse({
    submissionId,
    itemIds: state.persisted.queue.map((item) => item.id),
    batch: buildReviewBatch(document, state.persisted.queue),
  });
  if (state.activeSubmission && submissionsMatch(state.activeSubmission, candidate)) {
    return { state, submission: state.activeSubmission, reused: true };
  }
  if (state.activeSubmission?.submissionId === candidate.submissionId) {
    throw new Error("A changed review payload requires a fresh submission ID");
  }
  return {
    state: {
      persisted: PersistedReviewStateSchema.parse({
        ...state.persisted,
        pendingSubmission: candidate,
      }),
      activeSubmission: candidate,
    },
    submission: candidate,
    reused: false,
  };
}

function requireActiveSubmission(state: ReviewRoundState, submissionId: string): ReviewSubmission {
  if (state.activeSubmission?.submissionId !== submissionId) {
    throw new Error("The submission attempt is not active for this review round");
  }
  return state.activeSubmission;
}

export function retainFailedReviewSubmission(
  state: ReviewRoundState,
  submissionId: string,
): ReviewRoundState {
  requireActiveSubmission(state, submissionId);
  return state;
}

export function completeReviewSubmission(
  state: ReviewRoundState,
  submissionId: string,
  submittedAt: string,
): ReviewRoundState {
  const submission = requireActiveSubmission(state, submissionId);
  const submittedIds = new Set(submission.itemIds);
  const queue = state.persisted.queue.filter((item) => !submittedIds.has(item.id));
  const largestRemainingSerial = queue.reduce((largest, item) => Math.max(largest, item.serial), 0);
  const nextSerial =
    queue.length === 0 ? 1 : Math.max(state.persisted.nextSerial, largestRemainingSerial + 1);
  const lastSubmission = LastSubmissionSchema.parse({
    count: submission.itemIds.length,
    path: submission.batch.file,
    revision: submission.batch.revision,
    submittedAt,
  });

  return {
    persisted: PersistedReviewStateSchema.parse({
      ...state.persisted,
      queue,
      nextSerial,
      lastSubmission,
      pendingSubmission: null,
    }),
    activeSubmission: null,
  };
}
