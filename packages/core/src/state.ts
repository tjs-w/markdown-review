import {
  MAX_FEEDBACK_LENGTH,
  MAX_PATH_LENGTH,
  MAX_QUEUE_ID_LENGTH,
  MAX_QUEUE_ITEMS,
  MAX_QUOTE_LENGTH,
  MAX_REVISION_LENGTH,
  PersistedReviewStateSchema,
  QueuedFeedbackSchema,
  ReviewSubmissionSchema,
  type PersistedReviewState,
  type QueuedFeedback,
  type ReviewSelection,
  type ReviewSubmission,
} from "@markdown-review/contracts";

export interface ReviewRoundState {
  readonly persisted: PersistedReviewState;
  readonly activeSubmission: ReviewSubmission | null;
}

export interface QueueFeedbackInput {
  readonly id: string;
  readonly path: string;
  readonly revision: string;
  readonly selection: ReviewSelection;
  readonly feedback: string;
  readonly createdAt: string;
}

export interface UpdateQueuedFeedbackInput {
  readonly selection: ReviewSelection;
  readonly revision: string;
  readonly feedback: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function candidateQueueItem(
  value: unknown,
  fallbackCreatedAt: string,
): (Omit<QueuedFeedback, "serial"> & { serial: number | null }) | null {
  const item = asRecord(value);
  if (
    !item ||
    typeof item["id"] !== "string" ||
    typeof item["path"] !== "string" ||
    typeof item["feedback"] !== "string"
  )
    return null;

  const startLine = Number(item["startLine"]);
  const endLine = Number(item["endLine"]);
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    return null;

  const id = item["id"].slice(0, MAX_QUEUE_ID_LENGTH);
  const path = item["path"].slice(0, MAX_PATH_LENGTH);
  const feedback = item["feedback"].trim().slice(0, MAX_FEEDBACK_LENGTH);
  if (!id || !path || !feedback) return null;

  const possibleSerial = Number(item["serial"]);
  const serial =
    Number.isSafeInteger(possibleSerial) &&
    possibleSerial > 0 &&
    possibleSerial < Number.MAX_SAFE_INTEGER
      ? possibleSerial
      : null;
  return {
    id,
    serial,
    path,
    revision:
      typeof item["revision"] === "string" ? item["revision"].slice(0, MAX_REVISION_LENGTH) : "",
    startLine,
    endLine,
    anchorX: Math.max(0, Math.min(1, finiteNumber(item["anchorX"], 0.96))),
    anchorY: Math.max(0, Math.min(1, finiteNumber(item["anchorY"], 1))),
    quote: typeof item["quote"] === "string" ? item["quote"].slice(0, MAX_QUOTE_LENGTH) : "",
    feedback,
    createdAt:
      typeof item["createdAt"] === "string" && item["createdAt"].length > 0
        ? item["createdAt"].slice(0, 128)
        : fallbackCreatedAt,
  };
}

export function normalizePersistedReviewState(
  value: unknown,
  fallbackCreatedAt: string,
): PersistedReviewState {
  if (!fallbackCreatedAt)
    throw new Error("fallbackCreatedAt is required for deterministic state migration");
  const state = asRecord(value) ?? {};
  const storedPath =
    typeof state["path"] === "string" && state["path"].length > 0
      ? state["path"].slice(0, MAX_PATH_LENGTH)
      : null;
  const candidates = Array.isArray(state["queue"])
    ? state["queue"]
        .map((item) => candidateQueueItem(item, fallbackCreatedAt))
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  const reviewPath = storedPath ?? candidates[0]?.path ?? null;

  const queue: QueuedFeedback[] = [];
  const usedIds = new Set<string>();
  const usedSerials = new Set<number>();
  let availableSerial = 1;
  for (const candidate of candidates) {
    if (candidate.path !== reviewPath) continue;
    if (usedIds.has(candidate.id)) continue;
    usedIds.add(candidate.id);
    let serial = candidate.serial;
    if (serial === null || usedSerials.has(serial)) {
      while (usedSerials.has(availableSerial)) availableSerial += 1;
      serial = availableSerial;
    }
    usedSerials.add(serial);
    availableSerial = Math.max(availableSerial, serial + 1);
    queue.push(QueuedFeedbackSchema.parse({ ...candidate, serial }));
    if (queue.length === MAX_QUEUE_ITEMS) break;
  }

  const storedNextSerial = Number(state["nextSerial"]);
  const nextSerial =
    queue.length === 0
      ? 1
      : Number.isSafeInteger(storedNextSerial) && storedNextSerial > 0
        ? Math.max(storedNextSerial, availableSerial)
        : availableSerial;
  const lastSubmissionResult =
    state["lastSubmission"] === null || state["lastSubmission"] === undefined
      ? { success: true as const, data: null }
      : PersistedReviewStateSchema.shape.lastSubmission.safeParse(state["lastSubmission"]);
  const path = queue.length > 0 ? reviewPath : storedPath;
  const pendingResult = ReviewSubmissionSchema.safeParse(state["pendingSubmission"]);
  const queueIds = new Set(queue.map((item) => item.id));
  const pendingSubmission =
    pendingResult.success &&
    pendingResult.data.itemIds.every((id) => queueIds.has(id)) &&
    pendingResult.data.batch.file === path
      ? pendingResult.data
      : null;

  return PersistedReviewStateSchema.parse({
    path,
    theme: state["theme"] === "dark" ? "dark" : "light",
    queue,
    nextSerial,
    lastSubmission: lastSubmissionResult.success ? lastSubmissionResult.data : null,
    pendingSubmission,
  });
}

export function createReviewRoundState(persisted: PersistedReviewState): ReviewRoundState {
  const validated = PersistedReviewStateSchema.parse(persisted);
  return {
    persisted: validated,
    activeSubmission: validated.pendingSubmission,
  };
}

export function queueFeedback(
  state: ReviewRoundState,
  input: QueueFeedbackInput,
): ReviewRoundState {
  if (state.persisted.queue.length >= MAX_QUEUE_ITEMS)
    throw new RangeError(`A review round supports at most ${MAX_QUEUE_ITEMS} comments`);
  if (
    state.persisted.queue.length > 0 &&
    state.persisted.queue.some((item) => item.path !== input.path)
  ) {
    throw new Error("A review round cannot queue feedback for multiple Markdown files");
  }
  if (state.persisted.queue.some((item) => item.id === input.id))
    throw new Error(`Queue item ${input.id} already exists`);
  if (state.persisted.nextSerial >= Number.MAX_SAFE_INTEGER)
    throw new RangeError("The comment serial cannot be incremented safely");

  const item = QueuedFeedbackSchema.parse({
    id: input.id,
    serial: state.persisted.nextSerial,
    path: input.path,
    revision: input.revision,
    ...input.selection,
    feedback: input.feedback.trim(),
    createdAt: input.createdAt,
  });
  return {
    persisted: PersistedReviewStateSchema.parse({
      ...state.persisted,
      path: input.path,
      queue: [...state.persisted.queue, item],
      nextSerial: state.persisted.nextSerial + 1,
      pendingSubmission: null,
    }),
    activeSubmission: null,
  };
}

export function updateQueuedFeedback(
  state: ReviewRoundState,
  id: string,
  update: UpdateQueuedFeedbackInput,
): ReviewRoundState {
  const index = state.persisted.queue.findIndex((item) => item.id === id);
  if (index < 0) return state;
  const existing = state.persisted.queue[index];
  if (!existing) return state;
  const replacement = QueuedFeedbackSchema.parse({
    ...existing,
    ...update.selection,
    revision: update.revision,
    feedback: update.feedback.trim(),
  });
  const queue = [...state.persisted.queue];
  queue[index] = replacement;
  return {
    persisted: PersistedReviewStateSchema.parse({
      ...state.persisted,
      queue,
      pendingSubmission: null,
    }),
    activeSubmission: null,
  };
}

export function removeQueuedFeedback(state: ReviewRoundState, id: string): ReviewRoundState {
  if (!state.persisted.queue.some((item) => item.id === id)) return state;
  return {
    persisted: PersistedReviewStateSchema.parse({
      ...state.persisted,
      queue: state.persisted.queue.filter((item) => item.id !== id),
      pendingSubmission: null,
    }),
    activeSubmission: null,
  };
}
