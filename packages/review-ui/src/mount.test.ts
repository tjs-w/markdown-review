import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_INLINE_IMAGE_REFERENCES,
  MAX_INLINE_IMAGE_TOTAL_PIXELS,
  type PersistedReviewState,
  type PrivateReviewImageChunk,
  type QueuedFeedback,
  type ReviewDocument,
  type ReviewSubmission,
} from "@markdown-review/contracts";

import { mountMarkdownReview } from "./mount";
import { ReviewPortError } from "./ports";
import type { HostContext, HostContextListener, MarkdownReviewPorts } from "./ports";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const NOW = "2026-08-23T20:00:00.000Z";
const INITIAL_INNER_HEIGHT = window.innerHeight;
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
      <button id="review-actions" aria-expanded="false"></button><button id="comments-toggle"></button><button id="send-all" hidden><span id="send-all-label"></span><span id="send-all-count"></span></button>
      <button id="theme-toggle"></button><button id="refresh"></button></div>
    <span id="launcher-meta"></span>
    <aside id="comments-panel" hidden><button id="close-comments"></button><div id="comments-list"></div></aside>
    <button id="selection-action" hidden></button><button id="open-review"></button>
    <main class="workspace"><article class="markdown" id="document" tabindex="0"></article></main>
    <div id="review-context-menu" role="menu" hidden>
      <button id="context-copy-selection" role="menuitem" data-context-action="copy-selection"></button>
      <button id="context-comment-selection" role="menuitem" data-context-action="comment-selection"></button>
      <button id="context-comment-image" role="menuitem" data-context-action="comment-image"></button>
      <div id="context-selection-separator"></div>
      <button id="context-comment-document" role="menuitem" data-context-action="comment-document"></button>
    </div>
    <section id="review-composer" data-review-ui="composer" hidden><h2 id="composer-title"></h2><button id="close-composer"></button>
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
  readonly writeClipboard?: (text: string) => Promise<void>;
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
    ...(options.writeClipboard ? { clipboard: { writeText: options.writeClipboard } } : {}),
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

