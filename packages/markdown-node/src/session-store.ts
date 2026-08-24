import { randomUUID } from "node:crypto";

import { ReviewDocumentSchema, type ReviewDocument } from "@markdown-review/contracts";

import {
  MAX_REVIEW_SESSIONS,
  MAX_REVIEW_SESSION_IMAGE_BYTES,
  REVIEW_SESSION_TTL_MS,
} from "./constants.js";
import type { StoredImage } from "./render.js";

export interface ReviewSession {
  readonly id: string;
  readonly document: ReviewDocument;
  readonly images: ReadonlyMap<string, StoredImage>;
  readonly imageBytes: number;
  readonly createdAt: number;
  expiresAt: number;
}

export interface ReviewSessionStoreOptions {
  readonly maximumSessions?: number;
  readonly maximumImageBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export class ReviewSessionStore {
  readonly #sessions = new Map<string, ReviewSession>();
  readonly #maximumSessions: number;
  readonly #maximumImageBytes: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #createId: () => string;
  #imageBytes = 0;

  constructor(options: ReviewSessionStoreOptions = {}) {
    this.#maximumSessions = options.maximumSessions ?? MAX_REVIEW_SESSIONS;
    this.#maximumImageBytes = options.maximumImageBytes ?? MAX_REVIEW_SESSION_IMAGE_BYTES;
    this.#ttlMs = options.ttlMs ?? REVIEW_SESSION_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  create(
    document: Omit<ReviewDocument, "reviewSessionId">,
    images: readonly StoredImage[],
  ): ReviewSession {
    const now = this.#now();
    this.#removeExpired(now);
    let id = this.#createId();
    while (this.#sessions.has(id)) id = this.#createId();
    const imageMap = new Map(
      images.map((image) => [
        image.descriptor.id,
        { ...image, descriptor: { ...image.descriptor }, bytes: Buffer.from(image.bytes) },
      ]),
    );
    const imageBytes = images.reduce((total, image) => total + image.bytes.byteLength, 0);
    const reviewDocument = ReviewDocumentSchema.parse({ ...document, reviewSessionId: id });
    const session: ReviewSession = {
      id,
      document: reviewDocument,
      images: imageMap,
      imageBytes,
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    };
    this.#sessions.set(id, session);
    this.#imageBytes += imageBytes;
    this.#evictToLimits();
    return session;
  }

  get(id: string): ReviewSession {
    const now = this.#now();
    const session = this.#sessions.get(id);
    if (!session || session.expiresAt <= now) {
      if (session) this.#delete(id, session);
      this.#removeExpired(now);
      throw new Error("The Markdown review session is unavailable or expired; reopen the review.");
    }
    session.expiresAt = now + this.#ttlMs;
    this.#sessions.delete(id);
    this.#sessions.set(id, session);
    this.#removeExpired(now);
    return session;
  }

  get size(): number {
    this.#removeExpired(this.#now());
    return this.#sessions.size;
  }

  get imageBytes(): number {
    this.#removeExpired(this.#now());
    return this.#imageBytes;
  }

  #removeExpired(now: number): void {
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#delete(id, session);
    }
  }

  #evictToLimits(): void {
    while (
      this.#sessions.size > this.#maximumSessions ||
      this.#imageBytes > this.#maximumImageBytes
    ) {
      const oldest = this.#sessions.entries().next().value;
      if (!oldest) return;
      this.#delete(oldest[0], oldest[1]);
    }
  }

  #delete(id: string, session: ReviewSession): void {
    if (!this.#sessions.delete(id)) return;
    this.#imageBytes -= session.imageBytes;
  }
}
