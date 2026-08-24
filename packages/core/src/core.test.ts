import { describe, expect, test } from "bun:test";

import {
  PersistedReviewStateSchema,
  type PersistedReviewState,
  type QueuedFeedback,
  type ReviewSelection,
} from "@markdown-review/contracts";

import {
  buildReviewBatch,
  completeReviewSubmission,
  createReviewRoundState,
  normalizePersistedReviewState,
  parseCommentFeedback,
  prepareReviewSubmission,
  queueFeedback,
  removeQueuedFeedback,
  retainFailedReviewSubmission,
  updateQueuedFeedback,
} from "./index";

const now = "2026-08-23T00:00:00.000Z";
const document = { path: "/tmp/review.md", revision: "document-revision" };
const selection: ReviewSelection = {
  startLine: 2,
  endLine: 3,
  anchorX: 0.5,
  anchorY: 0.75,
  quote: "Selected text",
};

function emptyPersistedState(): PersistedReviewState {
  return PersistedReviewStateSchema.parse({
    path: document.path,
    theme: "light",
    queue: [],
    nextSerial: 1,
    lastSubmission: null,
  });
}

function queuedItem(overrides: Partial<QueuedFeedback> = {}): QueuedFeedback {
  return {
    id: "feedback-1",
    serial: 1,
    path: document.path,
    revision: document.revision,
    ...selection,
    feedback: "Make this clearer.",
    createdAt: now,
    ...overrides,
  };
}

describe("comment references", () => {
  test("preserves literals and extracts only explicit references", () => {
    const parsed = parseCommentFeedback(
      "Use #1 twice (#1), ignore C#2, print \\#3, keep `#4`, and compare #5.",
    );
    expect(parsed.text).toBe("Use #1 twice (#1), ignore C#2, print #3, keep `#4`, and compare #5.");
    expect(parsed.references).toEqual([1, 5]);
  });

  test("does not return unsafe numeric references", () => {
    expect(parseCommentFeedback("Keep #999999999999999999999 literal.").references).toEqual([]);
  });
});

describe("persisted state migration", () => {
  test("preserves valid text anchors and drops malformed legacy anchors", () => {
    const base = {
      ...queuedItem(),
      textAnchor: { version: 1, start: 4, end: 17, prefix: "pre", suffix: "post" },
    } as const;
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        theme: "light",
        queue: [base, { ...base, id: "feedback-2", serial: 2, textAnchor: { start: -1 } }],
        nextSerial: 3,
        lastSubmission: null,
      },
      now,
    );
    expect(normalized.queue[0]?.textAnchor).toEqual(base.textAnchor);
    expect(normalized.queue[1]?.textAnchor).toBeUndefined();
  });

  test("preserves image anchors and removes conflicting legacy text anchors", () => {
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        queue: [
          {
            ...queuedItem({ quote: "Image: Architecture diagram" }),
            imageId: "local-image-1",
            textAnchor: { version: 1, start: 4, end: 17, prefix: "pre", suffix: "post" },
          },
        ],
      },
      now,
    );
    expect(normalized.queue[0]?.imageId).toBe("local-image-1");
    expect(normalized.queue[0]?.textAnchor).toBeUndefined();
  });

  test("preserves document scope and removes conflicting legacy anchors", () => {
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        queue: [
          {
            ...queuedItem({ quote: "Whole document: review.md" }),
            scope: "document",
            imageId: "local-image-1",
            textAnchor: { version: 1, start: 4, end: 17, prefix: "pre", suffix: "post" },
          },
        ],
      },
      now,
    );
    expect(normalized.queue[0]?.scope).toBe("document");
    expect(normalized.queue[0]?.imageId).toBeUndefined();
    expect(normalized.queue[0]?.textAnchor).toBeUndefined();
  });

  test("caps the queue, repairs serials, clamps anchors, and ignores legacy history", () => {
    const inputQueue = Array.from({ length: 25 }, (_, index) => ({
      id: `id-${index}`,
      serial: index === 1 ? 9 : index === 2 ? 9 : undefined,
      path: document.path,
      revision: document.revision,
      startLine: 1,
      endLine: 1,
      anchorX: index === 0 ? 8 : 0.5,
      anchorY: index === 0 ? -2 : 0.5,
      quote: "q",
      feedback: "feedback",
    }));
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        theme: "dark",
        queue: inputQueue,
        nextSerial: 2,
        history: [{ serial: 99 }],
      },
      now,
    );

    expect(normalized.queue).toHaveLength(20);
    expect(new Set(normalized.queue.map((item) => item.serial)).size).toBe(20);
    expect(normalized.queue[0]?.anchorX).toBe(1);
    expect(normalized.queue[0]?.anchorY).toBe(0);
    expect(normalized.queue[0]?.createdAt).toBe(now);
    expect(normalized.nextSerial).toBeGreaterThan(
      Math.max(...normalized.queue.map((item) => item.serial)),
    );
    expect("history" in normalized).toBe(false);
  });

  test("resets an empty legacy round to comment one", () => {
    const normalized = normalizePersistedReviewState(
      { queue: [], nextSerial: 50, history: [{}] },
      now,
    );
    expect(normalized.nextSerial).toBe(1);
    expect(normalized.queue).toEqual([]);
  });

  test("drops later duplicate queue IDs before applying the queue limit", () => {
    const duplicate = {
      id: "duplicate",
      path: document.path,
      revision: document.revision,
      startLine: 1,
      endLine: 1,
      anchorX: 0.5,
      anchorY: 0.5,
      quote: "q",
      feedback: "first",
    };
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        queue: [
          duplicate,
          { ...duplicate, feedback: "discarded" },
          ...Array.from({ length: 20 }, (_, index) => ({
            ...duplicate,
            id: `unique-${index}`,
            feedback: `comment-${index}`,
          })),
        ],
      },
      now,
    );

    expect(normalized.queue).toHaveLength(20);
    expect(normalized.queue[0]?.feedback).toBe("first");
    expect(new Set(normalized.queue.map((item) => item.id)).size).toBe(20);
  });

  test("keeps only the canonical document path during hostile state migration", () => {
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        queue: [queuedItem(), queuedItem({ id: "foreign", serial: 2, path: "/tmp/other.md" })],
      },
      now,
    );
    expect(normalized.queue.map((item) => item.id)).toEqual(["feedback-1"]);
    expect(normalized.path).toBe(document.path);
  });

  test("repairs a maximum-safe legacy serial so the next serial remains valid", () => {
    const normalized = normalizePersistedReviewState(
      {
        path: document.path,
        queue: [queuedItem({ serial: Number.MAX_SAFE_INTEGER })],
        nextSerial: Number.MAX_SAFE_INTEGER,
      },
      now,
    );
    expect(normalized.queue[0]?.serial).toBe(1);
    expect(normalized.nextSerial).toBe(Number.MAX_SAFE_INTEGER);
    expect(PersistedReviewStateSchema.safeParse(normalized).success).toBe(true);
  });
});

