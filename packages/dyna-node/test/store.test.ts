import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("DynaStore lifecycle", () => {
  test("passes Node-native claim lease and schedule freshness checks", () => {
    const fixture = resolve(import.meta.dir, "store-node-fixture.mjs");
    const result = spawnSync("node", [fixture], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      claim: "needs_reconciliation",
      freshness: "stale",
    });
  });
});