function installCanvasContext(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value() {
      return {
        createImageData(width: number, height: number) {
          return { data: new Uint8ClampedArray(width * height * 4) };
        },
        putImageData(): void {
          return undefined;
        },
      };
    },
  });
  return () => {
    if (original) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", original);
    else delete (HTMLCanvasElement.prototype as { getContext?: unknown }).getContext;
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
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

function openContextMenu(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 50,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
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
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: INITIAL_INNER_HEIGHT,
  });
  for (const attribute of ["data-comments-open", "data-display-mode", "data-theme", "data-surface"])
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
    expect(document.querySelectorAll("mark.review-highlight")).toHaveLength(1);
    document.querySelector<HTMLButtonElement>("[data-feedback-annotation]")?.click();
    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    field.value = "Clarify this claim precisely";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add-queue")?.click();
    await settle();
    expect(harness.saves.at(-1)?.queue[0]?.feedback).toBe("Clarify this claim precisely");
    expect(document.querySelectorAll("mark.review-highlight")).toHaveLength(1);
    await queueComment("Follow #1 but keep \\#2 literal", 1);
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(2);
    expect(document.querySelectorAll("mark.review-highlight")).toHaveLength(2);
    document.querySelector<HTMLButtonElement>('.queued-card [data-queue-action="remove"]')?.click();
    expect(document.getElementById("toast-message")?.textContent).toContain("referenced by #2");
    document.getElementById("toast-action")?.click();
    await settle();
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(1);
    expect(document.querySelectorAll("mark.review-highlight")).toHaveLength(1);
    document.getElementById("toast-action")?.click();
    await settle();
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(2);
    expect(document.querySelectorAll("mark.review-highlight")).toHaveLength(2);
    handle.destroy();
    expect(document.querySelector("mark.review-highlight")).toBeNull();
  });

  test("replaces the native menu by default and permits only the flagged Shift bypass", async () => {
    installShell();
    const first = createHarness();
    const production = mountMarkdownReview({
      ports: first.ports,
      initialDocument: reviewDocument,
    });
    await settle();
    const paragraph = document.querySelector("#document p");
    const topbar = document.querySelector(".topbar");
    if (!paragraph || !topbar) throw new Error("Expected context-menu targets");

    const documentMenu = openContextMenu(paragraph);
    expect(documentMenu.defaultPrevented).toBe(true);
    expect(document.getElementById("review-context-menu")?.hidden).toBe(false);
    const outsideMenu = openContextMenu(topbar);
    expect(outsideMenu.defaultPrevented).toBe(true);
    expect(document.getElementById("review-context-menu")?.hidden).toBe(true);
    const productionShift = openContextMenu(paragraph, { shiftKey: true });
    expect(productionShift.defaultPrevented).toBe(true);
    production.destroy();

    installShell();
    const second = createHarness();
    const development = mountMarkdownReview({
      ports: second.ports,
      initialDocument: reviewDocument,
      allowNativeDevTools: true,
    });
    await settle();
    const devParagraph = document.querySelector("#document p");
    if (!devParagraph) throw new Error("Expected development context-menu target");
    const normal = openContextMenu(devParagraph);
    expect(normal.defaultPrevented).toBe(true);
    const bypass = openContextMenu(devParagraph, { shiftKey: true });
    expect(bypass.defaultPrevented).toBe(false);
    expect(document.getElementById("review-context-menu")?.hidden).toBe(true);
    development.destroy();
  });

  test("copies the exact source selection and never copies inserted review UI", async () => {
    installShell();
    const longText = "x".repeat(1_600);
    const copied: string[] = [];
    const longDocument: ReviewDocument = {
      ...reviewDocument,
      lineCount: 1,
      blockCount: 1,
      html: `<section class="review-block" data-start-line="1" data-end-line="1"><p>${longText}</p></section>`,
    };
    const harness = createHarness({
      writeClipboard(text) {
        copied.push(text);
        return Promise.resolve();
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: longDocument });
    await settle();
    const text = document.querySelector("#document p")?.firstChild;
    const paragraph = document.querySelector("#document p");
    if (!(text instanceof Text) || !paragraph) throw new Error("Expected long source text");
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2 }));
    selection?.removeAllRanges();
    openContextMenu(paragraph);
    expect(document.getElementById("context-copy-selection")?.hidden).toBe(false);
    document.getElementById("context-copy-selection")?.click();
    await settle();
    expect(copied).toEqual([longText]);
    expect(document.getElementById("toast-message")?.textContent).toBe("Selected text copied.");

    handle.destroy();
    installShell();
    const stored = persisted([
      queued({ id: "feedback-1", serial: 1, feedback: "Inserted review UI" }),
    ]);
    const restored = createHarness({
      initialState: stored,
      writeClipboard: () => Promise.resolve(),
    });
    const restoredHandle = mountMarkdownReview({
      ports: restored.ports,
      initialDocument: reviewDocument,
    });
    await settle();
    const sourceText = document.querySelector("#document p")?.firstChild?.firstChild;
    const cardText = document.querySelector(".queued-card")?.lastChild;
    const sourceParagraph = document.querySelector("#document p");
    if (!(sourceText instanceof Text) || !cardText || !sourceParagraph) {
      throw new Error("Expected source and queued review UI");
    }
    const crossing = document.createRange();
    crossing.setStart(sourceText, 0);
    crossing.setEndAfter(cardText);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(crossing);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    openContextMenu(sourceParagraph);
    expect(document.getElementById("context-copy-selection")?.hidden).toBe(true);
    expect(document.getElementById("context-comment-selection")?.hidden).toBe(true);
    restoredHandle.destroy();
  });

  test("surfaces clipboard denial without exposing selected content", async () => {
    installShell();
    const harness = createHarness({
      writeClipboard: () => Promise.reject(new Error("sensitive clipboard detail")),
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    selectText();
    const paragraph = document.querySelector("#document p");
    if (!paragraph) throw new Error("Expected review paragraph");
    openContextMenu(paragraph);
    document.getElementById("context-copy-selection")?.click();
    await settle();
    expect(document.getElementById("toast-message")?.textContent).toBe(
      "Could not copy the selected text. Check clipboard permission and try again.",
    );
    expect(document.getElementById("toast-message")?.textContent).not.toContain("First paragraph");
    handle.destroy();
  });

  test("copies a multi-block source selection with its document separator", async () => {
    installShell();
    const copied: string[] = [];
    const harness = createHarness({
      writeClipboard(text) {
        copied.push(text);
        return Promise.resolve();
      },
    });
    const multiBlockDocument: ReviewDocument = {
      ...reviewDocument,
      html:
        '<section class="review-block" data-start-line="1" data-end-line="2"><p>First paragraph for review.</p></section>' +
        '<section class="review-block" data-start-line="3" data-end-line="4"><p>Second paragraph for review.</p></section>',
    };
    const handle = mountMarkdownReview({
      ports: harness.ports,
      initialDocument: multiBlockDocument,
    });
    await settle();
    const paragraphs = document.querySelectorAll("#document p");
    const first = paragraphs[0]?.firstChild;
    const second = paragraphs[1]?.firstChild;
    if (!(first instanceof Text) || !(second instanceof Text)) {
      throw new Error("Expected multi-block source text");
    }
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(second, second.data.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    openContextMenu(paragraphs.item(1));
    document.getElementById("context-copy-selection")?.click();
    await settle();
    expect(copied).toEqual(["First paragraph for review.\nSecond paragraph for review."]);
    handle.destroy();
  });

  test("preserves a pending selection across scroll and keeps its action hidden in the composer", async () => {
    installShell();
    const harness = createHarness();
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    selectText();
    window.dispatchEvent(new Event("scroll"));
    await settle();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        ctrlKey: true,
        key: "m",
        shiftKey: true,
      }),
    );
    expect(document.getElementById("review-composer")?.hidden).toBe(false);
    expect(document.getElementById("quote")?.textContent).toBe("First paragraph for review.");
    await settle();
    expect(document.getElementById("selection-action")?.hidden).toBe(true);
    handle.destroy();
  });

  test("supports keyboard menu navigation and whole-document feedback persistence", async () => {
    installShell();
    const harness = createHarness({ submit: () => Promise.resolve() });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    const actions = document.getElementById("review-actions") as HTMLButtonElement;
    actions.focus();
    actions.click();
    const menu = document.getElementById("review-context-menu");
    const documentItem = document.getElementById("context-comment-document") as HTMLButtonElement;
    expect(menu?.hidden).toBe(false);
    expect(document.activeElement).toBe(documentItem);
    documentItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu?.hidden).toBe(true);
    expect(document.activeElement).toBe(actions);

    selectText();
    const paragraph = document.querySelector("#document p");
    if (!paragraph) throw new Error("Expected keyboard context-menu paragraph");
    openContextMenu(paragraph);
    const copyItem = document.getElementById("context-copy-selection") as HTMLButtonElement;
    const selectionItem = document.getElementById("context-comment-selection") as HTMLButtonElement;
    expect(document.activeElement).toBe(copyItem);
    copyItem.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(selectionItem);
    selectionItem.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(documentItem);
    documentItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(copyItem);
    copyItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(menu?.hidden).toBe(true);
    expect(document.activeElement).toBe(paragraph.closest(".review-block"));

    const surface = document.getElementById("document");
    if (!surface) throw new Error("Expected keyboard document surface");
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    surface.focus();
    surface.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    );
    expect(menu?.hidden).toBe(false);
    documentItem.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.getElementById("review-composer")?.hidden).toBe(false);
    expect(document.getElementById("line-pill")?.textContent).toBe("Whole document");
    expect(document.getElementById("quote")?.hidden).toBe(true);

    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    field.value = "Reorganize the whole document.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add-queue")?.click();
    await settle();
    const saved = harness.saves.at(-1);
    expect(saved?.queue[0]).toMatchObject({
      scope: "document",
      startLine: 1,
      endLine: reviewDocument.lineCount,
      quote: "Whole document: review.md",
    });
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(0);
    expect(document.querySelectorAll("mark.review-highlight")).toHaveLength(0);
    expect(document.querySelector(".document-feedback-group .card-quote")).toBeNull();
    expect(document.querySelector(".document-feedback-group .card-feedback")?.textContent).toBe(
      "Reorganize the whole document.",
    );
    document
      .querySelector<HTMLButtonElement>('.document-feedback-group [data-queue-action="edit"]')
      ?.click();
    expect(document.getElementById("line-pill")?.textContent).toBe("Whole document");
    field.value = "Reorganize the whole document around the conclusion.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add-queue")?.click();
    await settle();
    expect(harness.saves.at(-1)?.queue[0]?.scope).toBe("document");
    document
      .querySelector<HTMLButtonElement>('.document-feedback-group [data-queue-action="remove"]')
      ?.click();
    await settle();
    expect(document.querySelector(".document-feedback-group")).toBeNull();
    document.getElementById("toast-action")?.click();
    await settle();
    expect(document.querySelector(".document-feedback-group")).not.toBeNull();
    document.getElementById("comments-toggle")?.click();
    expect(document.querySelector('[data-comment-action="go"]')?.textContent).toBe(
      "Go to document",
    );
    document.getElementById("comments-toggle")?.click();
    document.getElementById("send-all")?.click();
    await settle(5);
    expect(harness.submissions[0]?.batch.items[0]).toEqual({
      id: "#1",
      refs: [],
      lines: [1, reviewDocument.lineCount],
      quote: "Whole document: review.md",
      comment: "Reorganize the whole document around the conclusion.",
    });
    handle.destroy();
  });

  test("queues whole-document feedback for an empty Markdown file", async () => {
    installShell();
    const emptyDocument: ReviewDocument = {
      ...reviewDocument,
      sizeBytes: 0,
      lineCount: 0,
      blockCount: 0,
      html: "",
    };
    const harness = createHarness();
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: emptyDocument });
    await settle();
    document.getElementById("review-actions")?.click();
    document.getElementById("context-comment-document")?.click();
    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    field.value = "Add an overview.";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add-queue")?.click();
    await settle();
    expect(harness.saves.at(-1)?.queue[0]).toMatchObject({
      scope: "document",
      startLine: 1,
      endLine: 1,
    });
    expect(document.querySelectorAll("[data-feedback-annotation]")).toHaveLength(0);
    handle.destroy();
  });

  test("excludes an adjacent heading when the selection starts at its trailing boundary", async () => {
    installShell();
    const boundaryDocument: ReviewDocument = {
      ...reviewDocument,
      lineCount: 3,
      html:
        '<section class="review-block" data-start-line="1" data-end-line="1"><h2>Review method</h2></section>' +
        '<section class="review-block" data-start-line="3" data-end-line="3"><p>Selected paragraph.</p></section>',
    };
    const harness = createHarness();
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: boundaryDocument });
    await settle();
    const heading = document.querySelector("h2")?.firstChild;
    const paragraph = document.querySelector("p")?.firstChild;
    if (!(heading instanceof Text) || !(paragraph instanceof Text)) {
      throw new Error("Expected boundary-selection fixture");
    }
    const range = document.createRange();
    range.setStart(heading, heading.data.length);
    range.setEnd(paragraph, paragraph.data.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    document.getElementById("selection-action")?.click();

    expect(document.getElementById("line-pill")?.textContent).toBe("Line 3");
    expect(document.getElementById("quote")?.textContent).toBe("Selected paragraph.");
    handle.destroy();
  });

  test("flush waits for queued state persistence before teardown", async () => {
    installShell();
    let finishSave: (() => void) | undefined;
    const pendingSave = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const harness = createHarness({ save: () => pendingSave });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();

    selectText();
    document.getElementById("selection-action")?.click();
    const field = document.getElementById("feedback") as HTMLTextAreaElement;
    field.value = "Persist this before teardown";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    let flushed = false;
    const flush = handle.flush().then(() => {
      flushed = true;
    });
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
    expect(flushed).toBe(false);
    finishSave?.();
    await flush;
    expect(flushed).toBe(true);
    expect(harness.saves.at(-1)?.queue[0]?.feedback).toBe("Persist this before teardown");
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
    expect(document.querySelector("mark.review-highlight")).toBeNull();
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
    document.querySelector<HTMLButtonElement>("[data-feedback-annotation]")?.click();
    const staleFeedback = document.getElementById("feedback") as HTMLTextAreaElement;
    staleFeedback.value = "Reconsider this carefully";
    staleFeedback.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("add-queue")?.click();
    await settle();
    expect(harness.saves.at(-1)?.queue[0]?.revision).toBe("old-revision");
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
    const commentsToggle = document.getElementById("comments-toggle");
    commentsToggle?.click();
    expect(comments.hidden).toBeFalse();
    expect(document.documentElement.dataset["commentsOpen"]).toBe("true");
    expect(commentsToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(commentsToggle?.getAttribute("aria-label")).toBe("Hide 1 review comment");
    expect(document.querySelector<HTMLElement>(".workspace")?.inert).not.toBeTrue();
    commentsToggle?.click();
    expect(comments.hidden).toBeTrue();
    expect(document.documentElement.dataset["commentsOpen"]).toBe("false");
    expect(commentsToggle?.getAttribute("aria-label")).toBe("Show 1 review comment");
    commentsToggle?.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(comments.hidden).toBeTrue();
    expect(document.activeElement).toBe(commentsToggle);
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
      "Opened the review inline",
    );
    expect(document.documentElement.dataset["surface"]).toBe("review");
    harness.emitContext({ displayMode: "inline", theme: "light" });
    expect(document.documentElement.dataset["surface"]).toBe("review");
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
    expect(document.documentElement.dataset["surface"]).toBe("launcher");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1 });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.dataset["surface"]).toBe("launcher");
    document.getElementById("open-review")?.click();
    await settle();
    expect(requests).toHaveLength(2);
    expect(document.getElementById("toast-message")?.textContent).toContain(
      "Opened the review inline",
    );
    expect(document.documentElement.dataset["surface"]).toBe("review");
    harness.emitContext({ displayMode: "inline", theme: "light" });
    expect(document.documentElement.dataset["surface"]).toBe("review");
    await handle.openDocument(reviewDocument);
    await settle();
    expect(requests).toHaveLength(2);
    handle.destroy();
  });

  test("keeps a fullscreen document mounted through transient resize measurements", async () => {
    installShell();
    const harness = createHarness({ context: { displayMode: "fullscreen", theme: "light" } });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    expect(document.documentElement.dataset["surface"]).toBe("review");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1 });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.dataset["surface"]).toBe("review");
    expect(document.querySelector("#document .review-block")).not.toBeNull();
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

  test("rebuilds queued text highlights after refresh", async () => {
    installShell();
    const initialState = persisted([
      queued({ id: "feedback-1", serial: 1, feedback: "Keep this highlighted" }),
    ]);
    const harness = createHarness({
      initialState,
      refresh: () => Promise.resolve({ ...reviewDocument, revision: "next" }),
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: reviewDocument });
    await settle();
    expect(document.querySelector("mark.review-highlight")?.textContent).toBe("First paragraph");

    document.getElementById("refresh")?.click();
    await settle(5);
    expect(document.getElementById("meta")?.textContent).toContain("rev next");
    expect(document.querySelector("mark.review-highlight")?.textContent).toBe("First paragraph");
    handle.destroy();
  });

  test("shows image transport errors and permits retry", async () => {
    installShell();
    let loads = 0;
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="local-image-1" data-alt="Diagram"><span class="local-image-status">Loading image…</span></span></section>',
      images: [
        {
          id: "local-image-1",
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
          imageId: "local-image-1",
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

  test("rejects unexpected image chunk offsets and lengths before decoding", async () => {
    for (const mismatch of [
      { byteOffset: 1, byteLength: 3 },
      { byteOffset: 0, byteLength: 2 },
    ]) {
      installShell();
      let decodes = 0;
      const imageDocument: ReviewDocument = {
        ...reviewDocument,
        html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="local-image-1" data-alt="Diagram"></span></section>',
        images: [
          {
            id: "local-image-1",
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
        loadAssetChunk: () =>
          Promise.resolve({
            kind: "markdown-review-image-chunk",
            reviewSessionId: SESSION,
            revision: imageDocument.revision,
            imageId: "local-image-1",
            imageRevision: "0".repeat(64),
            mimeType: "image/png",
            chunkIndex: 0,
            chunkCount: 1,
            ...mismatch,
            data: "AAAA",
          }),
      });
      const handle = mountMarkdownReview({
        ports: harness.ports,
        initialDocument: imageDocument,
        imageDecoder: {
          decode() {
            decodes += 1;
            return Promise.resolve({
              width: 1,
              height: 1,
              data: Uint8ClampedArray.from([1, 2, 3, 255]),
            });
          },
        },
      });
      await settle(5);
      expect(document.querySelector(".local-image-status")?.textContent).toContain(
        "did not match the review",
      );
      expect(decodes).toBe(0);
      handle.destroy();
    }
  });

  test("does not automatically retry a permanent image transport failure", async () => {
    installShell();
    let loads = 0;
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="local-image-1" data-alt="Diagram"><span class="local-image-status">Loading image…</span></span></section>',
      images: [
        {
          id: "local-image-1",
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
        return Promise.reject(
          new ReviewPortError(
            "server_error",
            "The Markdown review session expired; reopen the review.",
          ),
        );
      },
    });
    const handle = mountMarkdownReview({ ports: harness.ports, initialDocument: imageDocument });
    await settle(5);
    expect(loads).toBe(1);
    expect(document.querySelector(".local-image-status")?.textContent).toContain("session expired");
    handle.destroy();
  });

  test("shares one verified decode across duplicate placeholders and preserves occurrence alts", async () => {
    installShell();
    const restoreCanvas = installCanvasContext();
    const bytes = Uint8Array.from([1, 2, 3]);
    const imageRevision = await sha256Hex(bytes);
    let loads = 0;
    let decodes = 0;
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html:
        '<section class="review-block" data-start-line="1" data-end-line="1">' +
        '<span class="local-image" data-local-image-id="local-image-1" data-alt="First"></span>' +
        '<span class="local-image" data-local-image-id="local-image-1" data-alt="Second"></span></section>',
      images: [
        {
          id: "local-image-1",
          mimeType: "image/png",
          revision: imageRevision,
          modifiedAt: NOW,
          byteLength: bytes.length,
          chunkCount: 1,
          width: 1,
          height: 1,
        },
      ],
    };
    const harness = createHarness({
      loadAssetChunk() {
        loads += 1;
        return Promise.resolve({
          kind: "markdown-review-image-chunk",
          reviewSessionId: SESSION,
          revision: imageDocument.revision,
          imageId: "local-image-1",
          imageRevision,
          mimeType: "image/png",
          chunkIndex: 0,
          chunkCount: 1,
          byteOffset: 0,
          byteLength: bytes.length,
          data: Buffer.from(bytes).toString("base64"),
        });
      },
    });
    const handle = mountMarkdownReview({
      ports: harness.ports,
      initialDocument: imageDocument,
      imageDecoder: {
        decode() {
          decodes += 1;
          return Promise.resolve({
            width: 1,
            height: 1,
            data: Uint8ClampedArray.from([1, 2, 3, 255]),
          });
        },
      },
    });
    try {
      await settle(6);
      expect(loads).toBe(1);
      expect(decodes).toBe(1);
      expect(
        [...document.querySelectorAll("button.image-review-target")].map((target) =>
          target.getAttribute("aria-label"),
        ),
      ).toEqual(["Add feedback for image: First", "Add feedback for image: Second"]);
      expect(
        [...document.querySelectorAll("canvas")].every(
          (canvas) => canvas.getAttribute("aria-hidden") === "true",
        ),
      ).toBe(true);
    } finally {
      handle.destroy();
      restoreCanvas();
    }
  });

  test("queues an image comment and restores its visible target state", async () => {
    installShell();
    const restoreCanvas = installCanvasContext();
    const bytes = Uint8Array.from([1, 2, 3]);
    const imageRevision = await sha256Hex(bytes);
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html:
        '<section class="review-block" data-start-line="1" data-end-line="1">' +
        '<span class="local-image" data-local-image-id="local-image-1" data-alt="Architecture diagram"></span>' +
        '<span class="local-image" data-local-image-id="local-image-1" data-alt="Architecture diagram"></span></section>',
      images: [
        {
          id: "local-image-1",
          mimeType: "image/png",
          revision: imageRevision,
          modifiedAt: NOW,
          byteLength: bytes.length,
          chunkCount: 1,
          width: 1,
          height: 1,
        },
      ],
    };
    const loadAssetChunk = (): Promise<PrivateReviewImageChunk> =>
      Promise.resolve({
        kind: "markdown-review-image-chunk",
        reviewSessionId: SESSION,
        revision: imageDocument.revision,
        imageId: "local-image-1",
        imageRevision,
        mimeType: "image/png",
        chunkIndex: 0,
        chunkCount: 1,
        byteOffset: 0,
        byteLength: bytes.length,
        data: Buffer.from(bytes).toString("base64"),
      });
    const imageDecoder = {
      decode: () =>
        Promise.resolve({
          width: 1,
          height: 1,
          data: Uint8ClampedArray.from([1, 2, 3, 255]),
        }),
    };
    const firstHarness = createHarness({ loadAssetChunk });
    const firstHandle = mountMarkdownReview({
      ports: firstHarness.ports,
      initialDocument: imageDocument,
      imageDecoder,
    });
    try {
      await settle(6);
      const targets = document.querySelectorAll<HTMLButtonElement>(".image-review-target");
      const target = targets[1];
      expect(target?.getAttribute("aria-label")).toBe(
        "Add feedback for image: Architecture diagram",
      );
      if (!target) throw new Error("Expected image review target");
      openContextMenu(target);
      expect(document.getElementById("context-comment-image")?.hidden).toBe(false);
      expect(document.getElementById("context-copy-selection")?.hidden).toBe(true);
      document.getElementById("context-comment-image")?.click();
      expect(document.getElementById("review-composer")?.hidden).toBe(false);
      expect(document.getElementById("quote")?.textContent).toBe("Image: Architecture diagram");
      expect(target.classList.contains("is-selected")).toBe(true);
      const feedback = document.getElementById("feedback") as HTMLTextAreaElement;
      feedback.value = "Increase the diagram labels.";
      feedback.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("add-queue")?.click();
      await settle(4);
      const saved = firstHarness.saves.at(-1);
      expect(saved?.queue[0]?.imageId).toBe("local-image-1");
      expect(saved?.queue[0]?.quote).toBe("Image: Architecture diagram");
      expect(targets[0]?.classList.contains("has-comments")).toBe(false);
      expect(target.classList.contains("has-comments")).toBe(true);
      if (!saved) throw new Error("Expected queued state to be saved");

      firstHandle.destroy();
      installShell();
      const restoredHarness = createHarness({ initialState: saved, loadAssetChunk });
      const restoredHandle = mountMarkdownReview({
        ports: restoredHarness.ports,
        initialDocument: imageDocument,
        imageDecoder,
      });
      try {
        await settle(6);
        const restoredTargets = document.querySelectorAll(".image-review-target");
        expect(restoredTargets[0]?.classList.contains("has-comments")).toBe(false);
        expect(restoredTargets[1]?.classList.contains("has-comments")).toBe(true);
        expect(document.querySelectorAll(".annotation-badge")).toHaveLength(1);
      } finally {
        restoredHandle.destroy();
      }
    } finally {
      firstHandle.destroy();
      restoreCanvas();
    }
  });

  test("enforces the reference limit and shares the raster budget across every valid image", async () => {
    installShell();
    const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 200 });
    const descriptor = {
      id: "local-image-1",
      mimeType: "image/png" as const,
      revision: "0".repeat(64),
      modifiedAt: NOW,
      byteLength: 1,
      chunkCount: 1,
      width: 1,
      height: 1,
    };
    const referenceDocument: ReviewDocument = {
      ...reviewDocument,
      html:
        '<section class="review-block" data-start-line="1" data-end-line="1">' +
        Array.from(
          { length: MAX_INLINE_IMAGE_REFERENCES + 1 },
          (_, index) =>
            `<span class="local-image" data-local-image-id="local-image-1" data-alt="Image ${index + 1}"></span>`,
        ).join("") +
        "</section>",
      images: [descriptor],
    };
    const harness = createHarness();
    const handle = mountMarkdownReview({
      ports: harness.ports,
      initialDocument: referenceDocument,
    });
    try {
      await settle();
      expect(document.querySelectorAll('[data-image-approved="true"]')).toHaveLength(
        MAX_INLINE_IMAGE_REFERENCES,
      );
      expect(document.querySelector(".is-error")?.textContent).toContain(
        `up to ${MAX_INLINE_IMAGE_REFERENCES} local image references`,
      );

      await handle.openDocument({
        ...referenceDocument,
        revision: "pixel-budget",
        html:
          '<section class="review-block" data-start-line="1" data-end-line="1">' +
          Array.from(
            { length: MAX_INLINE_IMAGE_REFERENCES },
            (_, index) =>
              `<span class="local-image" data-local-image-id="local-image-1" data-alt="Large ${index + 1}"></span>`,
          ).join("") +
          "</section>",
        images: [{ ...descriptor, width: 4_000, height: 4_000 }],
      });
      const approved = [...document.querySelectorAll<HTMLElement>('[data-image-approved="true"]')];
      expect(approved).toHaveLength(MAX_INLINE_IMAGE_REFERENCES);
      const rasterPixels = approved.reduce(
        (total, placeholder) =>
          total +
          Number(placeholder.dataset["rasterWidth"]) * Number(placeholder.dataset["rasterHeight"]),
        0,
      );
      expect(rasterPixels).toBeLessThanOrEqual(MAX_INLINE_IMAGE_TOTAL_PIXELS);
      expect(approved.every((placeholder) => Number(placeholder.dataset["rasterWidth"]) > 0)).toBe(
        true,
      );
      expect(document.querySelector(".is-error")).toBeNull();
    } finally {
      handle.destroy();
      if (originalInnerHeight) Object.defineProperty(window, "innerHeight", originalInnerHeight);
      else delete (window as { innerHeight?: number }).innerHeight;
    }
  });

  test("ignores image results superseded by refresh", async () => {
    installShell();
    let resolveChunk: ((chunk: PrivateReviewImageChunk) => void) | undefined;
    const chunkPromise = new Promise<PrivateReviewImageChunk>((resolve) => {
      resolveChunk = resolve;
    });
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="local-image-1" data-alt="Diagram"></span></section>',
      images: [
        {
          id: "local-image-1",
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
      imageId: "local-image-1",
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

  test("does not mutate image placeholders when decoding finishes after destroy", async () => {
    installShell();
    const restoreCanvas = installCanvasContext();
    const bytes = Uint8Array.from([1, 2, 3]);
    const imageRevision = await sha256Hex(bytes);
    let resolveDecode:
      ((decoded: { width: number; height: number; data: Uint8ClampedArray }) => void) | undefined;
    let decodes = 0;
    const decodePromise = new Promise<{
      width: number;
      height: number;
      data: Uint8ClampedArray;
    }>((resolve) => {
      resolveDecode = resolve;
    });
    const imageDocument: ReviewDocument = {
      ...reviewDocument,
      html: '<section class="review-block" data-start-line="1" data-end-line="1"><span class="local-image" data-local-image-id="local-image-1" data-alt="Diagram"></span></section>',
      images: [
        {
          id: "local-image-1",
          mimeType: "image/png",
          revision: imageRevision,
          modifiedAt: NOW,
          byteLength: bytes.length,
          chunkCount: 1,
          width: 1,
          height: 1,
        },
      ],
    };
    const harness = createHarness({
      loadAssetChunk: () =>
        Promise.resolve({
          kind: "markdown-review-image-chunk",
          reviewSessionId: SESSION,
          revision: imageDocument.revision,
          imageId: "local-image-1",
          imageRevision,
          mimeType: "image/png",
          chunkIndex: 0,
          chunkCount: 1,
          byteOffset: 0,
          byteLength: bytes.length,
          data: Buffer.from(bytes).toString("base64"),
        }),
    });
    const handle = mountMarkdownReview({
      ports: harness.ports,
      initialDocument: imageDocument,
      imageDecoder: {
        decode() {
          decodes += 1;
          return decodePromise;
        },
      },
    });
    await settle(5);
    expect(decodes).toBe(1);
    const placeholder = document.querySelector<HTMLElement>(".local-image");
    if (!placeholder) throw new Error("Expected image placeholder");
    handle.destroy();
    const afterDestroy = placeholder.outerHTML;

    resolveDecode?.({
      width: 1,
      height: 1,
      data: Uint8ClampedArray.from([1, 2, 3, 255]),
    });
    await settle(5);
    expect(placeholder.outerHTML).toBe(afterDestroy);
    expect(document.querySelector("canvas.local-image-canvas")).toBeNull();
    restoreCanvas();
  });
});
