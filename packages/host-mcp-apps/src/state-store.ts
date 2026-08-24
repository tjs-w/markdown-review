import { PersistedReviewStateSchema, type PersistedReviewState } from "@markdown-review/contracts";
import { normalizePersistedReviewState } from "@markdown-review/core";
import type { ReviewStateStore } from "@markdown-review/review-ui";

interface OpenAiStateCompatibility {
  readPrivateContent(): unknown;
  writePrivateContent(value: PersistedReviewState): Promise<void>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function openAiCompatibility(hostWindow: Window): OpenAiStateCompatibility | null {
  const windowRecord = hostWindow as unknown as Readonly<Record<string, unknown>>;
  const openAi = asRecord(windowRecord["openai"]);
  if (!openAi) return null;
  const setWidgetState = openAi["setWidgetState"];
  if (typeof setWidgetState !== "function") return null;
  return {
    readPrivateContent(): unknown {
      const currentOpenAi = asRecord(windowRecord["openai"]);
      const widgetState = asRecord(currentOpenAi?.["widgetState"]);
      return widgetState?.["privateContent"];
    },
    async writePrivateContent(value: PersistedReviewState): Promise<void> {
      const validated = PersistedReviewStateSchema.parse(value);
      const result: unknown = Reflect.apply(setWidgetState, openAi, [
        { privateContent: validated },
      ]);
      await Promise.resolve(result);
    },
  };
}

export function createReviewStateStore(hostWindow: Window = window): ReviewStateStore {
  let memory: PersistedReviewState | null = null;
  return {
    load(): Promise<PersistedReviewState | null> {
      const compatibility = openAiCompatibility(hostWindow);
      const raw = compatibility?.readPrivateContent() ?? memory;
      if (raw === null) return Promise.resolve(null);
      return Promise.resolve(normalizePersistedReviewState(raw, new Date().toISOString()));
    },
    async save(snapshot: PersistedReviewState): Promise<void> {
      memory = PersistedReviewStateSchema.parse(snapshot);
      const compatibility = openAiCompatibility(hostWindow);
      if (compatibility) await compatibility.writePrivateContent(memory);
    },
  };
}
