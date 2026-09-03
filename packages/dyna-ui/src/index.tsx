import { Badge } from "@openai/apps-sdk-ui/components/Badge";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Textarea } from "@openai/apps-sdk-ui/components/Textarea";
import { applyDocumentTheme } from "@openai/apps-sdk-ui/theme";
import { App, type AppEventMap, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { Renderer, JSONUIProvider, defineRegistry, type Spec } from "@json-render/react";
import { DynaUiPayloadSchema, dynaCatalog, type DynaUiPayload } from "@flowzone/dyna-contracts";
import {
  createContext,
  Children,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";

const STYLE = `
:root { color-scheme: light dark; --d-bg: var(--color-background-primary, #fff); --d-card: var(--color-background-secondary, #f7f7f7); --d-text: var(--color-text-primary, #171717); --d-muted: var(--color-text-secondary, #666); --d-line: var(--color-border-light, #ddd); --d-critical: #d94841; --d-high: #d97706; --d-normal: #2563eb; --d-low: #748094; }
* { box-sizing: border-box; }
html, body, #dyna-root { margin: 0; min-height: 100%; background: var(--d-bg); color: var(--d-text); }
body { font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
button, textarea { font: inherit; }
.dyna { width: min(100%, 760px); margin: 0 auto; padding-top: max(14px, env(safe-area-inset-top), var(--d-safe-top, 0px)); padding-right: max(14px, env(safe-area-inset-right), var(--d-safe-right, 0px)); padding-bottom: max(14px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); padding-left: max(14px, env(safe-area-inset-left), var(--d-safe-left, 0px)); }
.dyna-header { display: grid; gap: 8px; margin-bottom: 14px; }
.dyna-title-row { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.dyna h1 { margin: 0; font-size: clamp(20px, 4vw, 28px); line-height: 1.15; letter-spacing: -.02em; }
.dyna-description, .dyna-meta, .dyna-reason, .dyna-task { color: var(--d-muted); }
.dyna-description { margin: 0; font-size: 14px; }
.dyna-meta { font-size: 12px; }
.dyna-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0 0 18px; }
.dyna-stat { padding: 11px 12px; border: 1px solid var(--d-line); border-radius: 12px; background: var(--d-card); }
.dyna-stat strong { display: block; font-size: 22px; line-height: 1; }
.dyna-stat span { font-size: 11px; color: var(--d-muted); }
.dyna-section { display: grid; gap: 9px; margin: 0 0 20px; }
.dyna-section h2 { margin: 0; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--d-muted); }
.dyna-card { position: relative; overflow: hidden; display: grid; gap: 10px; padding: 14px 14px 14px 18px; border: 1px solid var(--d-line); border-radius: 14px; background: var(--d-card); }
.dyna-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 4px; background: var(--d-priority); }
.dyna-card[data-priority="critical"] { --d-priority: var(--d-critical); }
.dyna-card[data-priority="high"] { --d-priority: var(--d-high); }
.dyna-card[data-priority="normal"] { --d-priority: var(--d-normal); }
.dyna-card[data-priority="low"] { --d-priority: var(--d-low); }
.dyna-card-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dyna-card h3 { margin: 0; font-size: 16px; line-height: 1.3; }
.dyna-card p { margin: 0; font-size: 14px; line-height: 1.45; }
.dyna-reason { padding-left: 10px; border-left: 2px solid var(--d-priority); font-size: 12px !important; }
.dyna-labels, .dyna-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dyna-actions { padding-top: 2px; }
.dyna-task { display: flex; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--d-line); border-radius: 9px; font-size: 12px; }
.dyna-schedule { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--d-line); border-radius: 10px; background: var(--d-card); }
.dyna-schedule strong { overflow-wrap: anywhere; font-size: 13px; }
.dyna-note-list { display: grid; gap: 5px; margin: 0; padding-left: 20px; color: var(--d-muted); font-size: 12px; }
.dyna-connection { position: sticky; top: max(0px, env(safe-area-inset-top), var(--d-safe-top, 0px)); z-index: 20; margin: max(0px, env(safe-area-inset-top), var(--d-safe-top, 0px)) max(10px, env(safe-area-inset-right), var(--d-safe-right, 0px)) 10px max(10px, env(safe-area-inset-left), var(--d-safe-left, 0px)); padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--d-high) 55%, var(--d-line)); border-radius: 10px; background: var(--d-bg); color: var(--d-text); font-size: 13px; }
.dyna-inline-more { margin: 2px 0 0; color: var(--d-muted); font-size: 12px; }
.dyna-empty { padding: 38px 18px; border: 1px dashed var(--d-line); border-radius: 14px; text-align: center; color: var(--d-muted); }
.dyna-dialog { position: fixed; inset: 0; z-index: 50; display: grid; place-items: end center; padding-top: max(14px, env(safe-area-inset-top), var(--d-safe-top, 0px)); padding-right: max(14px, env(safe-area-inset-right), var(--d-safe-right, 0px)); padding-bottom: max(14px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); padding-left: max(14px, env(safe-area-inset-left), var(--d-safe-left, 0px)); background: color-mix(in srgb, #000 35%, transparent); }
.dyna-sheet { width: min(100%, 560px); display: grid; gap: 12px; padding: 16px; border-radius: 16px; background: var(--d-bg); box-shadow: 0 18px 60px #0004; }
.dyna-sheet h2 { margin: 0; font-size: 18px; }
.dyna-sheet-actions { display: flex; justify-content: flex-end; gap: 8px; }
.dyna-toast { position: fixed; right: max(14px, env(safe-area-inset-right), var(--d-safe-right, 0px)); bottom: max(14px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); z-index: 60; max-width: min(360px, calc(100vw - 28px)); padding: 10px 12px; border-radius: 10px; background: var(--d-text); color: var(--d-bg); font-size: 13px; }
@media (max-width: 480px), (pointer: coarse) { .dyna { padding-top: max(10px, env(safe-area-inset-top), var(--d-safe-top, 0px)); padding-right: max(10px, env(safe-area-inset-right), var(--d-safe-right, 0px)); padding-bottom: max(10px, env(safe-area-inset-bottom), var(--d-safe-bottom, 0px)); padding-left: max(10px, env(safe-area-inset-left), var(--d-safe-left, 0px)); } .dyna-summary { gap: 6px; } .dyna-stat { padding: 9px; } .dyna-actions > * { flex: 1 1 auto; } .dyna-actions button, .dyna-task button, .dyna-header button, .dyna-sheet-actions button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
`;

type ActionName = "annotate" | "create_codex_task" | "open_codex_task" | "refresh_codex_status";

type DynaHostContext = McpUiHostContext & {
  readonly locale?: string;
  readonly timeZone?: string;
  readonly platform?: string;
  readonly deviceCapabilities?: McpUiHostContext["deviceCapabilities"] & {
    readonly touch?: boolean;
  };
};

interface DynaUiController {
  annotate(itemId: string, trigger: HTMLElement): void;
  request(
    itemId: string,
    fingerprint: string,
    kind: Exclude<ActionName, "annotate">,
    taskId?: string,
    taskHostId?: string,
  ): Promise<void>;
  readonly busy: boolean;
  readonly displayMode: "inline" | "fullscreen" | "pip";
  readonly canExpand: boolean;
  readonly locale: string;
  expand(): Promise<void>;
}

const ControllerContext = createContext<DynaUiController | null>(null);

function useController(): DynaUiController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("Dyna UI controller is unavailable.");
  return controller;
}

function relativeTime(value: string, locale?: string): string {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

const { registry } = defineRegistry(dynaCatalog, {
  components: {
    Dashboard: ({ props, children }) => {
      const controller = useController();
      return (
        <main className="dyna" data-display-mode={controller.displayMode}>
          <header className="dyna-header">
            <div className="dyna-title-row">
              <div>
                <h1>{props.name}</h1>
                <div className="dyna-meta">
                  Updated {relativeTime(props.generatedAt, controller.locale)} · revision{" "}
                  {props.revision}
                </div>
              </div>
              <Badge
                color={
                  props.freshness === "fresh"
                    ? "success"
                    : props.freshness === "aging"
                      ? "warning"
                      : "danger"
                }
                pill
              >
                {props.freshness}
              </Badge>
            </div>
            {props.description ? <p className="dyna-description">{props.description}</p> : null}
            {controller.displayMode === "inline" && controller.canExpand ? (
              <Button color="secondary" variant="outline" onClick={() => void controller.expand()}>
                Expand dashboard
              </Button>
            ) : null}
          </header>
          {children}
        </main>
      );
    },
    SummaryStrip: ({ props }) => (
      <section className="dyna-summary" aria-label="Dashboard summary">
        <div className="dyna-stat">
          <strong>{props.critical}</strong>
          <span>Critical</span>
        </div>
        <div className="dyna-stat">
          <strong>{props.high}</strong>
          <span>High</span>
        </div>
        <div className="dyna-stat">
          <strong>{props.total}</strong>
          <span>Total</span>
        </div>
      </section>
    ),
    Section: ({ props, children }) => {
      const controller = useController();
      const allChildren = Children.toArray(children);
      const visibleChildren =
        controller.displayMode === "inline" && controller.canExpand
          ? allChildren.slice(0, 3)
          : allChildren;
      return (
        <section className="dyna-section">
          <h2>{props.title}</h2>
          {visibleChildren}
          {visibleChildren.length < allChildren.length ? (
            <p className="dyna-inline-more">
              Expand to see {allChildren.length - visibleChildren.length} more.
            </p>
          ) : null}
        </section>
      );
    },
    PriorityCard: ({ props, children }) => {
      const controller = useController();
      return (
        <article className="dyna-card" data-priority={props.priority}>
          <div className="dyna-card-head">
            <Badge variant="outline" pill>
              {props.source}
            </Badge>
            <Badge
              color={
                props.priority === "critical"
                  ? "danger"
                  : props.priority === "high"
                    ? "warning"
                    : "info"
              }
              pill
            >
              {props.priority}
            </Badge>
            {props.enrichmentState === "stale" ? (
              <Badge color="warning" variant="soft" pill>
                Enrichment needs review
              </Badge>
            ) : null}
            <span className="dyna-meta">
              {relativeTime(props.sourceUpdatedAt, controller.locale)}
            </span>
          </div>
          <h3>{props.title}</h3>
          <p>{props.summary}</p>
          <p className="dyna-reason">{props.priorityReason}</p>
          {props.labels.length > 0 ? (
            <div className="dyna-labels">
              {props.labels.map((label) => (
                <Badge key={label} variant="soft">
                  {label}
                </Badge>
              ))}
            </div>
          ) : null}
          {children}
          {props.annotationPreview.length > 0 ? (
            <ul className="dyna-note-list" aria-label="Recent notes">
              {props.annotationPreview.map((note, index) => (
                <li key={`${index}-${note}`}>{note}</li>
              ))}
            </ul>
          ) : null}
          <div className="dyna-actions">
            {props.actions.map((action) => (
              <Button
                key={action.name}
                data-dyna-annotation-item={action.name === "annotate" ? props.itemId : undefined}
                color={action.name === "create_codex_task" ? "primary" : "secondary"}
                size="sm"
                variant={action.name === "create_codex_task" ? "solid" : "outline"}
                onClick={(event) => {
                  if (action.name === "annotate") {
                    controller.annotate(props.itemId, event.currentTarget);
                  } else
                    void controller.request(
                      props.itemId,
                      props.fingerprint,
                      action.name,
                      action.taskId,
                      action.taskHostId,
                    );
                }}
                disabled={controller.busy}
              >
                {action.label}
              </Button>
            ))}
            {props.annotationCount > 0 ? (
              <span className="dyna-meta">
                {props.annotationCount} note{props.annotationCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </div>
        </article>
      );
    },
    TaskStatus: ({ props }) => {
      const controller = useController();
      return (
        <div className="dyna-task">
          <span>
            {props.title}
            <br />
            <span>
              {props.state} · observed {relativeTime(props.observedAt, controller.locale)}
            </span>
          </span>
          <Button
            color="secondary"
            variant="ghost"
            size="xs"
            onClick={() => {
              void controller.request(
                props.itemId,
                props.itemFingerprint,
                "refresh_codex_status",
                props.taskId,
                props.hostId,
              );
            }}
            disabled={controller.busy}
          >
            Refresh
          </Button>
        </div>
      );
    },
    ScheduleStatus: ({ props }) => {
      const controller = useController();
      return (
        <div className="dyna-schedule">
          <strong>{props.scheduleTitle ?? props.name}</strong>
          <Badge
            color={
              props.lastRunStatus === "failed"
                ? "danger"
                : props.lastRunStatus === "succeeded"
                  ? "success"
                  : "secondary"
            }
            pill
          >
            {props.lastRunStatus}
          </Badge>
          <span className="dyna-meta">
            {props.scheduleState}
            {props.lastRunAt
              ? ` · last run ${relativeTime(props.lastRunAt, controller.locale)}`
              : " · not run yet"}
          </span>
          {props.lastRunError ? <span className="dyna-meta">{props.lastRunError}</span> : null}
        </div>
      );
    },
    EmptyState: ({ props }) => <div className="dyna-empty">{props.message}</div>,
  },
  actions: {},
});

function metadataPayload(value: unknown): DynaUiPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const metadata = (value as Record<string, unknown>)["_meta"];
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const direct = DynaUiPayloadSchema.safeParse(record["dynaDashboard"]);
  if (direct.success) return direct.data;
  const envelope = record["flowzone"];
  if (!envelope || typeof envelope !== "object") return undefined;
  const parsed = DynaUiPayloadSchema.safeParse((envelope as Record<string, unknown>)["payload"]);
  return parsed.success ? parsed.data : undefined;
}

function DynaApp({ app }: { readonly app: App }) {
  const [payload, setPayload] = useState<DynaUiPayload>();
  const [annotationItem, setAnnotationItem] = useState<string>();
  const [annotation, setAnnotation] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen" | "pip">("inline");
  const [canExpand, setCanExpand] = useState(false);
  const [locale, setLocale] = useState(navigator.language);
  const current = useRef<DynaUiPayload | undefined>(undefined);
  const refreshInFlight = useRef(false);
  const hostContext = useRef<DynaHostContext>({});
  const pendingActions = useRef(
    new Map<string, { readonly requestId: string; readonly idempotencyKey: string }>(),
  );
  const annotationTrigger = useRef<HTMLElement | null>(null);
  const annotationFocusAfterSave = useRef<string | undefined>(undefined);
  const dialog = useRef<HTMLDivElement | null>(null);
  current.current = payload;

  const acceptPayload = useCallback((candidate: unknown) => {
    const parsed = DynaUiPayloadSchema.safeParse(candidate);
    if (parsed.success && dynaCatalog.validate(parsed.data.spec).success) {
      setPayload(parsed.data);
      setConnectionError(undefined);
    }
  }, []);

  const refresh = useCallback(async () => {
    const active = current.current;
    if (!active || document.hidden || refreshInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const result = await app.callServerTool({
        name: "dyna_get_snapshot",
        arguments: { viewToken: active.viewToken, currentRevision: active.snapshot.revision },
      });
      const next = metadataPayload(result);
      if (next) acceptPayload(next);
      else setConnectionError(undefined);
    } catch {
      setConnectionError(
        "Dashboard updates are disconnected. Actions are paused until the Remote host reconnects.",
      );
    } finally {
      refreshInFlight.current = false;
    }
  }, [acceptPayload, app]);

  useEffect(() => {
    let timeout: number | undefined;
    const schedule = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      timeout = window.setTimeout(
        () => {
          void refresh().finally(schedule);
        },
        !document.hidden && document.hasFocus() ? 15_000 : 60_000,
      );
    };
    const onForeground = () => {
      if (!document.hidden) void refresh();
      schedule();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    window.addEventListener("blur", schedule);
    schedule();
    return () => {
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
      window.removeEventListener("blur", schedule);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [refresh]);

  useEffect(() => {
    const onToolResult = (result: AppEventMap["toolresult"]) => {
      const next = metadataPayload(result);
      if (next) acceptPayload(next);
    };
    app.addEventListener("toolresult", onToolResult);
    return () => {
      app.removeEventListener("toolresult", onToolResult);
    };
  }, [acceptPayload, app]);

  useEffect(() => {
    const applyContext = (partial: McpUiHostContext) => {
      const context = { ...hostContext.current, ...partial } as DynaHostContext;
      hostContext.current = context;
      const rootData = document.documentElement.dataset as DOMStringMap & {
        locale?: string;
        timeZone?: string;
        platform?: string;
        touch?: string;
      };
      if (context.theme === "light" || context.theme === "dark") applyDocumentTheme(context.theme);
      setDisplayMode(context.displayMode ?? "inline");
      setCanExpand(context.availableDisplayModes?.includes("fullscreen") ?? false);
      if (context.locale) {
        document.documentElement.lang = context.locale;
        rootData.locale = context.locale;
        setLocale(context.locale);
      }
      if (context.timeZone) rootData.timeZone = context.timeZone;
      const dimensions = context.containerDimensions;
      const width = dimensions && "width" in dimensions ? dimensions.width : dimensions?.maxWidth;
      if (width) document.documentElement.style.setProperty("--d-host-width", `${String(width)}px`);
      rootData.platform = context.platform ?? "unknown";
      rootData.touch = String(context.deviceCapabilities?.touch ?? false);
      const safe = context.safeAreaInsets;
      const rootStyle = document.documentElement.style;
      rootStyle.setProperty("--d-safe-top", `${String(safe?.top ?? 0)}px`);
      rootStyle.setProperty("--d-safe-right", `${String(safe?.right ?? 0)}px`);
      rootStyle.setProperty("--d-safe-bottom", `${String(safe?.bottom ?? 0)}px`);
      rootStyle.setProperty("--d-safe-left", `${String(safe?.left ?? 0)}px`);
    };
    app.addEventListener("hostcontextchanged", applyContext);
    void app
      .connect()
      .then(() => {
        const context = app.getHostContext();
        if (context) applyContext(context);
        setConnectionError(undefined);
      })
      .catch(() => {
        setConnectionError(
          "Could not connect to the Remote host. Dashboard actions are unavailable.",
        );
      });
    return () => {
      app.removeEventListener("hostcontextchanged", applyContext);
    };
  }, [app]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => {
      setToast(undefined);
    }, 4_000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    const itemId = annotationFocusAfterSave.current;
    if (!itemId || busy || annotationItem) return;
    annotationFocusAfterSave.current = undefined;
    const currentTrigger = annotationTrigger.current;
    const trigger =
      currentTrigger?.isConnected &&
      currentTrigger.getAttribute("data-dyna-annotation-item") === itemId
        ? currentTrigger
        : [...document.querySelectorAll<HTMLElement>("[data-dyna-annotation-item]")].find(
            (element) => element.getAttribute("data-dyna-annotation-item") === itemId,
          );
    trigger?.focus();
  }, [annotationItem, busy, payload]);

  const closeAnnotation = useCallback(() => {
    setAnnotationItem(undefined);
    window.setTimeout(() => {
      annotationTrigger.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (!annotationItem) return;
    const modal = dialog.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAnnotation();
        return;
      }
      if (event.key !== "Tab" || !modal) return;
      const focusable = [
        ...modal.querySelectorAll<HTMLElement>("textarea, button:not([disabled])"),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [annotationItem, closeAnnotation]);

  const controller = useMemo<DynaUiController>(
    () => ({
      busy,
      displayMode,
      canExpand,
      locale,
      annotate(itemId, trigger) {
        annotationTrigger.current = trigger;
        setAnnotationItem(itemId);
      },
      async expand() {
        await app.requestDisplayMode({ mode: "fullscreen" });
      },
      async request(itemId, fingerprint, kind, taskId, taskHostId) {
        const active = current.current;
        if (!active || busy || connectionError) return;
        setBusy(true);
        const actionKey = [
          active.snapshot.dashboard.id,
          active.snapshot.revision,
          itemId,
          fingerprint,
          kind,
          taskId ?? "",
          taskHostId ?? "",
        ].join(":");
        try {
          let pending = pendingActions.current.get(actionKey);
          if (!pending) {
            const idempotencyKey = `${actionKey}:${crypto.randomUUID()}`;
            const prepared = await app.callServerTool({
              name: "dyna_prepare_action",
              arguments: {
                viewToken: active.viewToken,
                itemId,
                kind,
                ...(taskId ? { taskId } : {}),
                ...(taskHostId ? { taskHostId } : {}),
                expectedRevision: active.snapshot.revision,
                expectedFingerprint: fingerprint,
                idempotencyKey,
              },
            });
            const structured = prepared.structuredContent as Record<string, unknown> | undefined;
            const preparedId = structured?.["requestId"];
            if (typeof preparedId !== "string") throw new Error("No action request was prepared.");
            pending = { requestId: preparedId, idempotencyKey };
            pendingActions.current.set(actionKey, pending);
          }
          const requestId = pending.requestId;
          const delivery = await app.callServerTool({
            name: "dyna_mark_action_delivered",
            arguments: { viewToken: active.viewToken, requestId },
          });
          const deliveryState = (
            delivery.structuredContent as Record<string, unknown> | undefined
          )?.["state"];
          if (
            ["claimed", "succeeded", "failed", "needs_reconciliation"].includes(
              String(deliveryState),
            )
          ) {
            if (deliveryState !== "claimed") pendingActions.current.delete(actionKey);
            setToast(
              deliveryState === "claimed"
                ? "Codex is handling this request."
                : deliveryState === "needs_reconciliation"
                  ? "Review required before another task-creation attempt."
                  : `This request is already ${String(deliveryState).replaceAll("_", " ")}.`,
            );
            return;
          }
          const send = () =>
            app.sendMessage({
              role: "user",
              content: [
                { type: "text", text: `Handle Dyna action request ${requestId} with $dyna.` },
              ],
            });
          const sent = await send();
          if (sent.isError) {
            const status = await app.callServerTool({
              name: "dyna_action_status",
              arguments: { viewToken: active.viewToken, requestId },
            });
            const state = (status.structuredContent as Record<string, unknown> | undefined)?.[
              "state"
            ];
            if (state === "delivered") {
              const retried = await send();
              if (retried.isError) throw new Error("Action delivery remains uncertain.");
            } else if (state === "claimed" || state === "succeeded") {
              if (state === "succeeded") pendingActions.current.delete(actionKey);
              setToast("Codex is handling this request.");
              return;
            } else if (state === "failed" || state === "needs_reconciliation") {
              pendingActions.current.delete(actionKey);
              setToast(
                state === "needs_reconciliation"
                  ? "Review required before another task-creation attempt."
                  : "The request failed. Try again.",
              );
              return;
            } else {
              throw new Error("The action request could not be reconciled.");
            }
          }
          setToast("Request sent to Codex.");
          pendingActions.current.delete(actionKey);
          setConnectionError(undefined);
        } catch {
          setConnectionError(
            "Action delivery is uncertain. Reconnect, then retry; Dyna will reuse the same request.",
          );
        } finally {
          setBusy(false);
        }
      },
    }),
    [app, busy, canExpand, connectionError, displayMode, locale],
  );

  async function saveAnnotation(): Promise<void> {
    const active = current.current;
    if (!active || !annotationItem || !annotation.trim() || busy || connectionError) return;
    setBusy(true);
    try {
      await app.callServerTool({
        name: "dyna_add_annotation",
        arguments: { viewToken: active.viewToken, itemId: annotationItem, body: annotation.trim() },
      });
      setAnnotation("");
      annotationFocusAfterSave.current = annotationItem;
      setAnnotationItem(undefined);
      setToast("Note added.");
      await refresh();
    } catch {
      setConnectionError("Could not save the note. Reconnect to the Remote host and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!payload) {
    return (
      <main className="dyna">
        {connectionError ? (
          <div className="dyna-connection" role="alert">
            {connectionError}
          </div>
        ) : null}
        <div className="dyna-empty">Loading dashboard…</div>
      </main>
    );
  }
  return (
    <ControllerContext.Provider value={controller}>
      {connectionError ? (
        <div className="dyna-connection" role="alert">
          {connectionError}
        </div>
      ) : null}
      <div
        inert={annotationItem !== undefined ? true : undefined}
        aria-hidden={annotationItem ? true : undefined}
      >
        <JSONUIProvider registry={registry}>
          <Renderer spec={payload.spec as Spec} registry={registry} />
        </JSONUIProvider>
      </div>
      {annotationItem ? (
        <div
          ref={dialog}
          className="dyna-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="annotation-title"
        >
          <div className="dyna-sheet">
            <h2 id="annotation-title">Add an executive note</h2>
            <label htmlFor="dyna-annotation">Note</label>
            <Textarea
              id="dyna-annotation"
              value={annotation}
              rows={4}
              maxLength={1_000}
              placeholder="Example: Create a new Codex task to review this MR"
              onChange={(event) => {
                setAnnotation(event.currentTarget.value);
              }}
              autoFocus
            />
            <div className="dyna-sheet-actions">
              <Button color="secondary" variant="ghost" onClick={closeAnnotation}>
                Cancel
              </Button>
              <Button
                color="primary"
                loading={busy}
                disabled={!annotation.trim() || Boolean(connectionError)}
                onClick={() => void saveAnnotation()}
              >
                Save note
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="dyna-toast" role="status">
          {toast}
        </div>
      ) : null}
    </ControllerContext.Provider>
  );
}

const style = document.createElement("style");
style.textContent = STYLE;
document.head.append(style);

const rootElement = document.querySelector<HTMLElement>("#dyna-root");
if (!rootElement) throw new Error("Dyna root element is missing.");
const app = new App({ name: "FlowZone Dyna", version: "0.1.0" });
createRoot(rootElement).render(<DynaApp app={app} />);
