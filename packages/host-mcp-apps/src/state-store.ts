import { PersistedReviewStateSchema, type PersistedReviewState } from "@markdown-review/contracts";
import { normalizePersistedReviewState } from "@markdown-review/core";
import type { DocumentRef, ReviewStateStore } from "@markdown-review/review-ui";

export const REVIEW_STATE_STORAGE_PREFIX = "markdown-review:state:v1:";
export const MAX_REVIEW_STATE_STORAGE_BYTES = 256 * 1024;

const MAX_STORED_REVIEW_RECORDS = 32;
const MAX_STORAGE_KEYS_TO_SCAN = 256;
const EMPTY_REVIEW_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredReviewState {
  readonly version: 1;
  readonly savedAt: string;
  readonly state: PersistedReviewState;
}

function storageKey(reviewSessionId: string): string {
  return `${REVIEW_STATE_STORAGE_PREFIX}${reviewSessionId}`;
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseStoredReviewState(value: string): StoredReviewState | null {
  if (
    value.length > MAX_REVIEW_STATE_STORAGE_BYTES ||
    encodedByteLength(value) > MAX_REVIEW_STATE_STORAGE_BYTES
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Readonly<Record<string, unknown>>;
    if (
      record["version"] !== 1 ||
      typeof record["savedAt"] !== "string" ||
      !Number.isFinite(Date.parse(record["savedAt"]))
    ) {
      return null;
    }
    const state = PersistedReviewStateSchema.safeParse(record["state"]);
    if (!state.success) return null;
    return { version: 1, savedAt: record["savedAt"], state: state.data };
  } catch {
    return null;
  }
}

function removeStoredItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A blocked storage area is handled by the next load or save operation.
  }
}

function pruneStoredReviewStates(storage: Storage, now: number): void {
  const records: { readonly key: string; readonly savedAt: number; readonly empty: boolean }[] = [];
  const keys: string[] = [];
  try {
    const count = Math.min(storage.length, MAX_STORAGE_KEYS_TO_SCAN);
    for (let index = 0; index < count; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(REVIEW_STATE_STORAGE_PREFIX)) keys.push(key);
    }
  } catch {
    return;
  }

  for (const key of keys) {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      return;
    }
    if (raw === null) continue;
    const parsed = parseStoredReviewState(raw);
    if (!parsed) {
      removeStoredItem(storage, key);
      continue;
    }
    const savedAt = Date.parse(parsed.savedAt);
    const empty = parsed.state.queue.length === 0 && parsed.state.pendingSubmission === null;
    if (empty && now - savedAt > EMPTY_REVIEW_STATE_TTL_MS) {
      removeStoredItem(storage, key);
      continue;
    }
    records.push({ key, savedAt, empty });
  }

  if (records.length <= MAX_STORED_REVIEW_RECORDS) return;
  const removable = records
    .filter((record) => record.empty)
    .sort((left, right) => left.savedAt - right.savedAt);
  let excess = records.length - MAX_STORED_REVIEW_RECORDS;
  for (const record of removable) {
    if (excess === 0) break;
    removeStoredItem(storage, record.key);
    excess -= 1;
  }
}

function resolveLocalStorage(hostWindow: Window | undefined): Storage | null {
  if (!hostWindow) return null;
  try {
    return hostWindow.localStorage;
  } catch {
    return null;
  }
}

export function createReviewStateStore(hostWindow?: Window): ReviewStateStore {
  const persistentStorageRequested = hostWindow !== undefined;
  let storage = resolveLocalStorage(hostWindow);
  let activeKey: string | null = null;
  let memory: PersistedReviewState | null = null;

  const disableStorage = (): void => {
    storage = null;
  };

  return {
    load(document: DocumentRef): Promise<PersistedReviewState | null> {
      const nextKey = storageKey(document.reviewSessionId);
      if (activeKey !== null && activeKey !== nextKey) memory = null;
      activeKey = nextKey;
      if (!storage) return Promise.resolve(memory);

      try {
        pruneStoredReviewStates(storage, Date.now());
        const raw = storage.getItem(activeKey);
        if (raw === null) {
          memory = null;
          return Promise.resolve(null);
        }
        const stored = parseStoredReviewState(raw);
        if (!stored || (stored.state.path !== null && stored.state.path !== document.path)) {
          memory = null;
          removeStoredItem(storage, activeKey);
          return Promise.resolve(null);
        }
        memory = normalizePersistedReviewState(stored.state, new Date().toISOString());
        return Promise.resolve(memory);
      } catch {
        disableStorage();
        return Promise.resolve(memory);
      }
    },
    save(snapshot: PersistedReviewState): Promise<void> {
      memory = PersistedReviewStateSchema.parse(snapshot);
      if (!storage) {
        return persistentStorageRequested
          ? Promise.reject(new Error("Persistent browser storage is unavailable"))
          : Promise.resolve();
      }
      if (!activeKey) {
        return Promise.reject(new Error("Review state storage has not been initialized"));
      }

      const stored: StoredReviewState = {
        version: 1,
        savedAt: new Date().toISOString(),
        state: memory,
      };
      const serialized = JSON.stringify(stored);
      if (encodedByteLength(serialized) > MAX_REVIEW_STATE_STORAGE_BYTES) {
        return Promise.reject(new Error("Review state exceeds the local storage limit"));
      }
      try {
        pruneStoredReviewStates(storage, Date.now());
        storage.setItem(activeKey, serialized);
        pruneStoredReviewStates(storage, Date.now());
        return Promise.resolve();
      } catch {
        disableStorage();
        return Promise.reject(new Error("Persistent browser storage is unavailable"));
      }
    },
  };
}
