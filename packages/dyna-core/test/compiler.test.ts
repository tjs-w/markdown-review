import { describe, expect, test } from "bun:test";

import { dynaCatalog, type DynaDashboardSnapshot } from "@flowzone/dyna-contracts";

import { compileDashboard } from "../src/index.js";

function snapshot(): DynaDashboardSnapshot {
  const timestamp = "2026-09-03T01:00:00.000Z";
  return {
    schema: "dyna/snapshot-v1",
    dashboard: {
      id: "bd9a11b5-fbf8-495a-a116-d3429496969f",
      name: "Morning brief",
      description: "Signals that need a decision.",
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    generatedAt: timestamp,
    revision: 4,
    freshness: "fresh",
    counts: { critical: 0, high: 1, total: 2 },
    schedules: [],
    cards: [
      {
        id: "d4c4cf38-1ce0-40d8-9593-f40075a53862",
        fingerprint: "a".repeat(64),
        source: "slack",
        title: "Normal but newer",
        summary: "Informational update.",
        priority: "normal",
        priorityReason: "No immediate action required.",
        sourceUpdatedAt: "2026-09-03T00:59:00.000Z",
        labels: [],
        annotations: [],
        linkedTasks: [],
      },
      {
        id: "6d48a2b2-9e1c-41d4-9db1-a7bc34ff39d4",
        fingerprint: "b".repeat(64),
        source: "gitlab",
        title: "MR is blocked",
        summary: "A required review is missing.",
        priority: "high",
        priorityReason: "Release train closes today.",
        sourceUpdatedAt: "2026-09-03T00:30:00.000Z",
        labels: ["release"],
        annotations: [],
        linkedTasks: [],
      },
    ],
  };
}

describe("compileDashboard", () => {
  test("produces only catalog-approved components in priority order", () => {
    const spec = compileDashboard(snapshot());
    expect(dynaCatalog.validate(spec).success).toBe(true);
    expect(spec.elements["root"]?.children).toEqual(["summary", "section-high", "section-normal"]);
    expect(JSON.stringify(spec)).not.toContain("<script");
    expect(JSON.stringify(spec)).not.toContain("toolName");
  });
});
