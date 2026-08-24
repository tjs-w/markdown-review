import { describe, expect, test } from "bun:test";
import { encode } from "fast-png";

import { decodePng } from "./png-decoder";

describe("portable browser PNG decoder", () => {
  for (const fixture of [
    { name: "grayscale", channels: 1, source: [42], expected: [42, 42, 42, 255] },
    { name: "grayscale alpha", channels: 2, source: [42, 128], expected: [42, 42, 42, 128] },
    { name: "RGB", channels: 3, source: [10, 20, 30], expected: [10, 20, 30, 255] },
    { name: "RGBA", channels: 4, source: [10, 20, 30, 40], expected: [10, 20, 30, 40] },
  ] as const) {
    test(`converts ${fixture.name} pixels to RGBA`, () => {
      const encoded = encode({
        width: 1,
        height: 1,
        channels: fixture.channels,
        data: Uint8Array.from(fixture.source),
      });
      expect([...decodePng(encoded).data]).toEqual([...fixture.expected]);
    });
  }

  test("converts a bounded indexed-color palette to RGBA", () => {
    const encoded = encode({
      width: 1,
      height: 1,
      depth: 8,
      channels: 1,
      data: Uint8Array.from([0]),
      palette: [[12, 34, 56, 78]],
    });
    expect([...decodePng(encoded).data]).toEqual([12, 34, 56, 78]);
  });

  test("rejects 16-bit channels before decoding", () => {
    const encoded = encode({
      width: 1,
      height: 1,
      channels: 1,
      depth: 16,
      data: Uint16Array.from([0x1234]),
    });
    expect(() => decodePng(encoded)).toThrow(/8-bit PNG samples/);
  });

  test("rejects malformed PNG input", () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3]))).toThrow();
  });
});
