import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PersistedReviewStateSchema, ReviewBatchV1Schema } from "@markdown-review/contracts";
import {
  buildReviewBatch,
  normalizePersistedReviewState,
  parseCommentFeedback,
} from "@markdown-review/core";
import fc from "fast-check";
import { DefaultMarkdownPathPolicy } from "@markdown-review/markdown-node";
import { assembleImageChunks } from "@markdown-review/review-ui";

const PROPERTY_OPTIONS = { numRuns: 1_000, seed: 0x4d_52_56_31 } as const;

describe("deterministic review properties", () => {
  test("escaped and code-delimited #N values remain literal", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (serial) => {
        const parsed = parseCommentFeedback(`literal \\#${serial} and code \`#${serial}\``);
        expect(parsed.text).toBe(`literal #${serial} and code \`#${serial}\``);
        expect(parsed.references).toEqual([]);
      }),
      PROPERTY_OPTIONS,
    );
  });

  test("normalization is schema-valid, bounded, and assigns unique serials", () => {
    const queueItem = fc.record({
      id: fc.string({ minLength: 1, maxLength: 24 }),
      serial: fc.integer({ min: -10, max: 30 }),
      startLine: fc.integer({ min: 1, max: 1_000 }),
      lineSpan: fc.integer({ min: 0, max: 20 }),
      anchorX: fc.double({ noNaN: false, noDefaultInfinity: false }),
      anchorY: fc.double({ noNaN: false, noDefaultInfinity: false }),
      feedback: fc.string({ minLength: 1, maxLength: 80 }),
    });
    fc.assert(
      fc.property(fc.array(queueItem, { maxLength: 50 }), (rawQueue) => {
        const queue = rawQueue.map(({ lineSpan, ...item }) => ({
          ...item,
          path: "/tmp/review.md",
          revision: "revision",
          endLine: item.startLine + lineSpan,
          quote: "quote",
          createdAt: "2026-08-23T00:00:00.000Z",
        }));
        const normalized = normalizePersistedReviewState(
          { path: "/tmp/review.md", theme: "dark", queue, nextSerial: 1 },
          "2026-08-23T00:00:00.000Z",
        );
        expect(PersistedReviewStateSchema.safeParse(normalized).success).toBe(true);
        expect(normalized.queue.length).toBeLessThanOrEqual(20);
        expect(new Set(normalized.queue.map((item) => item.serial)).size).toBe(
          normalized.queue.length,
        );
        expect(new Set(normalized.queue.map((item) => item.id)).size).toBe(normalized.queue.length);
        expect(normalized.queue.every((item) => item.anchorX >= 0 && item.anchorX <= 1)).toBe(true);
        expect(normalized.queue.every((item) => item.anchorY >= 0 && item.anchorY <= 1)).toBe(true);
      }),
      PROPERTY_OPTIONS,
    );
  });

  test("batches preserve literals and expose only parsed references", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        (ownSerial, referencedSerial) => {
          const batch = buildReviewBatch({ path: "/tmp/review.md", revision: "current" }, [
            {
              id: "item",
              serial: ownSerial,
              path: "/tmp/review.md",
              revision: "current",
              startLine: 1,
              endLine: 1,
              anchorX: 0.5,
              anchorY: 0.5,
              quote: "quote",
              feedback: `Use #${referencedSerial}; keep \\#${ownSerial} and \`#${ownSerial}\`.`,
              createdAt: "2026-08-23T00:00:00.000Z",
            },
          ]);
          expect(ReviewBatchV1Schema.safeParse(batch).success).toBe(true);
          expect(batch.items[0]?.refs).toEqual([`#${referencedSerial}`]);
          expect(batch.items[0]?.comment).toContain(`keep #${ownSerial}`);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  test("encoded traversal variants cannot resolve outside the Markdown directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "markdown-review-path-property-"));
    try {
      const documentDirectory = join(root, "document");
      await mkdir(documentDirectory);
      const markdown = join(documentDirectory, "review.md");
      await writeFile(markdown, "# Review\n");
      await writeFile(join(root, "outside.png"), "not read");
      const policy = new DefaultMarkdownPathPolicy();
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("..", "%2e%2e", "%2E%2E"),
          fc.constantFrom("/", "%2f", "%2F", "%5c", "%5C"),
          async (parent, separator) => {
            try {
              await policy.resolveLocalImagePath(markdown, `${parent}${separator}outside.png`);
              return false;
            } catch {
              return true;
            }
          },
        ),
        PROPERTY_OPTIONS,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("chunk assembly preserves arbitrary bytes and rejects offset mutations", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.integer({ min: 1, max: 64 }),
        (bytes, requestedChunkSize) => {
          const chunkSize = Math.min(requestedChunkSize, bytes.length);
          const chunkCount = Math.ceil(bytes.length / chunkSize);
          const chunks = Array.from({ length: chunkCount }, (_, chunkIndex) => {
            const byteOffset = chunkIndex * chunkSize;
            const data = bytes.subarray(byteOffset, Math.min(byteOffset + chunkSize, bytes.length));
            return {
              chunkIndex,
              chunkCount,
              byteOffset,
              byteLength: data.length,
              data: Buffer.from(data).toString("base64"),
            };
          });
          expect(assembleImageChunks(chunks, chunkCount, bytes.length)).toEqual(bytes);

          const mutated = chunks.map((chunk) => ({ ...chunk }));
          const last = mutated.at(-1);
          if (!last) throw new Error("Expected at least one generated image chunk");
          last.byteOffset += 1;
          expect(() => assembleImageChunks(mutated, chunkCount, bytes.length)).toThrow(
            /incomplete/,
          );
        },
      ),
      PROPERTY_OPTIONS,
    );
  });
});
