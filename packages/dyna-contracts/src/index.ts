import { schema } from "@json-render/react/schema";
import { z } from "zod";

const IdentifierSchema = z.string().trim().min(1).max(256);
const TimestampSchema = z.iso.datetime({ offset: true });

export const DynaSourceSchema = z.enum(["slack", "outlook", "gitlab", "codex"]);
export type DynaSource = z.infer<typeof DynaSourceSchema>;

export const DynaPrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type DynaPriority = z.infer<typeof DynaPrioritySchema>;

export const DynaSourceRefSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("slack"),
      workspaceId: IdentifierSchema,
      channelId: IdentifierSchema,
      messageId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("outlook"),
      accountId: IdentifierSchema,
      messageId: IdentifierSchema,
      conversationId: IdentifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("gitlab"),
      instanceId: IdentifierSchema,
      projectPath: z.string().trim().min(1).max(512),
      iid: z.number().int().positive(),
      entityType: z.enum(["merge_request", "issue", "pipeline"]),
    })
    .strict(),
  z
    .object({
      source: z.literal("codex"),
      taskId: IdentifierSchema,
    })
    .strict(),
]);
export type DynaSourceRef = z.infer<typeof DynaSourceRefSchema>;

export const DynaPublishedItemSchema = z
  .object({
    externalId: IdentifierSchema,
    sourceRef: DynaSourceRefSchema,
    sourceScope: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(1_000),
    priority: DynaPrioritySchema,
    priorityReason: z.string().trim().min(1).max(500),
    sourceUpdatedAt: TimestampSchema,
    dueAt: TimestampSchema.optional(),
    labels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  })
  .strict();
export type DynaPublishedItem = z.infer<typeof DynaPublishedItemSchema>;

export const DynaDashboardSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(96),
    description: z.string().trim().max(500),
    archived: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type DynaDashboard = z.infer<typeof DynaDashboardSchema>;

export const DynaPublisherSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(96),
    scheduleId: IdentifierSchema.optional(),
    scheduleTitle: z.string().trim().min(1).max(200).optional(),
    scheduleState: z.enum(["active", "paused", "unknown"]),
    staleAfterMinutes: z.number().int().min(5).max(43_200),
    lastRunStatus: z.enum(["never", "succeeded", "failed"]),
    lastRunAt: TimestampSchema.optional(),
    lastRunError: z.string().trim().min(1).max(500).optional(),
    createdAt: TimestampSchema,
  })
  .strict();
export type DynaPublisher = z.infer<typeof DynaPublisherSchema>;

export const DynaTaskStateSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "unknown",
]);

export const DynaTaskStatusSchema = z
  .object({
    taskId: IdentifierSchema,
    hostId: IdentifierSchema,
    projectId: IdentifierSchema.optional(),
    title: z.string().trim().min(1).max(200),
    state: DynaTaskStateSchema,
    statusUpdatedAt: TimestampSchema,
    observedAt: TimestampSchema,
  })
  .strict();
export type DynaTaskStatus = z.infer<typeof DynaTaskStatusSchema>;

export const DynaAnnotationSchema = z
  .object({
    id: z.uuid(),
    itemId: z.uuid(),
    body: z.string().trim().min(1).max(1_000),
    createdAt: TimestampSchema,
  })
  .strict();

export const DynaItemContextSchema = DynaPublishedItemSchema.extend({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  enrichment: z
    .object({
      state: z.enum(["active", "stale"]),
      appliedAt: TimestampSchema,
      baseSourceUpdatedAt: TimestampSchema,
      provenance: z.string().trim().min(1).max(128),
    })
    .strict()
    .optional(),
  annotations: z.array(DynaAnnotationSchema).max(20),
}).strict();
export type DynaItemContext = z.infer<typeof DynaItemContextSchema>;

export const DynaActionItemContextSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(200),
    sourceRef: DynaSourceRefSchema,
    sourceUpdatedAt: TimestampSchema,
    annotations: z.array(DynaAnnotationSchema).max(20),
    trustBoundary: z.literal("untrusted_reference_data"),
  })
  .strict();

export const DynaActionKindSchema = z.enum([
  "create_codex_task",
  "open_codex_task",
  "refresh_codex_status",
]);

export const DynaActionStateSchema = z.enum([
  "prepared",
  "delivered",
  "claimed",
  "succeeded",
  "failed",
  "needs_reconciliation",
]);

