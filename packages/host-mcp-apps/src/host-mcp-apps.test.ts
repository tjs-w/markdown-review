import { describe, expect, test } from "bun:test";
import { PersistedReviewStateSchema, ReviewSubmissionSchema } from "@markdown-review/contracts";

import { formatCodexSubmission } from "./format-codex-submission";
import { findReviewDocument } from "./payloads";
import { createReviewStateStore } from "./state-store";

const reviewDocument = {
  kind: "markdown-review-document" as const,
  reviewSessionId: "123e4567-e89b-42d3-a456-426614174000",
  path: "/tmp/review.md",
  filename: "review.md",
  title: "Review",
  revision: "abc123",
  modifiedAt: "2026-08-23T20:00:00.000Z",
  sizeBytes: 20,
  lineCount: 2,
  blockCount: 1,
  html: '<p class="review-block" data-start-line="1" data-end-line="2">Review</p>',
  images: [],
};

function parseFencedEnvelope(message: string): {
  readonly fence: string;
  readonly envelope: unknown;
} {
  const match = /\n\n(`{3,})json\n([\s\S]*)\n\1$/u.exec(message);
  if (!match?.[1] || match[2] === undefined) throw new Error("Expected a fenced JSON envelope");
  return { fence: match[1], envelope: JSON.parse(match[2]) as unknown };
}

describe("Codex submission adapter", () => {
  test("wraps the stable submission id and exact v1 batch in concise Markdown", () => {
    const submission = ReviewSubmissionSchema.parse({
      submissionId: "submission-stable",
      itemIds: ["feedback-1"],
      batch: {
        schema: "markdown-review/v1",
        file: reviewDocument.path,
        revision: reviewDocument.revision,
        items: [
          {
            id: "#1",
            refs: [],
            lines: [1, 1],
            quote: "Review",
            comment: "Tighten this.",
          },
        ],
      },
    });
    const message = formatCodexSubmission(submission);
    expect(message.startsWith("Use $markdown-review to handle every item below")).toBeTrue();
    expect(message).toContain("Apply each `comment` only to its anchored Markdown passage");
    const { fence, envelope } = parseFencedEnvelope(message);
    expect(fence).toBe("```");
    expect(envelope).toEqual({
      submissionId: submission.submissionId,
      review: submission.batch,
    });
    expect(JSON.stringify(envelope)).not.toContain("itemIds");
  });

  test("chooses a lossless fence for Markdown, Unicode, and long backtick runs", () => {
    const submission = ReviewSubmissionSchema.parse({
      submissionId: "submission-fenced",
      itemIds: ["feedback-1"],
      batch: {
        schema: "markdown-review/v1",
        file: reviewDocument.path,
        revision: reviewDocument.revision,
        items: [
          {
            id: "#1",
            refs: [],
            lines: [1, 1],
            quote: "A ```json example with π",
            comment: "Preserve ````` literally.\nThen clarify **this**.",
          },
        ],
      },
    });
    const { fence, envelope } = parseFencedEnvelope(formatCodexSubmission(submission));
    expect(fence).toBe("``````");
    expect(envelope).toEqual({
      submissionId: submission.submissionId,
      review: submission.batch,
    });
  });

  test("rejects an unvalidated host submission", () => {
    expect(() => formatCodexSubmission({ submissionId: "bad" })).toThrow();
  });
});

describe("host payload validation", () => {
  test("finds a valid private document in a standard tool result", () => {
    expect(
      findReviewDocument({ structuredContent: { _meta: { document: reviewDocument } } }),
    ).toEqual(reviewDocument);
  });

  test("does not accept a document-shaped payload with an invalid session", () => {
    expect(
      findReviewDocument({ _meta: { document: { ...reviewDocument, reviewSessionId: "forged" } } }),
    ).toBeNull();
  });
});

describe("review state store", () => {
  test("uses validated in-memory state when no OpenAI extension exists", async () => {
    const state = PersistedReviewStateSchema.parse({
      path: reviewDocument.path,
      theme: "dark",
      queue: [],
      nextSerial: 1,
      lastSubmission: null,
    });
    const store = createReviewStateStore({} as Window);
    await store.save(state);
    expect(await store.load(reviewDocument)).toEqual(state);
  });

  test("isolates and migrates optional widget state compatibility", async () => {
    let saved: unknown;
    const fakeWindow = {
      openai: {
        widgetState: {
          privateContent: { path: reviewDocument.path, theme: "dark", queue: [], nextSerial: 99 },
        },
        setWidgetState(value: unknown) {
          saved = value;
        },
      },
    } as unknown as Window;
    const store = createReviewStateStore(fakeWindow);
    const loaded = await store.load(reviewDocument);
    expect(loaded?.theme).toBe("dark");
    expect(loaded?.nextSerial).toBe(1);
    if (!loaded) throw new Error("Expected migrated state");
    await store.save(loaded);
    expect(saved).toEqual({ privateContent: loaded });
  });
});
