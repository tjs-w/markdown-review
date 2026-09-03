import {
  DynaActionItemContextSchema,
  DynaActionKindSchema,
  DynaActionRequestSchema,
  DynaActionStateSchema,
  DynaDashboardSchema,
  DynaItemContextSchema,
  DynaPrioritySchema,
  DynaPublishedItemSchema,
  DynaPublisherSchema,
  DynaTaskStatusSchema,
  DynaUiPayloadSchema,
} from "@flowzone/dyna-contracts";
import { DynaService } from "@flowzone/dyna-node";
import { z } from "zod";

import type { FlowZoneAppTool, FlowZonePlugin } from "../plugin.js";

export const DYNA_PLUGIN_ID = "dyna";
export const DYNA_TEMPLATE_URI = "ui://flowzone/dyna/v1.html";

const DashboardIdSchema = z.object({ dashboardId: z.uuid() }).strict();
const ViewTokenSchema = z
  .object({
    viewToken: z.string().min(32).max(128),
    currentRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
const EmptyResultSchema = z.object({ ok: z.literal(true) }).strict();
const DashboardListSchema = z
  .object({ dashboards: z.array(DynaDashboardSchema).max(100) })
  .strict();
const IdentifierSchema = z.string().trim().min(1).max(256);
const ScheduleSchema = z
  .object({
    scheduleId: IdentifierSchema,
    scheduleTitle: z.string().trim().min(1).max(200),
    scheduleState: z.enum(["active", "paused", "unknown"]),
    staleAfterMinutes: z.number().int().min(5).max(43_200).default(1_440),
  })
  .strict();
const CompletionInputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      requestId: z.uuid(),
      claimToken: z.string().min(32).max(128),
      outcome: z.literal("succeeded"),
      task: DynaTaskStatusSchema.optional(),
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      claimToken: z.string().min(32).max(128),
      outcome: z.enum(["failed", "needs_reconciliation"]),
      failureMessage: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
const ReconciliationInputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      requestId: z.uuid(),
      outcome: z.literal("task_linked"),
      task: DynaTaskStatusSchema,
    })
    .strict(),
  z
    .object({
      requestId: z.uuid(),
      outcome: z.literal("no_task_created"),
      explanation: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export interface DynaPluginOptions {
  readonly service?: DynaService;
}

function appTools(service: DynaService): readonly FlowZoneAppTool[] {
  return [
    {
      name: "dyna_get_snapshot",
      title: "Refresh Dyna dashboard",
      description: "Return the newest compiled snapshot for the capability-bound Dyna view.",
      inputSchema: ViewTokenSchema,
      outputSchema: z
        .object({ revision: z.number().int().nonnegative(), changed: z.boolean() })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const { viewToken, currentRevision } = ViewTokenSchema.parse(input);
        const payload = service.refresh(viewToken);
        const changed = currentRevision !== payload.snapshot.revision;
        return {
          structuredContent: { revision: payload.snapshot.revision, changed },
          content: [],
          _meta: { dynaDashboard: payload },
        };
      },
    },
    {
      name: "dyna_add_annotation",
      title: "Add Dyna annotation",
      description: "Add a bounded note to an item in the capability-bound Dyna view.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          body: z.string().trim().min(1).max(1_000),
        })
        .strict(),
      outputSchema: z.object({ annotationId: z.uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      handler(input) {
        const parsed = z
          .object({
            viewToken: z.string().min(32).max(128),
            itemId: z.uuid(),
            body: z.string().trim().min(1).max(1_000),
          })
          .strict()
          .parse(input);
        const annotation = service.store.addAnnotation(
          parsed.viewToken,
          parsed.itemId,
          parsed.body,
        );
        return { structuredContent: { annotationId: annotation.id }, content: [] };
      },
    },
    {
      name: "dyna_prepare_action",
      title: "Prepare Dyna action",
      description:
        "Prepare a short-lived, capability-bound request for the current Codex task to handle.",
      inputSchema: z
        .object({
          viewToken: z.string().min(32).max(128),
          itemId: z.uuid(),
          taskId: IdentifierSchema.optional(),
          taskHostId: IdentifierSchema.optional(),
          kind: DynaActionKindSchema,
          expectedRevision: z.number().int().nonnegative(),
          expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z.string().trim().min(1).max(1_024),
        })
        .strict(),
      outputSchema: z
        .object({ requestId: z.uuid(), expiresAt: z.iso.datetime({ offset: true }) })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      handler(input) {
        const parsed = z
          .object({
            viewToken: z.string().min(32).max(128),
            itemId: z.uuid(),
            taskId: IdentifierSchema.optional(),
            taskHostId: IdentifierSchema.optional(),
            kind: DynaActionKindSchema,
            expectedRevision: z.number().int().nonnegative(),
            expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            idempotencyKey: z.string().trim().min(1).max(1_024),
          })
          .strict()
          .parse(input);
        const request = service.store.prepareAction(parsed.viewToken, parsed.kind, {
          itemId: parsed.itemId,
          ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
          ...(parsed.taskHostId ? { taskHostId: parsed.taskHostId } : {}),
          expectedRevision: parsed.expectedRevision,
          expectedFingerprint: parsed.expectedFingerprint,
          idempotencyKey: parsed.idempotencyKey,
        });
        return {
          structuredContent: { requestId: request.id, expiresAt: request.expiresAt },
          content: [],
        };
      },
    },
    {
      name: "dyna_mark_action_delivered",
      title: "Mark Dyna action delivered",
      description: "Atomically mark a prepared Dyna request ready for one Codex claim.",
      inputSchema: z
        .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
        .strict(),
      outputSchema: z.object({ state: DynaActionStateSchema }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      handler(input) {
        const parsed = z
          .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
          .strict()
          .parse(input);
        const request = service.store.markDelivered(parsed.viewToken, parsed.requestId);
        return { structuredContent: { state: request.state }, content: [] };
      },
    },
    {
      name: "dyna_action_status",
      title: "Read Dyna action status",
      description:
        "Read status metadata for a Dyna request without exposing its completion capability.",
      inputSchema: z
        .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
        .strict(),
      outputSchema: DynaActionRequestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      handler(input) {
        const { viewToken, requestId } = z
          .object({ viewToken: z.string().min(32).max(128), requestId: z.uuid() })
          .strict()
          .parse(input);
        const request = service.store.actionStatusForView(viewToken, requestId);
        return { structuredContent: request, content: [] };
      },
    },
  ];
}

export function createDynaPlugin(options: DynaPluginOptions = {}): FlowZonePlugin {
  const service = options.service ?? new DynaService();
  return {
    id: DYNA_PLUGIN_ID,
    displayName: "Dyna",
    version: "0.1.0",
    actions: [
      {
        id: "create-dashboard",
        title: "Create Dyna dashboard",
        description:
          "Create one persistent executive dashboard that can receive multiple scheduled publishers.",
        inputSchema: z
          .object({
            name: z.string().trim().min(1).max(96),
            description: z.string().trim().max(500).default(""),
          })
          .strict(),
        outputSchema: DynaDashboardSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                name: z.string().trim().min(1).max(96),
                description: z.string().trim().max(500).default(""),
              })
              .strict()
              .parse(input);
            const dashboard = service.store.createDashboard(parsed.name, parsed.description);
            return { result: dashboard };
          },
        },
      },
      {
        id: "update-dashboard",
        title: "Update Dyna dashboard",
        description: "Rename, describe, archive, or restore a Dyna dashboard.",
        inputSchema: z
          .object({
            dashboardId: z.uuid(),
            name: z.string().trim().min(1).max(96).optional(),
            description: z.string().trim().max(500).optional(),
            archived: z.boolean().optional(),
          })
          .strict(),
        outputSchema: DynaDashboardSchema,
        risk: { readOnly: false, destructive: true, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                dashboardId: z.uuid(),
                name: z.string().trim().min(1).max(96).optional(),
                description: z.string().trim().max(500).optional(),
                archived: z.boolean().optional(),
              })
              .strict()
              .parse(input);
            const dashboard = service.store.updateDashboard(parsed.dashboardId, {
              ...(parsed.name !== undefined ? { name: parsed.name } : {}),
              ...(parsed.description !== undefined ? { description: parsed.description } : {}),
              ...(parsed.archived !== undefined ? { archived: parsed.archived } : {}),
            });
            return { result: dashboard };
          },
        },
      },
      {
        id: "list-dashboards",
        title: "List Dyna dashboards",
        description: "List persistent Dyna dashboards and their archive state.",
        inputSchema: z.object({}).strict(),
        outputSchema: DashboardListSchema,
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute() {
            return { result: { dashboards: service.store.listDashboards() } };
          },
        },
      },
      {
        id: "create-publisher",
        title: "Create Dyna schedule publisher",
        description:
          "Create a publisher capability for one scheduled Codex job. The secret is returned once and must be protected.",
        inputSchema: z
          .object({
            name: z.string().trim().min(1).max(96),
            schedule: ScheduleSchema.optional(),
          })
          .strict(),
        outputSchema: z
          .object({ publisher: DynaPublisherSchema, secret: z.string().min(32).max(128) })
          .strict(),
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const { name, schedule } = z
              .object({
                name: z.string().trim().min(1).max(96),
                schedule: ScheduleSchema.optional(),
              })
              .strict()
              .parse(input);
            return {
              result: service.store.createPublisher(
                name,
                schedule
                  ? {
                      id: schedule.scheduleId,
                      title: schedule.scheduleTitle,
                      state: schedule.scheduleState,
                      staleAfterMinutes: schedule.staleAfterMinutes,
                    }
                  : undefined,
              ),
            };
          },
        },
        summarize() {
          return "Created a Dyna schedule publisher. Treat its one-time secret as a credential.";
        },
      },
      {
        id: "bind-schedule",
        title: "Bind schedule to Dyna dashboard",
        description:
          "Bind one scheduled publisher to one dashboard; publishers and dashboards can have many bindings.",
        inputSchema: z
          .object({ dashboardId: z.uuid(), publisherId: z.uuid() })
          .extend(ScheduleSchema.shape)
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({ dashboardId: z.uuid(), publisherId: z.uuid() })
              .extend(ScheduleSchema.shape)
              .strict()
              .parse(input);
            service.store.bindSchedule(parsed.dashboardId, parsed.publisherId, {
              id: parsed.scheduleId,
              title: parsed.scheduleTitle,
              state: parsed.scheduleState,
              staleAfterMinutes: parsed.staleAfterMinutes,
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "list-publishers",
        title: "List Dyna scheduled sources",
        description:
          "List registered native schedule identities and last-run status, optionally for one dashboard.",
        inputSchema: z.object({ dashboardId: z.uuid().optional() }).strict(),
        outputSchema: z.object({ publishers: z.array(DynaPublisherSchema).max(100) }).strict(),
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId } = z
              .object({ dashboardId: z.uuid().optional() })
              .strict()
              .parse(input);
            return { result: { publishers: service.store.listPublishers(dashboardId) } };
          },
        },
      },
      {
        id: "update-schedule-status",
        title: "Update Dyna schedule status",
        description:
          "Reconcile a publisher with the current native Codex schedule title and state.",
        inputSchema: z
          .object({
            publisherId: z.uuid(),
            scheduleTitle: z.string().trim().min(1).max(200).optional(),
            scheduleState: z.enum(["active", "paused", "unknown"]),
            staleAfterMinutes: z.number().int().min(5).max(43_200).optional(),
          })
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                publisherId: z.uuid(),
                scheduleTitle: z.string().trim().min(1).max(200).optional(),
                scheduleState: z.enum(["active", "paused", "unknown"]),
                staleAfterMinutes: z.number().int().min(5).max(43_200).optional(),
              })
              .strict()
              .parse(input);
            service.store.updateScheduleStatus(parsed.publisherId, {
              ...(parsed.scheduleTitle ? { title: parsed.scheduleTitle } : {}),
              state: parsed.scheduleState,
              ...(parsed.staleAfterMinutes ? { staleAfterMinutes: parsed.staleAfterMinutes } : {}),
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "publish-run",
        title: "Publish scheduled Dyna run",
        description:
          "Validate and upsert bounded Slack, Outlook, GitLab, or Codex records from an authenticated scheduled run.",
        inputSchema: z
          .object({
            publisherId: z.uuid(),
            secret: z.string().min(32).max(128),
            runId: IdentifierSchema,
            sourceCompletedAt: z.iso.datetime({ offset: true }),
            mode: z.enum(["replace", "upsert"]).default("replace"),
            status: z.enum(["succeeded", "failed"]).default("succeeded"),
            failureMessage: z.string().trim().min(1).max(500).optional(),
            items: z.array(DynaPublishedItemSchema).max(200),
          })
          .strict(),
        outputSchema: z
          .object({
            accepted: z.number().int().nonnegative().max(200),
            deduplicated: z.boolean(),
            superseded: z.boolean(),
            status: z.enum(["succeeded", "failed"]),
          })
          .strict(),
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                publisherId: z.uuid(),
                secret: z.string().min(32).max(128),
                runId: IdentifierSchema,
                sourceCompletedAt: z.iso.datetime({ offset: true }),
                mode: z.enum(["replace", "upsert"]).default("replace"),
                status: z.enum(["succeeded", "failed"]).default("succeeded"),
                failureMessage: z.string().trim().min(1).max(500).optional(),
                items: z.array(DynaPublishedItemSchema).max(200),
              })
              .strict()
              .parse(input);
            return {
              result: service.publish(parsed.publisherId, parsed.secret, parsed.items, {
                runId: parsed.runId,
                sourceCompletedAt: parsed.sourceCompletedAt,
                mode: parsed.mode,
                status: parsed.status,
                ...(parsed.failureMessage ? { failureMessage: parsed.failureMessage } : {}),
              }),
            };
          },
        },
      },
      {
        id: "apply-enrichment",
        title: "Enrich Dyna item",
        description:
          "Merge additional bounded information into an existing item and increment every bound dashboard revision.",
        inputSchema: z
          .object({
            itemId: z.uuid(),
            summary: z.string().trim().min(1).max(1_000).optional(),
            priority: DynaPrioritySchema.optional(),
            priorityReason: z.string().trim().min(1).max(500).optional(),
            dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
            labels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
            provenance: z.string().trim().min(1).max(128).default("codex-main-chat"),
          })
          .strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = z
              .object({
                itemId: z.uuid(),
                summary: z.string().trim().min(1).max(1_000).optional(),
                priority: DynaPrioritySchema.optional(),
                priorityReason: z.string().trim().min(1).max(500).optional(),
                dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
                labels: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
                provenance: z.string().trim().min(1).max(128).default("codex-main-chat"),
              })
              .strict()
              .parse(input);
            service.store.applyEnrichment(parsed.itemId, {
              ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
              ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
              ...(parsed.priorityReason !== undefined
                ? { priorityReason: parsed.priorityReason }
                : {}),
              ...(parsed.dueAt !== undefined ? { dueAt: parsed.dueAt } : {}),
              ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
              provenance: parsed.provenance,
            });
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "get-item-context",
        title: "Get Dyna item context",
        description:
          "Read the bounded immutable source context for a Dyna item before executing an approved action.",
        inputSchema: z.object({ itemId: z.uuid() }).strict(),
        outputSchema: DynaItemContextSchema,
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { itemId } = z.object({ itemId: z.uuid() }).strict().parse(input);
            return { result: service.store.itemContext(itemId) };
          },
        },
      },
      {
        id: "attach-codex-task",
        title: "Attach Codex task to Dyna item",
        description:
          "Attach controller-observed metadata for an existing Codex task so its status can be shown and refreshed from the dashboard.",
        inputSchema: z.object({ itemId: z.uuid(), task: DynaTaskStatusSchema }).strict(),
        outputSchema: EmptyResultSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
        executor: {
          kind: "module",
          execute(input) {
            const { itemId, task } = z
              .object({ itemId: z.uuid(), task: DynaTaskStatusSchema })
              .strict()
              .parse(input);
            service.store.upsertTaskStatus(itemId, task);
            return { result: { ok: true as const } };
          },
        },
      },
      {
        id: "claim-action",
        title: "Claim Dyna action request",
        description:
          "Claim exactly one delivered, unexpired executive action and receive its immutable context plus one-time completion capability.",
        inputSchema: z.object({ requestId: z.uuid() }).strict(),
        outputSchema: z
          .object({
            request: DynaActionRequestSchema,
            claimToken: z.string().min(32).max(128),
            context: z
              .object({
                item: DynaActionItemContextSchema.optional(),
                task: DynaTaskStatusSchema.optional(),
              })
              .strict(),
          })
          .strict(),
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const { requestId } = z.object({ requestId: z.uuid() }).strict().parse(input);
            return { result: service.store.claimAction(requestId) };
          },
        },
      },
      {
        id: "complete-action",
        title: "Complete Dyna action request",
        description:
          "Complete one claimed request using its one-time capability and optionally link controller-reported Codex task status.",
        inputSchema: CompletionInputSchema,
        outputSchema: DynaActionRequestSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = CompletionInputSchema.parse(input);
            return {
              result: service.store.completeAction(
                parsed.requestId,
                parsed.claimToken,
                parsed.outcome === "succeeded"
                  ? { outcome: parsed.outcome, ...(parsed.task ? { task: parsed.task } : {}) }
                  : { outcome: parsed.outcome, failureMessage: parsed.failureMessage },
              ),
            };
          },
        },
      },
      {
        id: "resolve-action-reconciliation",
        title: "Resolve uncertain Dyna task creation",
        description:
          "Resolve a task-creation request that may have taken effect by linking the verified native task or confirming that no task was created.",
        inputSchema: ReconciliationInputSchema,
        outputSchema: DynaActionRequestSchema,
        risk: { readOnly: false, destructive: false, openWorld: false, idempotent: false },
        executor: {
          kind: "module",
          execute(input) {
            const parsed = ReconciliationInputSchema.parse(input);
            return {
              result: service.store.resolveActionReconciliation(
                parsed.requestId,
                parsed.outcome === "task_linked"
                  ? { outcome: parsed.outcome, task: parsed.task }
                  : { outcome: parsed.outcome, explanation: parsed.explanation },
              ),
            };
          },
        },
      },
      {
        id: "render-dashboard",
        title: "Open Dyna dashboard",
        description:
          "Open one persistent Dyna executive dashboard in its responsive, actionable MCP Apps surface.",
        inputSchema: DashboardIdSchema,
        outputSchema: z
          .object({
            dashboard: DynaDashboardSchema,
            revision: z.number().int().nonnegative(),
            itemCount: z.number().int().nonnegative(),
          })
          .strict(),
        risk: { readOnly: true, destructive: false, openWorld: false, idempotent: false },
        ui: {
          view: "dashboard",
          payloadSchema: DynaUiPayloadSchema,
          legacyMetaKey: "dynaDashboard",
        },
        presentation: { toolName: "render_dyna_dashboard", resourceUri: DYNA_TEMPLATE_URI },
        executor: {
          kind: "module",
          execute(input) {
            const { dashboardId } = DashboardIdSchema.parse(input);
            const payload = service.render(dashboardId);
            return {
              result: {
                dashboard: payload.snapshot.dashboard,
                revision: payload.snapshot.revision,
                itemCount: payload.snapshot.cards.length,
              },
              uiPayload: payload,
            };
          },
        },
        summarize(result) {
          const parsed = z
            .object({ dashboard: DynaDashboardSchema, revision: z.number(), itemCount: z.number() })
            .parse(result);
          return `Opened ${parsed.dashboard.name} with ${String(parsed.itemCount)} items at revision ${String(parsed.revision)}.`;
        },
      },
    ],
    appTools: appTools(service),
  };
}