describe("pure queue and submission state", () => {
  test("queues, edits, and removes feedback without mutation", () => {
    const initial = createReviewRoundState(emptyPersistedState());
    const queued = queueFeedback(initial, {
      id: "feedback-1",
      path: document.path,
      revision: document.revision,
      selection,
      feedback: "  Tighten this.  ",
      createdAt: now,
    });
    expect(initial.persisted.queue).toEqual([]);
    expect(queued.persisted.queue[0]?.serial).toBe(1);
    expect(queued.persisted.queue[0]?.feedback).toBe("Tighten this.");
    expect(queued.persisted.nextSerial).toBe(2);

    const updated = updateQueuedFeedback(queued, "feedback-1", {
      selection: { ...selection, startLine: 4, endLine: 4 },
      revision: "new-revision",
      feedback: "Use the new wording.",
    });
    expect(updated.persisted.queue[0]?.serial).toBe(1);
    expect(updated.persisted.queue[0]?.startLine).toBe(4);
    expect(removeQueuedFeedback(updated, "feedback-1").persisted.queue).toEqual([]);
    expect(() =>
      queueFeedback(queued, {
        id: "feedback-foreign",
        path: "/tmp/other.md",
        revision: document.revision,
        selection,
        feedback: "Foreign document.",
        createdAt: now,
      }),
    ).toThrow(/multiple Markdown files/);
  });

  test("builds the exact versioned batch with refs, literals, and stale revision", () => {
    const items = [
      queuedItem(),
      queuedItem({
        id: "feedback-2",
        serial: 2,
        revision: "older-revision",
        feedback: "Compare with #1, print \\#3, and keep `#4`.",
      }),
    ];
    expect(buildReviewBatch(document, items)).toEqual({
      schema: "markdown-review/v1",
      file: document.path,
      revision: document.revision,
      items: [
        {
          id: "#1",
          refs: [],
          lines: [2, 3],
          quote: "Selected text",
          comment: "Make this clearer.",
        },
        {
          id: "#2",
          refs: ["#1"],
          lines: [2, 3],
          quote: "Selected text",
          comment: "Compare with #1, print #3, and keep `#4`.",
          revision: "older-revision",
        },
      ],
    });
  });

  test("keeps image comments in the stable line-and-quote submission contract", () => {
    const image = queuedItem({
      quote: "Image: Architecture diagram",
      imageId: "local-image-1",
      feedback: "Increase the diagram labels.",
    });
    const batch = buildReviewBatch(document, [image]);
    expect(batch.items).toEqual([
      {
        id: "#1",
        refs: [],
        lines: [2, 3],
        quote: "Image: Architecture diagram",
        comment: "Increase the diagram labels.",
      },
    ]);
    expect(batch.items[0]).not.toHaveProperty("imageId");
  });

  test("keeps document feedback compatible with the stable line-and-quote contract", () => {
    const wholeDocument = queuedItem({
      startLine: 1,
      endLine: 4,
      quote: "Whole document: review.md",
      scope: "document",
      feedback: "Reorganize the document around the decision.",
    });
    const batch = buildReviewBatch(document, [wholeDocument]);
    expect(batch.items).toEqual([
      {
        id: "#1",
        refs: [],
        lines: [1, 4],
        quote: "Whole document: review.md",
        comment: "Reorganize the document around the decision.",
      },
    ]);
    expect(batch.items[0]).not.toHaveProperty("scope");
  });

  test("retains one stable attempt after failure and clears submitted IDs on success", () => {
    const persisted = PersistedReviewStateSchema.parse({
      ...emptyPersistedState(),
      queue: [queuedItem(), queuedItem({ id: "feedback-2", serial: 2, feedback: "Also fix #1." })],
      nextSerial: 3,
    });
    const initial = createReviewRoundState(persisted);
    const first = prepareReviewSubmission(initial, document, "submission-1");
    if (!first) throw new Error("Expected a submission");
    expect(first.reused).toBe(false);
    expect(first.submission.batch).not.toHaveProperty("submissionId");

    const failed = retainFailedReviewSubmission(first.state, first.submission.submissionId);
    expect(failed).toBe(first.state);
    expect(failed.persisted.queue).toEqual(persisted.queue);
    const restored = createReviewRoundState(normalizePersistedReviewState(failed.persisted, now));
    const retry = prepareReviewSubmission(restored, document, "submission-2");
    if (!retry) throw new Error("Expected a retry");
    expect(retry.reused).toBe(true);
    expect(retry.submission.submissionId).toBe("submission-1");

    const completed = completeReviewSubmission(
      retry.state,
      retry.submission.submissionId,
      "2026-08-23T00:01:00.000Z",
    );
    expect(completed.persisted.queue).toEqual([]);
    expect(completed.persisted.nextSerial).toBe(1);
    expect(completed.activeSubmission).toBeNull();
    expect(completed.persisted.lastSubmission).toEqual({
      count: 2,
      path: document.path,
      revision: document.revision,
      submittedAt: "2026-08-23T00:01:00.000Z",
    });
  });

  test("requires a fresh ID when a persisted pending payload no longer matches the queue", () => {
    const first = queuedItem();
    const second = queuedItem({ id: "feedback-2", serial: 2, feedback: "A later comment." });
    const staleSubmission = {
      submissionId: "submission-old",
      itemIds: [first.id],
      batch: buildReviewBatch(document, [first]),
    };
    const state = createReviewRoundState(
      PersistedReviewStateSchema.parse({
        ...emptyPersistedState(),
        queue: [first, second],
        nextSerial: 3,
        pendingSubmission: staleSubmission,
      }),
    );

    expect(() => prepareReviewSubmission(state, document, "submission-old")).toThrow(/fresh/);
    const prepared = prepareReviewSubmission(state, document, "submission-fresh");
    expect(prepared?.reused).toBe(false);
    expect(prepared?.submission.submissionId).toBe("submission-fresh");
    expect(prepared?.submission.itemIds).toEqual([first.id, second.id]);
  });

  test("clears only IDs captured by the successful attempt", () => {
    const persisted = PersistedReviewStateSchema.parse({
      ...emptyPersistedState(),
      queue: [queuedItem()],
      nextSerial: 2,
    });
    const prepared = prepareReviewSubmission(
      createReviewRoundState(persisted),
      document,
      "submission-1",
    );
    if (!prepared) throw new Error("Expected a submission");
    const laterItem = queuedItem({ id: "feedback-2", serial: 2 });
    const withLaterItem = {
      ...prepared.state,
      persisted: PersistedReviewStateSchema.parse({
        ...prepared.state.persisted,
        queue: [...prepared.state.persisted.queue, laterItem],
        nextSerial: 3,
      }),
    };
    const completed = completeReviewSubmission(withLaterItem, "submission-1", now);
    expect(completed.persisted.queue.map((item) => item.id)).toEqual(["feedback-2"]);
    expect(completed.persisted.nextSerial).toBe(3);
  });
});
