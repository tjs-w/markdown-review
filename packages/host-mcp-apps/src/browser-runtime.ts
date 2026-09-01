import { FlowZoneGenericViewPayloadSchema } from "@flowzone/contracts";
import { ReviewDocumentSchema } from "@markdown-review/contracts";
import {
  mountMarkdownReview,
  type MarkdownReviewHandle,
  type ReviewDiagramRenderer,
  type ReviewImageDecoder,
} from "@markdown-review/review-ui";

import { createBrowserImageDecoder } from "./browser-image-decoder";
import { createMcpAppsHost, type McpAppsHostOptions } from "./mcp-apps-host";
import { createMermaidRenderer } from "./mermaid-renderer";
import { createFlowZoneViewRegistry } from "./view-registry";

export interface BrowserRuntimeDependencies {
  readonly hostWindow?: Window;
  readonly createHost?: typeof createMcpAppsHost;
  readonly imageDecoder?: ReviewImageDecoder;
  readonly diagramRenderer?: ReviewDiagramRenderer;
  readonly mount?: typeof mountMarkdownReview;
  readonly submissionFormatter?: McpAppsHostOptions["submissionFormatter"];
  readonly allowNativeDevTools?: boolean;
}

export interface MarkdownReviewRuntime {
  readonly handle: MarkdownReviewHandle;
  reconnect(): void;
}

export function startFlowZoneRuntime(
  dependencies: BrowserRuntimeDependencies = {},
): MarkdownReviewRuntime {
  const hostWindow = dependencies.hostWindow ?? window;
  const createHost = dependencies.createHost ?? createMcpAppsHost;
  const mount = dependencies.mount ?? mountMarkdownReview;
  const reviewRef: { current?: MarkdownReviewHandle } = {};
  let reviewDestroyed = false;
  let reconnect: () => void = () => undefined;
  const imageDecoder = dependencies.imageDecoder ?? createBrowserImageDecoder(hostWindow);
  const diagramRenderer = dependencies.diagramRenderer ?? createMermaidRenderer(hostWindow);
  const views = createFlowZoneViewRegistry(
    [
      {
        plugin: "markdown-review",
        action: "open",
        view: "review",
        payloadSchema: ReviewDocumentSchema,
        async render(payload) {
          const reviewDocument = ReviewDocumentSchema.parse(payload);
          await reviewRef.current?.openDocument(reviewDocument);
        },
      },
    ],
    (envelope) => {
      if (envelope.view !== "result") return false;
      const payload = FlowZoneGenericViewPayloadSchema.parse(envelope.payload);
      const generic = hostWindow.document.getElementById("flowzone-generic");
      const title = hostWindow.document.getElementById("flowzone-generic-title");
      const message = hostWindow.document.getElementById("flowzone-generic-message");
      if (!generic || !title || !message) {
        throw new Error("The FlowZone generic result view is unavailable.");
      }
      hostWindow.document.getElementById("launcher")?.setAttribute("hidden", "");
      hostWindow.document.querySelector(".full-surface")?.setAttribute("hidden", "");
      title.textContent = payload.title;
      message.textContent = payload.message;
      generic.hidden = false;
      return true;
    },
  );

  const host = createHost({
    hostWindow,
    ...(dependencies.submissionFormatter
      ? { submissionFormatter: dependencies.submissionFormatter }
      : {}),
    async onView(envelope) {
      if (!(await views.dispatch(envelope))) {
        throw new Error(
          `No FlowZone view is registered for ${envelope.plugin}/${envelope.action}/${envelope.view}.`,
        );
      }
    },
    async onDocument(reviewDocument) {
      await reviewRef.current?.openDocument(reviewDocument);
    },
    onError(error) {
      console.error("FlowZone host error", error);
      reviewRef.current?.showError(error, reconnect);
    },
    async onTeardown() {
      await reviewRef.current?.flush();
      if (!reviewDestroyed) {
        reviewDestroyed = true;
        reviewRef.current?.destroy();
      }
    },
  });

  const handle = mount({
    ports: host.ports,
    imageDecoder,
    diagramRenderer,
    allowNativeDevTools: dependencies.allowNativeDevTools === true,
  });
  reviewRef.current = handle;
  reconnect = () => {
    void host.connect().catch((error: unknown) => {
      console.error("Could not connect FlowZone to its MCP Apps host", error);
      reviewRef.current?.showError(error, reconnect);
    });
  };
  reconnect();

  hostWindow.addEventListener(
    "pagehide",
    () => {
      void Promise.resolve(reviewRef.current?.flush())
        .catch(() => {
          console.error("Could not flush the FlowZone view state before pagehide");
        })
        .finally(() => {
          if (!reviewDestroyed) {
            reviewDestroyed = true;
            reviewRef.current?.destroy();
          }
          void host.close();
        });
    },
    { once: true },
  );
  return { handle, reconnect };
}

/** @deprecated Use startFlowZoneRuntime for the universal FlowZone shell. */
export const startMarkdownReviewRuntime = startFlowZoneRuntime;
