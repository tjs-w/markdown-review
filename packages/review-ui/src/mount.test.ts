import { afterEach, describe, expect, test } from "bun:test";
import type {
  PersistedReviewState,
  PrivateReviewImageChunk,
  QueuedFeedback,
  ReviewDocument,
  ReviewSubmission,
} from "@markdown-review/contracts";

import { mountMarkdownReview } from "./mount";
import type { HostContext, HostContextListener, MarkdownReviewPorts } from "./ports";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const NOW = "2026-08-23T20:00:00.000Z";
const reviewDocument: ReviewDocument = {
  kind: "markdown-review-document",
  reviewSessionId: SESSION,
  path: "/tmp/review.md",
  filename: "review.md",
  title: "Review",
  revision: "abc123",
  modifiedAt: NOW,
  sizeBytes: 20,
  lineCount: 4,
  blockCount: 2,
  html:
    '<section class="review-block" data-start-line="1" data-end-line="2"><p>First paragraph for review.</p><a href="https://example.com">Example</a></section>' +
    '<section class="review-block" data-start-line="3" data-end-line="4"><p>Second paragraph for review.</p></section>',
  images: [],
};

function installShell(): void {
  document.body.innerHTML = `
    <div class="topbar"><span id="launcher-count"></span><span id="top-count"></span>
      <button id="comments-toggle"></button><button id="send-all" hidden><span id="send-all-label"></span><span id="send-all-count"></span></button>
      <button id="theme-toggle"></button><button id="refresh"></button></div>
    <span id="launcher-meta"></span>
    <aside id="comments-panel" hidden><button id="close-comments"></button><div id="comments-list"></div></aside>
    <div id="comments-scrim" hidden></div><button id="selection-action" hidden></button><button id="open-review"></button>
    <main class="workspace"><article class="markdown" id="document"></article></main>
    <section id="review-composer" hidden><h2 id="composer-title"></h2><button id="close-composer"></button>
      <button id="composer-help-toggle"></button><div id="composer-help-popover" hidden></div>
      <span id="line-pill"></span><blockquote id="quote"></blockquote><textarea id="feedback"></textarea>
      <p id="feedback-message"></p><button id="add-queue"><span id="add-queue-label"></span></button></section>
    <p id="meta"></p><h1 id="title"></h1><h1 id="launcher-title"></h1>
    <div id="toast"><span id="toast-message"></span><button id="toast-action" hidden></button></div><div id="selection-status"></div>`;
}

function queued(
  overrides: Partial<QueuedFeedback> & Pick<QueuedFeedback, "id" | "serial" | "feedback">,
): QueuedFeedback {
  return {
    id: overrides.id,
    serial: overrides.serial,
    path: overrides.path ?? reviewDocument.path,
    revision: overrides.revision ?? reviewDocument.revision,
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 2,
    anchorX: overrides.anchorX ?? 0.5,
    anchorY: overrides.anchorY ?? 0.5,
    quote: overrides.quote ?? "First paragraph",
    feedback: overrides.feedback,
    createdAt: overrides.createdAt ?? NOW,
  };
}

function persisted(queue: readonly QueuedFeedback[] = []): PersistedReviewState {
  return {
    path: queue.length > 0 ? reviewDocument.path : null,
    theme: "light",
    queue: [...queue],
    nextSerial: queue.reduce((next, item) => Math.max(next, item.serial + 1), 1),
    lastSubmission: null,
    pendingSubmission: null,
  };
}

interface HarnessOptions {
  readonly initialState?: PersistedReviewState | null;
  readonly capabilities?: MarkdownReviewPorts["presentation"]["capabilities"];
  readonly context?: HostContext;
  readonly refresh?: (reviewSessionId: string) => Promise<ReviewDocument>;
  readonly loadAssetChunk?: MarkdownReviewPorts["documents"]["loadAssetChunk"];
  readonly submit?: (submission: ReviewSubmission) => Promise<void>;
  readonly save?: (snapshot: PersistedReviewState) => Promise<void>;
  readonly openExternal?: (url: URL) => Promise<void>;
  readonly requestDisplayMode?: MarkdownReviewPorts["presentation"]["requestDisplayMode"];
}

