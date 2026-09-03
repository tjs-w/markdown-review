import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Readonly<Record<string, unknown>>;
}

describe("Dyna checked-in Node bundle", () => {
  test("persists published signals, re-renders enrichment, and enforces one-time action claims", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "flowzone-dyna-"));
    temporaryDirectories.push(dataDirectory);
    const transport = new StdioClientTransport({
      command: "node",
      args: [resolve(pluginRoot, "server/dist/server.cjs")],
      cwd: pluginRoot,
      env: { FLOWZONE_DATA_DIR: dataDirectory, PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "dyna-stdio-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const resources = await client.listResources();
      const dynaResource = resources.resources.find(
        (resource) => resource.uri === "ui://flowzone/dyna/v1.html",
      );
      expect(dynaResource?._meta?.["ui"]).toEqual({
        prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
      });
      const dynaHtml = await client.readResource({ uri: "ui://flowzone/dyna/v1.html" });
      const dynaContent = dynaHtml.contents[0];
      expect(dynaContent && "text" in dynaContent ? dynaContent.text : "").toContain(
        'id="dyna-root"',
      );

      const create = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "create-dashboard",
          input: { name: "Executive brief", description: "What needs attention" },
        },
      });
      const dashboard = record(record(create.structuredContent)["result"]);
      const dashboardId = dashboard["id"];
      expect(typeof dashboardId).toBe("string");

      const publisherResult = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "create-publisher",
          input: { name: "Morning schedule" },
        },
      });
      const publisherEnvelope = record(record(publisherResult.structuredContent)["result"]);
      const publisher = record(publisherEnvelope["publisher"]);
      const publisherId = publisher["id"];
      const secret = publisherEnvelope["secret"];
      if (
        typeof dashboardId !== "string" ||
        typeof publisherId !== "string" ||
        typeof secret !== "string"
      )
        throw new Error("Missing Dyna identifiers");

      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "bind-schedule",
          input: {
            dashboardId,
            publisherId,
            scheduleId: "automation-morning",
            scheduleTitle: "Morning schedule",
            scheduleState: "active",
          },
        },
      });
      const sourceUpdatedAt = new Date().toISOString();
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "publish-run",
          input: {
            publisherId,
            secret,
            runId: "run-1",
            sourceCompletedAt: sourceUpdatedAt,
            mode: "replace",
            status: "succeeded",
            items: [
              {
                externalId: "group/project!123",
                sourceRef: {
                  source: "gitlab",
                  instanceId: "corp",
                  projectPath: "group/project",
                  iid: 123,
                  entityType: "merge_request",
                },
                sourceScope: "group/project",
                title: "Review release MR",
                summary: "The MR is ready for review.",
                priority: "high",
                priorityReason: "Release window closes today.",
                sourceUpdatedAt,
                labels: ["release"],
              },
            ],
          },
        },
      });

      const rendered = await client.callTool({
        name: "render_dyna_dashboard",
        arguments: { dashboardId },
      });
      expect(rendered.isError).toBeUndefined();
      expect(JSON.stringify(rendered.structuredContent)).not.toContain(
        "The MR is ready for review.",
      );
      const payload = record(record(rendered._meta)["dynaDashboard"]);
      const viewToken = payload["viewToken"];
      const snapshot = record(payload["snapshot"]);
      const cards = snapshot["cards"];
      if (typeof viewToken !== "string" || !Array.isArray(cards))
        throw new Error("Missing private Dyna payload");
      const itemId = record(cards[0])["id"];
      if (typeof itemId !== "string") throw new Error("Missing Dyna item id");

      await client.callTool({
        name: "dyna_add_annotation",
        arguments: {
          viewToken,
          itemId,
          body: "Create a new Codex task to review this MR.",
        },
      });

      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "apply-enrichment",
          input: {
            itemId,
            summary: "Reviewers added security context.",
            priority: "critical",
            priorityReason: "A security decision now blocks release.",
          },
        },
      });
      const secondPublisherResult = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "create-publisher",
          input: { name: "Afternoon schedule" },
        },
      });
      const secondPublisherEnvelope = record(
        record(secondPublisherResult.structuredContent)["result"],
      );
      const secondPublisher = record(secondPublisherEnvelope["publisher"]);
      const secondPublisherId = secondPublisher["id"];
      const secondSecret = secondPublisherEnvelope["secret"];
      if (typeof secondPublisherId !== "string" || typeof secondSecret !== "string") {
        throw new Error("Missing second Dyna publisher");
      }
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "bind-schedule",
          input: {
            dashboardId,
            publisherId: secondPublisherId,
            scheduleId: "automation-afternoon",
            scheduleTitle: "Afternoon schedule",
            scheduleState: "active",
          },
        },
      });
      const secondSourceUpdatedAt = new Date(Date.parse(sourceUpdatedAt) + 1_000).toISOString();
      const secondRunInput = {
        publisherId: secondPublisherId,
        secret: secondSecret,
        runId: "run-2",
        sourceCompletedAt: secondSourceUpdatedAt,
        mode: "replace",
        status: "succeeded",
        items: [
          {
            externalId: "same-mr-from-another-job",
            sourceRef: {
              source: "gitlab",
              instanceId: "corp",
              projectPath: "group/project",
              iid: 123,
              entityType: "merge_request",
            },
            sourceScope: "group/project",
            title: "Review release MR",
            summary: "The source changed after enrichment.",
            priority: "high",
            priorityReason: "Release window closes today.",
            sourceUpdatedAt: secondSourceUpdatedAt,
            labels: ["release"],
          },
        ],
      };
      await client.callTool({
        name: "flowzone",
        arguments: { plugin: "dyna", action: "publish-run", input: secondRunInput },
      });
      const refreshed = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken },
      });
      const refreshedPayload = record(record(refreshed._meta)["dynaDashboard"]);
      const refreshedSnapshot = record(refreshedPayload["snapshot"]);
      expect(record(refreshedSnapshot["counts"])["critical"]).toBe(1);
      const refreshedCards = refreshedSnapshot["cards"];
      if (!Array.isArray(refreshedCards)) throw new Error("Missing refreshed Dyna cards");
      expect(refreshedCards).toHaveLength(1);
      const refreshedCard = record(refreshedCards[0]);
      expect(refreshedCard["summary"]).toBe("Reviewers added security context.");
      expect(refreshedCard["enrichmentState"]).toBe("stale");
      const refreshedRevision = refreshedSnapshot["revision"];
      const itemFingerprint = refreshedCard["fingerprint"];
      if (typeof refreshedRevision !== "number" || typeof itemFingerprint !== "string") {
        throw new Error("Missing Dyna action preconditions");
      }

      const repeatedRun = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "dyna", action: "publish-run", input: secondRunInput },
      });
      expect(record(record(repeatedRun.structuredContent)["result"])["deduplicated"]).toBe(true);
      const conflictingRun = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "publish-run",
          input: { ...secondRunInput, mode: "upsert" },
        },
      });
      expect(conflictingRun.isError).toBe(true);
      const unchanged = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken, currentRevision: refreshedRevision },
      });
      expect(record(unchanged.structuredContent)["changed"]).toBe(false);
      expect(record(record(unchanged._meta)["dynaDashboard"])["snapshot"]).toBeDefined();

      const delayedRun = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "publish-run",
          input: {
            publisherId: secondPublisherId,
            secret: secondSecret,
            runId: "run-delayed-older",
            sourceCompletedAt: new Date(Date.parse(sourceUpdatedAt) + 500).toISOString(),
            mode: "replace",
            status: "succeeded",
            items: [],
          },
        },
      });
      expect(record(record(delayedRun.structuredContent)["result"])["superseded"]).toBe(true);
      const afterDelayedRun = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken },
      });
      const afterDelayedCards = record(
        record(record(afterDelayedRun._meta)["dynaDashboard"])["snapshot"],
      )["cards"];
      expect(afterDelayedCards).toHaveLength(1);

      const staleAction = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          kind: "create_codex_task",
          expectedRevision: refreshedRevision - 1,
          expectedFingerprint: itemFingerprint,
          idempotencyKey: "stale-action",
        },
      });
      expect(staleAction.isError).toBe(true);

      const prepared = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          kind: "create_codex_task",
          expectedRevision: refreshedRevision,
          expectedFingerprint: itemFingerprint,
          idempotencyKey: "integration-create-task",
        },
      });
      const requestId = record(prepared.structuredContent)["requestId"];
      if (typeof requestId !== "string") throw new Error("Missing Dyna request id");
      const duplicatePrepared = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          kind: "create_codex_task",
          expectedRevision: refreshedRevision,
          expectedFingerprint: itemFingerprint,
          idempotencyKey: "integration-create-task",
        },
      });
      expect(record(duplicatePrepared.structuredContent)["requestId"]).toBe(requestId);
      const otherDashboardResult = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "create-dashboard",
          input: { name: "Other dashboard", description: "Capability isolation" },
        },
      });
      const otherDashboardId = record(record(otherDashboardResult.structuredContent)["result"])[
        "id"
      ];
      if (typeof otherDashboardId !== "string") throw new Error("Missing other dashboard id");
      const otherRender = await client.callTool({
        name: "render_dyna_dashboard",
        arguments: { dashboardId: otherDashboardId },
      });
      const otherViewToken = record(record(otherRender._meta)["dynaDashboard"])["viewToken"];
      if (typeof otherViewToken !== "string") throw new Error("Missing other view capability");
      const unauthorizedStatus = await client.callTool({
        name: "dyna_action_status",
        arguments: { viewToken: otherViewToken, requestId },
      });
      expect(unauthorizedStatus.isError).toBe(true);
      await client.callTool({
        name: "dyna_mark_action_delivered",
        arguments: { viewToken, requestId },
      });
      const claimed = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "dyna", action: "claim-action", input: { requestId } },
      });
      const claim = record(record(claimed.structuredContent)["result"]);
      const claimedItem = record(record(claim["context"])["item"]);
      expect(JSON.stringify(claimedItem["annotations"])).toContain(
        "Create a new Codex task to review this MR.",
      );
      const claimToken = claim["claimToken"];
      expect(typeof claimToken).toBe("string");
      const replay = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "dyna", action: "claim-action", input: { requestId } },
      });
      expect(replay.isError).toBe(true);
      if (typeof claimToken !== "string") throw new Error("Missing Dyna claim token");
      const invalidFailure = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "complete-action",
          input: {
            requestId,
            claimToken,
            outcome: "failed",
            failureMessage: "controller failed",
            task: {
              taskId: "injected-task",
              hostId: "local",
              title: "Injected",
              state: "running",
              statusUpdatedAt: new Date().toISOString(),
              observedAt: new Date().toISOString(),
            },
          },
        },
      });
      expect(invalidFailure.isError).toBe(true);
      const observedAt = new Date().toISOString();
      const completed = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "complete-action",
          input: {
            requestId,
            claimToken,
            outcome: "succeeded",
            task: {
              taskId: "task-123",
              hostId: "local",
              title: "Review release MR",
              state: "running",
              statusUpdatedAt: observedAt,
              observedAt,
            },
          },
        },
      });
      expect(record(record(completed.structuredContent)["result"])["state"]).toBe("succeeded");
      const deliveredReplay = await client.callTool({
        name: "dyna_mark_action_delivered",
        arguments: { viewToken, requestId },
      });
      expect(record(deliveredReplay.structuredContent)["state"]).toBe("succeeded");
      const completionReplay = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "complete-action",
          input: { requestId, claimToken, outcome: "failed", failureMessage: "replay" },
        },
      });
      expect(completionReplay.isError).toBe(true);

      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "attach-codex-task",
          input: {
            itemId,
            task: {
              taskId: "task-123",
              hostId: "local",
              title: "Delayed stale observation",
              state: "failed",
              statusUpdatedAt: "2020-01-01T00:00:00.000Z",
              observedAt: new Date(Date.parse(observedAt) + 1_000).toISOString(),
            },
          },
        },
      });
      const taskRefresh = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken },
      });
      const taskSnapshot = record(record(record(taskRefresh._meta)["dynaDashboard"])["snapshot"]);
      const taskCards = taskSnapshot["cards"];
      if (!Array.isArray(taskCards)) throw new Error("Missing task cards");
      const linkedTasks = record(taskCards[0])["linkedTasks"];
      if (!Array.isArray(linkedTasks)) throw new Error("Missing linked tasks");
      expect(record(linkedTasks[0])["state"]).toBe("running");

      const taskRevision = taskSnapshot["revision"];
      const taskFingerprint = record(taskCards[0])["fingerprint"];
      if (typeof taskRevision !== "number" || typeof taskFingerprint !== "string") {
        throw new Error("Missing current Dyna action preconditions");
      }
      const driftPrepared = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          taskId: "task-123",
          taskHostId: "local",
          kind: "open_codex_task",
          expectedRevision: taskRevision,
          expectedFingerprint: taskFingerprint,
          idempotencyKey: "claim-drift",
        },
      });
      const driftRequestId = record(driftPrepared.structuredContent)["requestId"];
      if (typeof driftRequestId !== "string") throw new Error("Missing drift request id");
      await client.callTool({
        name: "dyna_mark_action_delivered",
        arguments: { viewToken, requestId: driftRequestId },
      });
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "update-dashboard",
          input: { dashboardId, description: "Changed after action preparation" },
        },
      });
      const driftClaim = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "dyna", action: "claim-action", input: { requestId: driftRequestId } },
      });
      expect(driftClaim.isError).toBe(true);
      const driftStatus = await client.callTool({
        name: "dyna_action_status",
        arguments: { viewToken, requestId: driftRequestId },
      });
      expect(record(driftStatus.structuredContent)["state"]).toBe("needs_reconciliation");

      const postDriftRefresh = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken },
      });
      const postDriftSnapshot = record(
        record(record(postDriftRefresh._meta)["dynaDashboard"])["snapshot"],
      );
      const postDriftCards = postDriftSnapshot["cards"];
      if (!Array.isArray(postDriftCards)) throw new Error("Missing post-drift cards");
      const retryPrepared = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          taskId: "task-123",
          taskHostId: "local",
          kind: "open_codex_task",
          expectedRevision: postDriftSnapshot["revision"],
          expectedFingerprint: record(postDriftCards[0])["fingerprint"],
          idempotencyKey: "failed-attempt-1",
        },
      });
      const retryRequestId = record(retryPrepared.structuredContent)["requestId"];
      if (typeof retryRequestId !== "string") throw new Error("Missing retry request id");
      await client.callTool({
        name: "dyna_mark_action_delivered",
        arguments: { viewToken, requestId: retryRequestId },
      });
      const retryClaim = record(
        record(
          (
            await client.callTool({
              name: "flowzone",
              arguments: {
                plugin: "dyna",
                action: "claim-action",
                input: { requestId: retryRequestId },
              },
            })
          ).structuredContent,
        )["result"],
      );
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "complete-action",
          input: {
            requestId: retryRequestId,
            claimToken: retryClaim["claimToken"],
            outcome: "failed",
            failureMessage: "Temporary controller failure",
          },
        },
      });
      const newAttempt = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          taskId: "task-123",
          taskHostId: "local",
          kind: "open_codex_task",
          expectedRevision: postDriftSnapshot["revision"],
          expectedFingerprint: record(postDriftCards[0])["fingerprint"],
          idempotencyKey: "failed-attempt-2",
        },
      });
      const newAttemptId = record(newAttempt.structuredContent)["requestId"];
      expect(newAttemptId).not.toBe(retryRequestId);
      if (typeof newAttemptId !== "string") throw new Error("Missing new attempt request id");
      const uncertainCreate = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          kind: "create_codex_task",
          expectedRevision: postDriftSnapshot["revision"],
          expectedFingerprint: record(postDriftCards[0])["fingerprint"],
          idempotencyKey: "uncertain-create",
        },
      });
      const uncertainCreateId = record(uncertainCreate.structuredContent)["requestId"];
      if (typeof uncertainCreateId !== "string") {
        throw new Error("Missing uncertain create request id");
      }
      await client.callTool({
        name: "dyna_mark_action_delivered",
        arguments: { viewToken, requestId: uncertainCreateId },
      });
      const uncertainClaim = record(
        record(
          (
            await client.callTool({
              name: "flowzone",
              arguments: {
                plugin: "dyna",
                action: "claim-action",
                input: { requestId: uncertainCreateId },
              },
            })
          ).structuredContent,
        )["result"],
      );
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "complete-action",
          input: {
            requestId: uncertainCreateId,
            claimToken: uncertainClaim["claimToken"],
            outcome: "needs_reconciliation",
            failureMessage: "Native task creation result is uncertain",
          },
        },
      });
      const blockedUncertainRetry = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          kind: "create_codex_task",
          expectedRevision: postDriftSnapshot["revision"],
          expectedFingerprint: record(postDriftCards[0])["fingerprint"],
          idempotencyKey: "blocked-uncertain-retry",
        },
      });
      expect(blockedUncertainRetry.isError).toBe(true);
      const reconciled = await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "resolve-action-reconciliation",
          input: {
            requestId: uncertainCreateId,
            outcome: "no_task_created",
            explanation: "Native task inventory was checked and no task was created.",
          },
        },
      });
      expect(record(record(reconciled.structuredContent)["result"])["state"]).toBe("failed");
      const safeAfterReconciliation = await client.callTool({
        name: "dyna_prepare_action",
        arguments: {
          viewToken,
          itemId,
          kind: "create_codex_task",
          expectedRevision: postDriftSnapshot["revision"],
          expectedFingerprint: record(postDriftCards[0])["fingerprint"],
          idempotencyKey: "safe-after-reconciliation",
        },
      });
      expect(safeAfterReconciliation.isError).toBeUndefined();

      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "publish-run",
          input: {
            publisherId: secondPublisherId,
            secret: secondSecret,
            runId: "run-failed",
            sourceCompletedAt: new Date(Date.parse(sourceUpdatedAt) + 2_000).toISOString(),
            mode: "replace",
            status: "failed",
            failureMessage: "Outlook was unavailable.",
            items: [],
          },
        },
      });
      const failedRunRefresh = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken },
      });
      const failedRunSnapshot = record(
        record(record(failedRunRefresh._meta)["dynaDashboard"])["snapshot"],
      );
      expect(failedRunSnapshot["freshness"]).toBe("stale");
      expect(failedRunSnapshot["cards"]).toHaveLength(1);

      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "publish-run",
          input: {
            publisherId: secondPublisherId,
            secret: secondSecret,
            runId: "run-empty-second",
            sourceCompletedAt: new Date(Date.parse(sourceUpdatedAt) + 3_000).toISOString(),
            mode: "replace",
            status: "succeeded",
            items: [],
          },
        },
      });
      await client.callTool({
        name: "flowzone",
        arguments: {
          plugin: "dyna",
          action: "publish-run",
          input: {
            publisherId,
            secret,
            runId: "run-empty-first",
            sourceCompletedAt: new Date(Date.parse(sourceUpdatedAt) + 1_000).toISOString(),
            mode: "replace",
            status: "succeeded",
            items: [],
          },
        },
      });
      const emptyRefresh = await client.callTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken },
      });
      const emptySnapshot = record(record(record(emptyRefresh._meta)["dynaDashboard"])["snapshot"]);
      expect(emptySnapshot["cards"]).toEqual([]);
      expect(record(emptySnapshot["counts"])["total"]).toBe(0);
    } finally {
      await client.close();
    }
  }, 20_000);
});
