import { describe, expect, mock, test } from "bun:test";
import type { ReviewDocument } from "@markdown-review/contracts";
import type {
  MarkdownReviewHandle,
  MarkdownReviewPorts,
  MountMarkdownReviewOptions,
  ReviewDiagramRenderer,
  ReviewImageDecoder,
} from "@markdown-review/review-ui";

import { startFlowZoneRuntime } from "./browser-runtime";
import type { McpAppsHost, McpAppsHostOptions } from "./mcp-apps-host";

const documentFixture = {
  kind: "markdown-review-document",
  reviewSessionId: "123e4567-e89b-42d3-a456-426614174000",
  path: "/tmp/review.md",
  filename: "review.md",
  title: "Review",
  revision: "revision",
  modifiedAt: "2026-08-23T20:00:00.000Z",
  sizeBytes: 10,
  lineCount: 1,
  blockCount: 1,
  html: "<p>Review</p>",
  images: [],
} satisfies ReviewDocument;

describe("browser composition runtime", () => {
  test("surfaces errors, retries, hydrates, decodes, tears down, and closes", async () => {
    const hostWindow = window;
    hostWindow.document.body.innerHTML = `
      <div id="launcher"></div>
      <div class="full-surface"></div>
      <main id="flowzone-generic" hidden>
        <h1 id="flowzone-generic-title"></h1>
        <p id="flowzone-generic-message"></p>
      </main>
    `;
    const imageDecoder: ReviewImageDecoder = {
      decode: () => Promise.resolve({ width: 1, height: 1, data: new Uint8ClampedArray(4) }),
    };
    const diagramRenderer = {} as ReviewDiagramRenderer;
    let hostOptions: McpAppsHostOptions | undefined;
    let connectCount = 0;
    let closeCount = 0;
    const ports = {} as MarkdownReviewPorts;
    const createHost = (options: McpAppsHostOptions): McpAppsHost => {
      hostOptions = options;
      return {
        ports,
        connect() {
          connectCount += 1;
          return connectCount === 1
            ? Promise.reject(new Error("connect failed"))
            : Promise.resolve();
        },
        close() {
          closeCount += 1;
          return Promise.resolve();
        },
      };
    };
    const opened: ReviewDocument[] = [];
    const shownErrors: { error: unknown; retry?: () => void }[] = [];
    let flushed = 0;
    let destroyed = 0;
    let mountOptions: MountMarkdownReviewOptions | undefined;
    const handle: MarkdownReviewHandle = {
      openDocument(reviewDocument) {
        opened.push(reviewDocument);
        return Promise.resolve();
      },
      showError(error, retry) {
        shownErrors.push({ error, ...(retry ? { retry } : {}) });
      },
      flush() {
        flushed += 1;
        return Promise.resolve();
      },
      destroy() {
        destroyed += 1;
      },
    };
    const mount = (options: MountMarkdownReviewOptions): MarkdownReviewHandle => {
      mountOptions = options;
      return handle;
    };
    const consoleError = mock(() => undefined);
    const originalConsoleError = console.error;
    console.error = consoleError;
    try {
      const runtime = startFlowZoneRuntime({
        hostWindow,
        createHost,
        imageDecoder,
        diagramRenderer,
        mount,
        allowNativeDevTools: true,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(shownErrors[0]?.error).toEqual(new Error("connect failed"));
      shownErrors[0]?.retry?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(connectCount).toBe(2);
      await hostOptions?.onView?.({
        schema: "flowzone/ui-v1",
        plugin: "markdown-review",
        action: "open",
        view: "review",
        payload: documentFixture,
      });
      expect(opened).toEqual([documentFixture]);
      await hostOptions?.onView?.({
        schema: "flowzone/ui-v1",
        plugin: "fixture",
        action: "run",
        view: "result",
        payload: { title: "Fixture complete", message: "The action completed." },
      });
      expect(hostWindow.document.getElementById("flowzone-generic")?.hidden).toBe(false);
      expect(hostWindow.document.getElementById("flowzone-generic-title")?.textContent).toBe(
        "Fixture complete",
      );
      expect(hostWindow.document.getElementById("flowzone-generic-message")?.textContent).toBe(
        "The action completed.",
      );
      expect(mountOptions?.ports).toBe(ports);
      expect(mountOptions?.allowNativeDevTools).toBe(true);
      expect(mountOptions?.diagramRenderer).toBe(diagramRenderer);
      expect(hostOptions?.submissionFormatter).toBeUndefined();
      expect((await mountOptions?.imageDecoder?.decode(new Uint8Array(), "image/png"))?.width).toBe(
        1,
      );
      hostOptions?.onError?.(new Error("host failed"));
      expect(shownErrors.at(-1)?.error).toEqual(new Error("host failed"));
      await hostOptions?.onTeardown?.();
      expect(flushed).toBe(1);
      expect(destroyed).toBe(1);
      runtime.reconnect();
      expect(connectCount).toBe(3);
      hostWindow.dispatchEvent(new Event("pagehide"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(flushed).toBe(2);
      expect(destroyed).toBe(1);
      expect(closeCount).toBe(1);
    } finally {
      console.error = originalConsoleError;
      hostWindow.document.body.replaceChildren();
    }
  });
});
