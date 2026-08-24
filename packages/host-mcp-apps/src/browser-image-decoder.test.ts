import { describe, expect, test } from "bun:test";
import type { ReviewImageMimeType } from "@markdown-review/contracts";

import { createBrowserImageDecoder } from "./browser-image-decoder";

interface DecoderHarness {
  readonly decoder: ReturnType<typeof createBrowserImageDecoder>;
  readonly blobs: Blob[];
  readonly draws: unknown[];
  readonly closed: { count: number };
  readonly canvases: { width: number; height: number }[];
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

function createHarness(
  width = 2,
  height = 1,
  pixels = Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]),
  canvasAvailable = true,
): DecoderHarness {
  const blobs: Blob[] = [];
  const draws: unknown[] = [];
  const canvases: { width: number; height: number }[] = [];
  const closed = { count: 0 };
  const bitmap = {
    width,
    height,
    close() {
      closed.count += 1;
    },
  } as ImageBitmap;
  const hostWindow = {
    Blob,
    createImageBitmap(blob: Blob) {
      blobs.push(blob);
      return Promise.resolve(bitmap);
    },
    document: {
      createElement() {
        const canvas = {
          width: 0,
          height: 0,
          getContext() {
            if (!canvasAvailable) return null;
            return {
              drawImage(...values: unknown[]) {
                draws.push(values);
              },
              getImageData() {
                return { data: pixels };
              },
            };
          },
        };
        canvases.push(canvas);
        return canvas;
      },
    },
  } as unknown as Window;
  return { decoder: createBrowserImageDecoder(hostWindow), blobs, draws, closed, canvases };
}

describe("native browser image decoder", () => {
  test("rasterizes immutable bytes and releases the native bitmap", async () => {
    const harness = createHarness();
    const decoded = await harness.decoder.decode(Uint8Array.from([1, 2, 3]), "image/webp");
    expect(decoded).toEqual({
      width: 2,
      height: 1,
      data: Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]),
    });
    expect(harness.blobs).toHaveLength(1);
    expect(harness.blobs[0]?.type).toBe("image/webp");
    expect(harness.draws).toHaveLength(1);
    expect(harness.closed.count).toBe(1);
    expect(harness.canvases[0]).toMatchObject({ width: 0, height: 0 });
  });

  test("validates source dimensions and returns a bounded review raster", async () => {
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    const harness = createHarness(4, 4, pixels);
    const decoded = await harness.decoder.decode(new Uint8Array(), "image/png", {
      expectedWidth: 4,
      expectedHeight: 4,
      outputWidth: 2,
      outputHeight: 2,
    });
    expect(decoded).toEqual({ width: 2, height: 2, data: pixels });
    expect(harness.draws[0]).toEqual([expect.anything(), 0, 0, 2, 2]);
    expect(harness.closed.count).toBe(1);

    const mismatch = createHarness(4, 4, pixels);
    expect(
      await rejectionMessage(
        mismatch.decoder.decode(new Uint8Array(), "image/png", {
          expectedWidth: 5,
          expectedHeight: 4,
          outputWidth: 2,
          outputHeight: 2,
        }),
      ),
    ).toMatch(/did not match/);
    expect(mismatch.closed.count).toBe(1);

    const upscale = createHarness(4, 4, pixels);
    expect(
      await rejectionMessage(
        upscale.decoder.decode(new Uint8Array(), "image/png", {
          expectedWidth: 4,
          expectedHeight: 4,
          outputWidth: 5,
          outputHeight: 4,
        }),
      ),
    ).toMatch(/raster dimensions exceed/);
    expect(upscale.closed.count).toBe(1);
  });

  test("returns the browser pixel buffer without retaining a duplicate copy", async () => {
    const source = Uint8ClampedArray.from([1, 2, 3, 255, 4, 5, 6, 255]);
    const harness = createHarness(2, 1, source);
    const decoded = await harness.decoder.decode(new Uint8Array(), "image/png");
    expect(decoded.data).toBe(source);
  });

  test("rejects formats outside the local-image allowlist", async () => {
    const harness = createHarness();
    expect(
      await rejectionMessage(
        harness.decoder.decode(new Uint8Array(), "image/svg+xml" as ReviewImageMimeType),
      ),
    ).toMatch(/not supported/);
    expect(harness.blobs).toHaveLength(0);
  });

  test("rejects unsafe decoded dimensions and still releases resources", async () => {
    const harness = createHarness(9_000, 1);
    expect(await rejectionMessage(harness.decoder.decode(new Uint8Array(), "image/png"))).toMatch(
      /dimensions exceed/,
    );
    expect(harness.closed.count).toBe(1);
  });

  test("rejects unavailable native decoding before allocating a blob", async () => {
    const decoder = createBrowserImageDecoder({ document } as unknown as Window);
    expect(await rejectionMessage(decoder.decode(new Uint8Array(), "image/jpeg"))).toMatch(
      /unavailable/,
    );
  });

  test("rejects canvas and RGBA failures while releasing native resources", async () => {
    const noCanvas = createHarness(2, 1, new Uint8ClampedArray(8), false);
    expect(await rejectionMessage(noCanvas.decoder.decode(new Uint8Array(), "image/jpeg"))).toMatch(
      /Canvas image decoding is unavailable/,
    );
    expect(noCanvas.closed.count).toBe(1);
    expect(noCanvas.canvases[0]).toMatchObject({ width: 0, height: 0 });

    const shortPixels = createHarness(2, 1, new Uint8ClampedArray(4));
    expect(
      await rejectionMessage(shortPixels.decoder.decode(new Uint8Array(), "image/webp")),
    ).toMatch(/pixel buffer is invalid/);
    expect(shortPixels.closed.count).toBe(1);
    expect(shortPixels.canvases[0]).toMatchObject({ width: 0, height: 0 });
  });
});