function createHarness(options: HarnessOptions = {}) {
  const saves: PersistedReviewState[] = [];
  const submissions: ReviewSubmission[] = [];
  const listeners = new Set<HostContextListener>();
  const context = options.context ?? { displayMode: "fullscreen", theme: "light" };
  const ports: MarkdownReviewPorts = {
    documents: {
      refresh: options.refresh ?? (() => Promise.resolve(reviewDocument)),
      loadAssetChunk:
        options.loadAssetChunk ?? (() => Promise.reject(new Error("No images in fixture"))),
    },
    submissions: {
      submit(submission) {
        submissions.push(submission);
        return options.submit?.(submission) ?? Promise.resolve();
      },
    },
    presentation: {
      capabilities: options.capabilities ?? {
        documentTools: true,
        displayMode: true,
        externalLinks: Boolean(options.openExternal),
        submission: true,
      },
      getContext: () => context,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ...(options.openExternal ? { openExternal: options.openExternal } : {}),
      ...(options.requestDisplayMode ? { requestDisplayMode: options.requestDisplayMode } : {}),
    },
    state: {
      load: () => Promise.resolve(options.initialState ?? null),
      save(snapshot) {
        saves.push(structuredClone(snapshot));
        return options.save?.(snapshot) ?? Promise.resolve();
      },
    },
  };
  return {
    ports,
    saves,
    submissions,
    emitContext(next: HostContext) {
      for (const listener of listeners) listener(next);
    },
  };
}

