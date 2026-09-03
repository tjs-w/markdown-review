import {
  dynaCatalog,
  type DynaCard,
  type DynaDashboardSnapshot,
  type DynaRenderSpec,
} from "@flowzone/dyna-contracts";

const PRIORITY_ORDER = ["critical", "high", "normal", "low"] as const;

function compareCards(left: DynaCard, right: DynaCard): number {
  const byPriority = PRIORITY_ORDER.indexOf(left.priority) - PRIORITY_ORDER.indexOf(right.priority);
  if (byPriority !== 0) return byPriority;
  const leftDue = left.dueAt ?? "9999";
  const rightDue = right.dueAt ?? "9999";
  const byDue = leftDue.localeCompare(rightDue);
  if (byDue !== 0) return byDue;
  return right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt);
}

function cardActions(card: DynaCard) {
  const linkedTask = card.linkedTasks[0];
  return linkedTask
    ? [
        { name: "annotate" as const, label: "Add note" },
        {
          name: "open_codex_task" as const,
          label: "Open task",
          taskId: linkedTask.taskId,
          taskHostId: linkedTask.hostId,
        },
      ]
    : [
        { name: "annotate" as const, label: "Add note" },
        { name: "create_codex_task" as const, label: "Review in Codex" },
      ];
}

export function compileDashboard(snapshot: DynaDashboardSnapshot): DynaRenderSpec {
  const elements: Record<string, DynaRenderSpec["elements"][string]> = {};
  const sectionKeys: string[] = [];
  elements["summary"] = {
    type: "SummaryStrip",
    props: snapshot.counts,
    children: [],
  };

  if (snapshot.schedules.length > 0) {
    const scheduleChildren: string[] = [];
    for (const schedule of snapshot.schedules) {
      const scheduleKey = `schedule-${schedule.id}`;
      elements[scheduleKey] = { type: "ScheduleStatus", props: schedule, children: [] };
      scheduleChildren.push(scheduleKey);
    }
    elements["section-schedules"] = {
      type: "Section",
      props: { title: "Scheduled sources", emptyMessage: "No schedules are attached." },
      children: scheduleChildren,
    };
    sectionKeys.push("section-schedules");
  }

  for (const priority of PRIORITY_ORDER) {
    const cards = snapshot.cards.filter((card) => card.priority === priority).sort(compareCards);
    if (cards.length === 0) continue;
    const sectionKey = `section-${priority}`;
    const children: string[] = [];
    for (const card of cards) {
      const cardKey = `card-${card.id}`;
      const taskChildren: string[] = [];
      for (const task of card.linkedTasks) {
        const taskKey = `${cardKey}-task-${task.hostId}-${task.taskId}`;
        elements[taskKey] = {
          type: "TaskStatus",
          props: { ...task, itemId: card.id, itemFingerprint: card.fingerprint },
          children: [],
        };
        taskChildren.push(taskKey);
      }
      elements[cardKey] = {
        type: "PriorityCard",
        props: {
          itemId: card.id,
          fingerprint: card.fingerprint,
          source: card.source,
          title: card.title,
          summary: card.summary,
          priority: card.priority,
          priorityReason: card.priorityReason,
          sourceUpdatedAt: card.sourceUpdatedAt,
          ...(card.dueAt ? { dueAt: card.dueAt } : {}),
          labels: card.labels,
          ...(card.enrichmentState ? { enrichmentState: card.enrichmentState } : {}),
          annotationCount: card.annotations.length,
          annotationPreview: card.annotations.slice(0, 3).map((annotation) => annotation.body),
          actions: cardActions(card),
        },
        children: taskChildren,
      };
      children.push(cardKey);
    }
    elements[sectionKey] = {
      type: "Section",
      props: {
        title:
          priority === "normal"
            ? "For your attention"
            : `${priority[0]?.toUpperCase() ?? ""}${priority.slice(1)} priority`,
        emptyMessage: "Nothing in this section.",
      },
      children,
    };
    sectionKeys.push(sectionKey);
  }

  if (snapshot.cards.length === 0) {
    elements["empty"] = {
      type: "EmptyState",
      props: { message: "No signals have been published to this dashboard yet." },
      children: [],
    };
    sectionKeys.push("empty");
  }

  elements["root"] = {
    type: "Dashboard",
    props: {
      dashboardId: snapshot.dashboard.id,
      name: snapshot.dashboard.name,
      description: snapshot.dashboard.description,
      freshness: snapshot.freshness,
      generatedAt: snapshot.generatedAt,
      revision: snapshot.revision,
    },
    children: ["summary", ...sectionKeys],
  };
  const spec = { root: "root", elements } as DynaRenderSpec;
  const validated = dynaCatalog.validate(spec);
  if (!validated.success || !validated.data) {
    throw new Error("The compiled Dyna dashboard did not satisfy its component catalog.");
  }
  return validated.data;
}
