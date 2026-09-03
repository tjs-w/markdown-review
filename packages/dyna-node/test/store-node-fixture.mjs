import assert from "node:assert/strict";

import { DynaStore } from "../src/store.ts";

let clockMs = Date.now();
const store = new DynaStore({ databasePath: ":memory:", clock: () => new Date(clockMs) });
try {
  const dashboard = store.createDashboard("Executive brief", "Decisions and risks");
  const { publisher, secret } = store.createPublisher("Morning schedule");
  store.bindSchedule(dashboard.id, publisher.id, {
    id: "morning",
    title: "Morning schedule",
    state: "active",
    staleAfterMinutes: 10,
  });
  const sourceCompletedAt = new Date(clockMs).toISOString();
  store.publish(
    publisher.id,
    secret,
    [
      {
        externalId: "project!1",
        sourceRef: {
          source: "gitlab",
          instanceId: "test",
          projectPath: "group/project",
          iid: 1,
          entityType: "merge_request",
        },
        sourceScope: "group/project",
        title: "Review MR",
        summary: "Ready for review.",
        priority: "high",
        priorityReason: "Release is waiting.",
        sourceUpdatedAt: sourceCompletedAt,
        labels: [],
      },
    ],
    { runId: "run-1", sourceCompletedAt, mode: "replace", status: "succeeded" },
  );
  const initial = store.snapshot(dashboard.id);
  assert.equal(initial.freshness, "fresh");
  const item = initial.cards[0];
  assert.ok(item);
  const viewToken = store.createView(dashboard.id);
  const request = store.prepareAction(viewToken, "create_codex_task", {
    itemId: item.id,
    expectedRevision: initial.revision,
    expectedFingerprint: item.fingerprint,
    idempotencyKey: "lease-test",
  });
  store.markDelivered(viewToken, request.id);
  store.claimAction(request.id);

  clockMs += 5 * 60_000 + 1;
  const claim = store.actionStatusForView(viewToken, request.id).state;
  assert.equal(claim, "needs_reconciliation");
  assert.throws(
    () =>
      store.prepareAction(viewToken, "create_codex_task", {
        itemId: item.id,
        expectedRevision: initial.revision,
        expectedFingerprint: item.fingerprint,
        idempotencyKey: "unsafe-retry",
      }),
    /explicit reconciliation/,
  );
  assert.equal(
    store.resolveActionReconciliation(request.id, {
      outcome: "no_task_created",
      explanation: "The native task inventory was checked and no task was created.",
    }).state,
    "failed",
  );
  assert.equal(
    store.prepareAction(viewToken, "create_codex_task", {
      itemId: item.id,
      expectedRevision: initial.revision,
      expectedFingerprint: item.fingerprint,
      idempotencyKey: "safe-retry",
    }).state,
    "prepared",
  );

  clockMs = Date.parse(sourceCompletedAt) + 8 * 60_000;
  assert.equal(store.snapshot(dashboard.id).freshness, "aging");
  clockMs = Date.parse(sourceCompletedAt) + 11 * 60_000;
  const freshness = store.snapshot(dashboard.id).freshness;
  assert.equal(freshness, "stale");
  globalThis.process.stdout.write(JSON.stringify({ claim, freshness }));
} finally {
  store.close();
}