async function settle(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function selectText(blockIndex = 0): void {
  const block = document.querySelectorAll<HTMLElement>(".review-block")[blockIndex];
  const text = block?.querySelector("p")?.firstChild;
  if (!text) throw new Error("Expected review text");
  const range = document.createRange();
  range.selectNodeContents(text);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
}

async function queueComment(feedback: string, blockIndex = 0): Promise<void> {
  selectText(blockIndex);
  document.getElementById("selection-action")?.click();
  const field = document.getElementById("feedback") as HTMLTextAreaElement;
  field.value = feedback;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
}

afterEach(() => {
  document.body.replaceChildren();
  for (const attribute of ["data-display-mode", "data-theme", "data-surface"])
    document.documentElement.removeAttribute(attribute);
});

describe("mountMarkdownReview", () => {
  test("renders, sanitizes host HTML, and blocks unsupported navigation", async () => {
    installShell();
    const hostile: ReviewDocument = {
      ...reviewDocument,
      html:
        '<section class="review-block annotation-badge" data-start-line="1" data-end-line="2" onclick="alert(1)">' +
        '<script>window.pwned=true</script><span class="annotation-badge local-image-status evil" data-alt="safe">Text</span>' +
        '<a class="annotation-badge" href="javascript:alert(1)">Bad</a></section>',
    };
    const harness = createHarness();
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: hostile });
    await settle();
    const block = document.querySelector<HTMLElement>(".review-block");
    expect(block?.className).toBe("review-block");
    expect(block?.hasAttribute("onclick")).toBeFalse();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector(".annotation-badge")).toBeNull();
    expect(document.querySelector(".local-image-status")?.className).toBe("local-image-status");
    const link = document.querySelector<HTMLAnchorElement>("#document a");
    expect(link?.getAttribute("href")).toBeNull();
    link?.click();
    expect(document.getElementById("toast-message")?.textContent).toContain("not available");
    handle.destroy();
  });

  test("delegates allowed external navigation and rejects relative links", async () => {
    installShell();
    const opened: string[] = [];
    const harness = createHarness({
      openExternal: (url) => {
        opened.push(url.href);
        return Promise.resolve();
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    document.querySelector<HTMLAnchorElement>("#document a")?.click();
    await settle();
    expect(opened).toEqual(["https://example.com/"]);
    await handle.openDocument({
      ...reviewDocument,
      revision: "relative",
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><a href="../escape">Relative</a></section>',
    });
    document.querySelector<HTMLAnchorElement>("#document a")?.click();
    expect(document.getElementById("toast-message")?.textContent).toContain("Relative links");
    handle.destroy();
  });

  test("selects, queues, edits, references, removes, and restores feedback", async () => {
    installShell();
    const harness = createHarness();
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    await queueComment("Clarify this claim");
    expect(document.querySelector("[data-feedback-annotation]")?.textContent).toBe("1");
    document.querySelector<HTMLButtonElement>("[data-feedback-annotation]")?.click();
    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    field.value = "Clarify this claim precisely";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add-queue")?.click();
    await settle();
    expect(harness.saves.at(-1)?.queue[0]?.feedback).toBe("Clarify this claim precisely");
    await queueComment("Follow #1 but keep \\#2 literal", 1);
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('.queued-card [data-queue-action="remove"]')?.click();
    expect(document.getElementById("toast-message")?.textContent).toContain("referenced by #2");
    document.getElementById("toast-action")?.click();
    await settle();
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(1);
    document.getElementById("toast-action")?.click();
    await settle();
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(2);
    handle.destroy();
  });

  test("retains failed submissions and reuses their stable retry ID", async () => {
    installShell();
    let attempts = 0;
    const harness = createHarness({
      initialState: persisted([queued({ id: "item-1", serial: 1, feedback: "Please revise" })]),
      submit: () => (++attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve()),
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    document.getElementById("send-all")?.click();
    await settle(5);
    expect(document.getElementById("toast-message")?.textContent).toContain("offline");
    document.getElementById("send-all")?.click();
    await settle(5);
    expect(harness.submissions).toHaveLength(2);
    expect(harness.submissions[1]?.submissionId).toBe(harness.submissions[0]?.submissionId);
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(0);
    handle.destroy();
  });

  test("locks duplicate submit clicks and resets numbering after success", async () => {
    installShell();
    let resolveSubmit: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });
    const harness = createHarness({
      initialState: persisted([queued({ id: "item-1", serial: 7, feedback: "Change it" })]),
      submit: () => pending,
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    const submit = document.getElementById("send-all") as HTMLButtonElement;
    submit.click();
    submit.click();
    await settle();
    expect(harness.submissions).toHaveLength(1);
    expect(submit.disabled).toBeTrue();
    expect(document.getElementById("send-all-label")?.textContent).toBe("Submitting…");
    resolveSubmit?.();
    await settle(6);
    expect(submit.hidden).toBeTrue();
    await queueComment("A fresh round");
    expect(document.querySelector("[data-feedback-annotation]")?.textContent).toBe("1");
    handle.destroy();
  });

  test("fails closed when the stable submission cannot be persisted", async () => {
    installShell();
    const harness = createHarness({
      initialState: persisted([queued({ id: "item-1", serial: 1, feedback: "Change it" })]),
      save: () => Promise.reject(new Error("storage denied")),
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    document.getElementById("send-all")?.click();
    await settle(5);
    expect(harness.submissions).toHaveLength(0);
    expect(document.getElementById("toast-message")?.textContent).toContain("stable submission ID");
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(1);
    handle.destroy();
  });

  test("does not requeue accepted feedback when post-submit cleanup persistence fails", async () => {
    installShell();
    let saveCount = 0;
    const harness = createHarness({
      initialState: persisted([queued({ id: "item-1", serial: 1, feedback: "Accepted feedback" })]),
      save: () => {
        saveCount += 1;
        return saveCount === 1 ? Promise.resolve() : Promise.reject(new Error("cleanup denied"));
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    document.getElementById("send-all")?.click();
    await settle(5);
    expect(harness.submissions).toHaveLength(1);
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(0);
    expect(document.getElementById("toast-message")?.textContent).toContain(
      "local queue cleanup failed",
    );
    handle.destroy();
  });

  test("keeps refresh disabled during a draft and surfaces stale revisions", async () => {
    installShell();
    let refreshes = 0;
    const harness = createHarness({
      initialState: persisted([
        queued({
          id: "old",
          serial: 1,
          revision: "old-revision",
          feedback: "Reconsider this",
        }),
      ]),
      refresh() {
        refreshes += 1;
        return Promise.resolve({ ...reviewDocument, revision: "new-revision" });
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    expect(document.querySelector(".status-chip.warning")?.textContent).toBe("Source changed");
    selectText();
    document.getElementById("selection-action")?.click();
    const refresh = document.getElementById("refresh") as HTMLButtonElement;
    expect(refresh.disabled).toBeTrue();
    refresh.click();
    await settle();
    expect(refreshes).toBe(0);
    const composer = document.getElementById("review-composer");
    if (!composer) throw new Error("Expected review composer");
    expect(composer.hidden).toBeFalse();
    handle.destroy();
  });

  test("inserts indexed references and restores a discarded multiline draft", async () => {
    installShell();
    const harness = createHarness({
      initialState: persisted([queued({ id: "first", serial: 1, feedback: "Original feedback" })]),
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    selectText(1);
    document.getElementById("selection-action")?.click();
    document.getElementById("comments-toggle")?.click();
    const reference = document.querySelector<HTMLButtonElement>(
      '[data-comment-action="reference"]',
    );
    expect(reference?.textContent).toBe("Use #1");
    reference?.click();
    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    const comments = document.getElementById("comments-panel");
    if (!comments) throw new Error("Expected comments overlay");
    expect(field.value).toBe("#1");
    field.value = "Build on #1";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("comments-toggle")?.click();
    expect(comments.hidden).toBeFalse();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(comments.hidden).toBeTrue();
    expect(document.getElementById("review-composer")?.hidden).toBeFalse();
    expect(field.value).toBe("Build on #1");
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(1);
    const help = document.getElementById("composer-help-popover");
    if (!help) throw new Error("Expected review help overlay");
    document.getElementById("composer-help-toggle")?.click();
    expect(help.hidden).toBeFalse();
    field.focus();
    field.dispatchEvent(new FocusEvent("focus"));
    expect(help.hidden).toBeTrue();
    document.getElementById("close-composer")?.click();
    expect(document.getElementById("toast-message")?.textContent).toBe("Draft discarded.");
    document.getElementById("toast-action")?.click();
    expect(field.value).toBe("Build on #1");
    document.getElementById("add-queue")?.click();
    await settle();
    document.getElementById("comments-toggle")?.click();
    const go = document.querySelector<HTMLButtonElement>('[data-comment-action="go"]');
    go?.click();
    expect(comments.hidden).toBeTrue();
    handle.destroy();
  });

  test("warns on an empty Enter and disables submission without a host message capability", async () => {
    installShell();
    const harness = createHarness({
      initialState: persisted([queued({ id: "first", serial: 1, feedback: "Queued" })]),
      capabilities: { documentTools: true, displayMode: true, submission: false },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    const submit = document.getElementById("send-all") as HTMLButtonElement;
    expect(submit.disabled).toBeTrue();
    expect(submit.getAttribute("aria-label")).toContain("unavailable");
    selectText(1);
    document.getElementById("selection-action")?.click();
    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.getElementById("feedback-message")?.textContent).toContain("Write feedback");
    handle.destroy();
  });

  test("honors capability fallbacks and reacts to host theme changes", async () => {
    installShell();
    const harness = createHarness({
      capabilities: {
        documentTools: false,
        displayMode: false,
        externalLinks: false,
        submission: false,
      },
      context: { displayMode: "inline", theme: "light" },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    expect((document.getElementById("refresh") as HTMLButtonElement).disabled).toBeTrue();
    document.getElementById("open-review")?.click();
    expect(document.getElementById("toast-message")?.textContent).toContain(
      "Fullscreen is not available",
    );
    harness.emitContext({ displayMode: "fullscreen", theme: "dark" });
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.getElementById("theme-toggle")?.getAttribute("aria-label")).toBe(
      "Use light theme",
    );
    document.getElementById("theme-toggle")?.click();
    await settle();
    expect(harness.saves.at(-1)?.theme).toBe("light");
    handle.destroy();
  });

  test("reapplies the persisted review theme after loading state", async () => {
    installShell();
    const stored = { ...persisted(), theme: "dark" as const };
    const harness = createHarness({
      initialState: stored,
      context: { displayMode: "fullscreen", theme: "light" },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    handle.destroy();
  });

  test("requests fullscreen once automatically and reports explicit host rejection", async () => {
    installShell();
    const requests: string[] = [];
    const harness = createHarness({
      context: { displayMode: "inline", theme: "light" },
      requestDisplayMode(mode) {
        requests.push(mode);
        return Promise.reject(new Error("denied"));
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    expect(requests).toEqual(["fullscreen"]);
    document.getElementById("open-review")?.click();
    await settle();
    expect(requests).toHaveLength(2);
    expect(document.getElementById("toast-message")?.textContent).toContain(
      "Could not enter fullscreen",
    );
    await handle.openDocument(reviewDocument);
    await settle();
    expect(requests).toHaveLength(2);
    handle.destroy();
  });

  test("refreshes once, preserves the last good document on failure, and renders emptiness", async () => {
    installShell();
    let refreshes = 0;
    const harness = createHarness({
      refresh() {
        refreshes += 1;
        return refreshes === 1
          ? Promise.resolve({ ...reviewDocument, revision: "next", html: "" })
          : Promise.reject(new Error("read failed"));
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    document.getElementById("refresh")?.click();
    await settle(5);
    expect(document.querySelector("#document .empty")?.textContent).toContain("empty");
    document.getElementById("refresh")?.click();
    await settle(5);
    expect(document.getElementById("meta")?.textContent).toContain("read failed");
    expect(document.querySelector("#document .empty")?.textContent).toContain("empty");
    handle.showError(new Error("host error"));
    expect(document.getElementById("meta")?.textContent).toContain("host error");
    handle.destroy();
  });

  test("shows image transport errors and permits retry", async () => {
    installShell();
    let loads = 0;
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="image-1" data-alt="Diagram"><span class="local-image-status">Loading image…</span></span></section>',
      images: [
        {
          id: "image-1",
          mimeType: "image/png",
          revision: "0".repeat(64),
          modifiedAt: NOW,
          byteLength: 3,
          chunkCount: 1,
          width: 1,
          height: 1,
        },
      ],
    };
    const harness = createHarness({
      loadAssetChunk() {
        loads += 1;
        const chunk: PrivateReviewImageChunk = {
          kind: "markdown-review-image-chunk",
          reviewSessionId: SESSION,
          revision: imageDocument.revision,
          imageId: "image-1",
          imageRevision: "0".repeat(64),
          mimeType: "image/png",
          chunkIndex: 0,
          chunkCount: 1,
          byteOffset: 0,
          byteLength: 3,
          data: "***",
        };
        return Promise.resolve(chunk);
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: imageDocument });
    await settle(5);
    expect(document.querySelector(".local-image-status")?.textContent).toContain(
      "altered in transit",
    );
    document.querySelector<HTMLButtonElement>(".image-retry")?.click();
    await settle(5);
    expect(loads).toBe(2);
    handle.destroy();
  });

  test("ignores image results superseded by refresh", async () => {
    installShell();
    let resolveChunk: ((chunk: PrivateReviewImageChunk) => void) | undefined;
    const chunkPromise = new Promise<PrivateReviewImageChunk>((resolve) => {
      resolveChunk = resolve;
    });
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="image-1" data-alt="Diagram"></span></section>',
      images: [
        {
          id: "image-1",
          mimeType: "image/png",
          revision: "0".repeat(64),
          modifiedAt: NOW,
          byteLength: 1,
          chunkCount: 1,
          width: 1,
          height: 1,
        },
      ],
    };
    const harness = createHarness({
      refresh: () => Promise.resolve({ ...reviewDocument, revision: "refreshed" }),
      loadAssetChunk: () => chunkPromise,
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: imageDocument });
    await settle();
    document.getElementById("refresh")?.click();
    await settle();
    resolveChunk?.({
      kind: "markdown-review-image-chunk",
      reviewSessionId: SESSION,
      revision: imageDocument.revision,
      imageId: "image-1",
      imageRevision: "0".repeat(64),
      mimeType: "image/png",
      chunkIndex: 0,
      chunkCount: 1,
      byteOffset: 0,
      byteLength: 1,
      data: "AA==",
    });
    await settle(5);
    expect(document.getElementById("meta")?.textContent).toContain("rev refreshed");
    expect(document.querySelector(".image-retry")).toBeNull();
    handle.destroy();
  });
});
