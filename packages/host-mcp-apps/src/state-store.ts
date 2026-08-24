import { PersistedReviewStateSchema, type PersistedReviewState } from "@markdown-review/contracts";
import { normalizePersistedReviewState } from "@markdown-review/core";
import type { ReviewStateStore } from "@markdown-review/review-ui";

export function createReviewStateStore(hostWindow?: Window): ReviewStateStore {
  // Retain the bootstrap signature without publishing state through the model-visible legacy bridge.
  void hostWindow;
  let memory: PersistedReviewState | null = null;
  return {
    load(): Promise<PersistedReviewState | null> {
      if (memory === null) return Promise.resolve(null);
      return Promise.resolve(normalizePersistedReviewState(memory, new Date().toISOString()));
    },
    save(snapshot: PersistedReviewState): Promise<void> {
      memory = PersistedReviewStateSchema.parse(snapshot);
      return Promise.resolve();
    },
  };
}
