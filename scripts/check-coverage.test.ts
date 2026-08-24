import { describe, expect, test } from "bun:test";

import { evaluateLcov } from "./check-coverage";

function passingRecord(source: string): string {
  return `SF:${source}\nFNF:100\nFNH:100\nLF:100\nLH:100\nend_of_record\n`;
}

describe("coverage release gate", () => {
  test("recognizes Bun's relative workspace paths", () => {
    const expected = new Set([
      "packages/contracts/src/index.ts",
      "packages/core/src/state.ts",
      "packages/review-ui/src/mount.ts",
      "web/src/png-decoder.ts",
    ]);
    const failures = evaluateLcov(
      passingRecord("packages/contracts/src/index.ts") +
        passingRecord("packages/core/src/state.ts") +
        passingRecord("packages/review-ui/src/mount.ts") +
        passingRecord("/tmp/repo/web/src/png-decoder.ts"),
      expected,
    );
    expect(failures).toEqual([]);
  });

  test("recognizes absolute and Windows workspace paths", () => {
    const expected = new Set(["packages/contracts/src/index.ts", "packages/core/src/state.ts"]);
    expect(
      evaluateLcov(
        passingRecord("/tmp/repo/packages/contracts/src/index.ts") +
          passingRecord("C:\\repo\\packages\\core\\src\\state.ts"),
        expected,
      ),
    ).toEqual([]);
  });

  test("fails closed when the report has no workspace source records", () => {
    const failures = evaluateLcov(passingRecord("scripts/build.ts"), new Set());
    expect(failures).toContain("overall: no workspace source records found in coverage/lcov.info");
    expect(failures).toContain("contracts/core: no source records found in coverage/lcov.info");
  });

  test("fails when an expected production module was never imported", () => {
    const failures = evaluateLcov(
      passingRecord("packages/contracts/src/index.ts") +
        passingRecord("packages/core/src/state.ts"),
      new Set([
        "packages/contracts/src/index.ts",
        "packages/core/src/state.ts",
        "packages/host-mcp-apps/src/mcp-apps-host.ts",
      ]),
    );
    expect(failures[0]).toContain("packages/host-mcp-apps/src/mcp-apps-host.ts");
  });
});