export const DynaActionRequestSchema = z
  .object({
    id: z.uuid(),
    kind: DynaActionKindSchema,
    itemId: z.uuid().optional(),
    taskId: IdentifierSchema.optional(),
    taskHostId: IdentifierSchema.optional(),
    dashboardRevision: z.number().int().nonnegative(),
    itemFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: DynaActionStateSchema,
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

export const DynaCardSchema = z
  .object({
    id: z.uuid(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    source: DynaSourceSchema,
    title: z.string().max(200),
    summary: z.string().max(1_000),
    priority: DynaPrioritySchema,
    priorityReason: z.string().max(500),
    sourceUpdatedAt: TimestampSchema,
    dueAt: TimestampSchema.optional(),
    labels: z.array(z.string().max(64)).max(20),
    enrichmentState: z.enum(["active", "stale"]).optional(),
    annotations: z.array(DynaAnnotationSchema).max(20),
    linkedTasks: z.array(DynaTaskStatusSchema).max(8),
  })
  .strict();
export type DynaCard = z.infer<typeof DynaCardSchema>;

export const DynaDashboardSnapshotSchema = z
  .object({
    schema: z.literal("dyna/snapshot-v1"),
    dashboard: DynaDashboardSchema,
    generatedAt: TimestampSchema,
    revision: z.number().int().nonnegative(),
    freshness: z.enum(["fresh", "aging", "stale"]),
    counts: z
      .object({
        critical: z.number().int().nonnegative(),
        high: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    schedules: z.array(DynaPublisherSchema).max(50),
    cards: z.array(DynaCardSchema).max(200),
  })
  .strict();
export type DynaDashboardSnapshot = z.infer<typeof DynaDashboardSnapshotSchema>;

export const DynaUiPayloadSchema = z
  .object({
    schema: z.literal("dyna/ui-v1"),
    viewToken: z.string().min(32).max(128),
    snapshot: DynaDashboardSnapshotSchema,
    spec: z.unknown(),
  })
  .strict();
export type DynaUiPayload = z.infer<typeof DynaUiPayloadSchema>;

const ActionDescriptorSchema = z
  .object({
    name: z.enum(["annotate", "create_codex_task", "open_codex_task", "refresh_codex_status"]),
    label: z.string().min(1).max(64),
    taskId: IdentifierSchema.optional(),
    taskHostId: IdentifierSchema.optional(),
  })
  .strict();

export const dynaCatalog = schema.createCatalog({
  components: {
    Dashboard: {
      props: z
        .object({
          dashboardId: z.uuid(),
          name: z.string().max(96),
          description: z.string().max(500),
          freshness: z.enum(["fresh", "aging", "stale"]),
          generatedAt: TimestampSchema,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
      slots: ["default"],
      description: "Top-level executive dashboard surface.",
    },
    SummaryStrip: {
      props: z
        .object({
          critical: z.number().int().nonnegative(),
          high: z.number().int().nonnegative(),
          total: z.number().int().nonnegative(),
        })
        .strict(),
      slots: [],
      description: "Compact counts of urgent and total signals.",
    },
    Section: {
      props: z
        .object({ title: z.string().min(1).max(96), emptyMessage: z.string().max(200) })
        .strict(),
      slots: ["default"],
      description: "A priority group in the dashboard.",
    },
    PriorityCard: {
      props: z
        .object({
          itemId: z.uuid(),
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          source: DynaSourceSchema,
          title: z.string().max(200),
          summary: z.string().max(1_000),
          priority: DynaPrioritySchema,
          priorityReason: z.string().max(500),
          sourceUpdatedAt: TimestampSchema,
          dueAt: TimestampSchema.optional(),
          labels: z.array(z.string().max(64)).max(20),
          enrichmentState: z.enum(["active", "stale"]).optional(),
          annotationCount: z.number().int().nonnegative(),
          annotationPreview: z.array(z.string().trim().min(1).max(1_000)).max(3),
          actions: z.array(ActionDescriptorSchema).min(1).max(2),
        })
        .strict(),
      slots: ["default"],
      description: "One bounded actionable signal from an approved source.",
    },
    TaskStatus: {
      props: DynaTaskStatusSchema.extend({
        itemId: z.uuid(),
        itemFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      }).strict(),
      slots: [],
      description: "Controller-reported metadata for an explicitly linked Codex task.",
    },
    ScheduleStatus: {
      props: DynaPublisherSchema,
      slots: [],
      description: "Native Codex schedule identity and last reported publication status.",
    },
    EmptyState: {
      props: z.object({ message: z.string().min(1).max(200) }).strict(),
      slots: [],
      description: "An empty dashboard or section message.",
    },
  },
  actions: {},
});

export type DynaRenderSpec = typeof dynaCatalog._specType;
