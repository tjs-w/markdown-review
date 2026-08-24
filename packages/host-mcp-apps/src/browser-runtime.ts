import {
  mountMarkdownReview,
  type MarkdownReviewHandle,
  type ReviewImageDecoder,
} from "@markdown-review/review-ui";

import { createBrowserImageDecoder } from "./browser-image-decoder";
import { createMcpAppsHost, type McpAppsHostOptions } from "./mcp-apps-host";

export interface BrowserRuntimeDependencies {
  readonly hostWindow?: Window;
  readonly createHost?: typeof createMcpAppsHost;
  readonly imageDecoder?: ReviewImageDecoder;
  readonly mount?: typeof mountMarkdownReview;
  readonly submissionFormatter?: McpAppsHostOptions["submissionFormatter"];
  readonly allowNativeDevTools?: boolean;
}

export interface MarkdownReviewRuntime {
  readonly handle: MarkdownReviewHandle;
  reconnect(): void;
}

export function startMarkdownReviewRuntime(
  dependencies: BrowserRuntimeDependencies = {},
): MarkdownReviewRuntime {
  const hostWindow = dependencies.hostWindow ?? window;
  const createHost = dependencies.createHost ?? createMcpAppsHost;
  const mount = dependencies.mount ?? mountMarkdownReview;
  const reviewRef: { current?: MarkdownReviewHandle } = {};
  let reviewDestroyed = false;
  let reconnect: () => void = () => undefined;
  const imageDecoder = dependencies.imageDecoder ?? createBrowserImageDecoder(hostWindow);

  const host = createHost({
    hostWindow,
    ...(dependencies.submissionFormatter
      ? { submissionFormatter: dependencies.submissionFormatter }
      : {}),
    async onDocument(reviewDocument) {
      await reviewRef.current?.openDocument(reviewDocument);
    },
    onError(error) {
      console.error("Markdown Review host error", error);
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
    allowNativeDevTools: dependencies.allowNativeDevTools === true,
  });
  reviewRef.current = handle;
  reconnect = () => {
    void host.connect().catch((error: unknown) => {
      console.error("Could not connect Markdown Review to its MCP Apps host", error);
      reviewRef.current?.showError(error, reconnect);
    });
  };
  reconnect();

  hostWindow.addEventListener(
    "pagehide",
    () => {
      void Promise.resolve(reviewRef.current?.flush())
        .catch(() => {
          console.error("Could not flush Markdown Review state before pagehide");
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
