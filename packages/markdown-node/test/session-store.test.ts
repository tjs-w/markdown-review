import { describe, expect, test } from "bun:test";
import { basename } from "node:path";

import type { ReviewDocument, ReviewImageDescriptor } from "@markdown-review/contracts";

import type { StoredImage } from "../src/render.js";
import { ReviewSessionStore } from "../src/session-store.js";

const IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

function document(path: string): Omit<ReviewDocument, "reviewSessionId"> {
  return {
    kind: "markdown-review-document",
    path,
    filename: basename(path),
    title: "Review",
    revision: "revision",
    modifiedAt: "2026-08-23T00:00:00.000Z",
    sizeBytes: 10,
    lineCount: 1,
    blockCount: 1,
    html: "<p>Review</p>",
    images: [],
  };
}

function storedImage(id: string, byteLength: number): StoredImage {
  const descriptor: ReviewImageDescriptor = {
    id,
    mimeType: "image/png",
    revision: "a".repeat(64),
    modifiedAt: "2026-08-23T00:00:00.000Z",
    byteLength,
    chunkCount: 1,
    width: 1,
    height: 1,
  };
  return { descriptor, bytes: Buffer.alloc(byteLength), sha256: descriptor.revision };
}

describe("ReviewSessionStore", () => {
  test("uses sliding expiry and rejects an expired opaque session", () => {
    let now = 0;
    let nextId = 0;
    const store = new ReviewSessionStore({
      ttlMs: 100,
      now: () => now,
      createId: () => IDS[nextId++] ?? crypto.randomUUID(),
    });
    const session = store.create(document("/tmp/one.md"), []);

    now = 80;
    expect(store.get(session.id).id).toBe(session.id);
    now = 170;
    expect(store.get(session.id).id).toBe(session.id);
    now = 271;
    expect(() => store.get(session.id)).toThrow(/unavailable or expired/);
  });

  test("evicts the least-recently-used session by count", () => {
    let nextId = 0;
    const store = new ReviewSessionStore({
      maximumSessions: 2,
      createId: () => IDS[nextId++] ?? crypto.randomUUID(),
    });
    const first = store.create(document("/tmp/one.md"), []);
    const second = store.create(document("/tmp/two.md"), []);
    store.get(first.id);
    store.create(document("/tmp/three.md"), []);

    expect(store.get(first.id).document.path).toBe("/tmp/one.md");
    expect(() => store.get(second.id)).toThrow(/unavailable or expired/);
  });

  test("evicts by aggregate immutable image bytes", () => {
    let nextId = 0;
    const store = new ReviewSessionStore({
      maximumSessions: 6,
      maximumImageBytes: 5,
      createId: () => IDS[nextId++] ?? crypto.randomUUID(),
    });
    const firstImage = storedImage("local-image-1", 3);
    const first = store.create({ ...document("/tmp/one.md"), images: [firstImage.descriptor] }, [
      firstImage,
    ]);
    const secondImage = storedImage("local-image-2", 3);
    store.create({ ...document("/tmp/two.md"), images: [secondImage.descriptor] }, [secondImage]);

    expect(store.imageBytes).toBe(3);
    expect(() => store.get(first.id)).toThrow(/unavailable or expired/);
  });
});
