import {
  IMAGE_CHUNK_BYTES,
  MAX_CLIPBOARD_TEXT_LENGTH,
  MAX_INLINE_IMAGE_REFERENCES,
  MAX_INLINE_IMAGE_TOTAL_PIXELS,
  type PrivateReviewImageChunk,
  type QueuedFeedback,
  type ReviewDocument,
  type ReviewImageDescriptor,
  type ReviewSelection,
} from "@markdown-review/contracts";
import {
  completeReviewSubmission,
  createReviewRoundState,
  extractCommentReferences,
  normalizePersistedReviewState,
  parseCommentFeedback,
  prepareReviewSubmission,
  queueFeedback,
  removeQueuedFeedback,
  retainFailedReviewSubmission,
  updateQueuedFeedback,
  type ReviewRoundState,
} from "@markdown-review/core";

import type {
  DecodedReviewImage,
  DisplayMode,
  MarkdownReviewHandle,
  MountMarkdownReviewOptions,
  ReviewTheme,
} from "./ports";
import { assembleImageChunks } from "./image-assembly";
import { ReviewPortError, shouldRetryPortError } from "./ports";
import {
  captureReviewTextAnchor,
  clearReviewHighlights,
  findReviewHighlightBlock,
  renderReviewHighlights,
} from "./review-highlights";

const IMAGE_WORKERS = 2;
const CHUNK_WORKERS = 4;
const MAX_QUEUE_ITEMS = 20;
const MAX_MERMAID_DIAGRAMS = 12;
const MAX_MERMAID_SOURCE_BYTES = 32 * 1024;
const MAX_MERMAID_TOTAL_SOURCE_BYTES = 128 * 1024;
const MAX_MERMAID_TOTAL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MERMAID_TOTAL_ELEMENTS = 20_000;
const DOCUMENT_UPDATE_CHECK_INTERVAL_MS = 3_000;

interface ActiveSelection extends ReviewSelection {
  readonly block: HTMLElement;
}

type SelectionDirection = "forward" | "backward";
type SubmissionIntent = "submit" | "review";

interface ContextMenuSnapshot {
  readonly selection: ActiveSelection | null;
  readonly copyText: string | null;
  readonly range?: Range | null;
  readonly direction?: SelectionDirection;
}

interface ActiveLoad {
  readonly reviewSessionId: string;
  readonly generation: number;
  readonly promise: Promise<boolean>;
}

interface ComposerDraftSnapshot {
  readonly path: string;
  readonly selection: ReviewSelection;
  readonly feedback: string;
  readonly editingId: string | null;
  readonly sourceRevision: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface ActiveRecovery {
  readonly reviewSessionId: string;
  readonly generation: number;
  readonly promise: Promise<boolean>;
}

interface RasterCandidate {
  readonly placeholder: HTMLElement;
  readonly image: ReviewImageDescriptor;
  readonly pixels: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExpiredSessionError(error: unknown): boolean {
  return error instanceof ReviewPortError && error.serverCode === "session_expired";
}

function clamp(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function allocateRasterPixelBudgets(pixelCounts: readonly number[]): number[] {
  const allocations = new Array<number>(pixelCounts.length).fill(0);
  const ordered = pixelCounts
    .map((pixels, index) => ({ index, pixels }))
    .sort((left, right) => left.pixels - right.pixels);
  let remainingPixels = MAX_INLINE_IMAGE_TOTAL_PIXELS;
  for (let position = 0; position < ordered.length; position += 1) {
    const entry = ordered[position];
    if (!entry) break;
    const remainingImages = ordered.length - position;
    const fairShare = Math.floor(remainingPixels / remainingImages);
    if (entry.pixels <= fairShare) {
      allocations[entry.index] = entry.pixels;
      remainingPixels -= entry.pixels;
      continue;
    }
    for (let offset = position; offset < ordered.length; offset += 1) {
      const pending = ordered[offset];
      if (!pending) continue;
      allocations[pending.index] =
        fairShare + (offset - position < remainingPixels % remainingImages ? 1 : 0);
    }
    break;
  }
  return allocations;
}

function fitRasterDimensions(
  width: number,
  height: number,
  maximumPixels: number,
): { readonly width: number; readonly height: number } {
  if (!Number.isSafeInteger(maximumPixels) || maximumPixels < 1) {
    throw new Error("The image raster budget is invalid");
  }
  const naturalPixels = width * height;
  if (naturalPixels <= maximumPixels) return { width, height };
  const scale = Math.sqrt(maximumPixels / naturalPixels);
  let outputWidth = Math.max(1, Math.floor(width * scale));
  let outputHeight = Math.max(1, Math.floor(height * scale));
  while (outputWidth * outputHeight > maximumPixels) {
    if (outputWidth / width >= outputHeight / height) outputWidth -= 1;
    else outputHeight -= 1;
  }
  return { width: outputWidth, height: outputHeight };
}

function makeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `review-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function lineLabel(
  selection: Pick<ReviewSelection, "startLine" | "endLine" | "scope"> | null,
): string {
  if (!selection) return "No selection";
  if (selection.scope === "document") return "Whole document";
  return selection.startLine === selection.endLine
    ? `Line ${selection.startLine}`
    : `Lines ${selection.startLine}–${selection.endLine}`;
}

function documentKey(document: ReviewDocument): string {
  return `${document.path}\n${document.revision}\n${document.reviewSessionId}`;
}

const REVIEW_TAGS = new Set([
  "A",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "DETAILS",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "INPUT",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SPAN",
  "STRONG",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

function sanitizeReviewHtml(root: Document, html: string): DocumentFragment {
  const template = root.createElement("template");
  template.innerHTML = html;
  for (const element of [...template.content.querySelectorAll("*")]) {
    if (!REVIEW_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const attributes = [...element.attributes];
    for (const attribute of attributes) element.removeAttribute(attribute.name);
    const source = attributes.find((attribute) => attribute.name === "href")?.value;
    const className = attributes.find((attribute) => attribute.name === "class")?.value ?? "";
    const classTokens = className.split(/\s+/).filter(Boolean);
    const allowedClasses =
      element.tagName === "SECTION"
        ? classTokens.filter((token) => token === "review-block")
        : element.tagName === "SPAN"
          ? classTokens.filter((token) =>
              ["local-image", "image-notice", "local-image-status"].includes(token),
            )
          : element.tagName === "CODE"
            ? classTokens.filter((token) => /^language-[a-z0-9_+-]{1,80}$/i.test(token))
            : [];
    if (allowedClasses.length > 0) element.className = allowedClasses.join(" ");
    if (element.tagName === "SECTION") {
      for (const name of ["data-start-line", "data-end-line"] as const) {
        const value = attributes.find((attribute) => attribute.name === name)?.value;
        if (value && /^[1-9]\d{0,8}$/.test(value)) element.setAttribute(name, value);
      }
    } else if (element.tagName === "SPAN") {
      for (const name of ["data-local-image-id", "data-alt", "role", "aria-label"] as const) {
        const value = attributes.find((attribute) => attribute.name === name)?.value;
        if (value) element.setAttribute(name, value.slice(0, 1_400));
      }
      const style = attributes.find((attribute) => attribute.name === "style")?.value;
      const aspectRatio = /(?:^|;)\s*aspect-ratio\s*:\s*(\d{1,5})\s*\/\s*(\d{1,5})\s*(?:;|$)/i.exec(
        style ?? "",
      );
      if (aspectRatio)
        element.setAttribute("style", `aspect-ratio:${aspectRatio[1]}/${aspectRatio[2]}`);
    } else if (element.tagName === "A" && source) {
      if (source.startsWith("#")) element.setAttribute("href", source);
      else {
        element.setAttribute("data-review-href", source.slice(0, 4_096));
        element.setAttribute("role", "link");
        element.setAttribute("tabindex", "0");
      }
      const title = attributes.find((attribute) => attribute.name === "title")?.value;
      if (title) element.setAttribute("title", title.slice(0, 512));
    } else if (element.tagName === "INPUT") {
      element.setAttribute("type", "checkbox");
      element.setAttribute("disabled", "");
      if (attributes.some((attribute) => attribute.name === "checked")) {
        element.setAttribute("checked", "");
      }
    } else if (element.tagName === "OL") {
      const start = attributes.find((attribute) => attribute.name === "start")?.value;
      if (start && /^-?\d{1,8}$/.test(start)) element.setAttribute("start", start);
    } else if (element.tagName === "TD" || element.tagName === "TH") {
      const align = attributes.find((attribute) => attribute.name === "align")?.value;
      if (align && ["left", "center", "right"].includes(align))
        element.setAttribute("align", align);
    }
  }
  for (const checkbox of template.content.querySelectorAll<HTMLInputElement>(
    'li > input[type="checkbox"]',
  )) {
    checkbox.classList.add("task-checkbox");
    const item = checkbox.parentElement;
    if (item?.tagName !== "LI") continue;
    const taskText = item.textContent.trim().slice(0, 512);
    checkbox.setAttribute(
      "aria-label",
      `${taskText || "Task"} (${checkbox.checked ? "completed" : "not completed"})`,
    );
    item.classList.add("task-list-item");
    if (item.parentElement?.tagName === "UL") item.parentElement.classList.add("task-list");
  }
  return template.content;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Secure image verification is unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function withRetry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown = new Error("Operation failed");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts && shouldRetryPortError(error)) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 80 * attempt);
        });
      } else {
        break;
      }
    }
  }
  throw lastError;
}

class MarkdownReviewController implements MarkdownReviewHandle {
  readonly #root: Document;
  readonly #view: Window & typeof globalThis;
  readonly #ports: MountMarkdownReviewOptions["ports"];
  readonly #imageDecoder: MountMarkdownReviewOptions["imageDecoder"];
  readonly #diagramRenderer: MountMarkdownReviewOptions["diagramRenderer"];
  readonly #allowNativeDevTools: boolean;
  #document: ReviewDocument | null = null;
  #lastGoodDocument: ReviewDocument | null = null;
  #round: ReviewRoundState;
  #pendingSelection: ActiveSelection | null = null;
  #selectionCopyText: string | null = null;
  #selectionRange: Range | null = null;
  #selectionDirection: SelectionDirection = "forward";
  #selectionFrame: number | undefined;
  #selectionFrameNeedsCapture = false;
  #secondarySelection: ContextMenuSnapshot | null = null;
  #contextSelection: ActiveSelection | null = null;
  #contextCopyText: string | null = null;
  #contextRange: Range | null = null;
  #contextSelectionDirection: SelectionDirection = "forward";
  #contextImageTarget: HTMLButtonElement | null = null;
  #contextMenuReturnFocus: HTMLElement | null = null;
  #selection: ActiveSelection | null = null;
  #editingId: string | null = null;
  #selectionRevision: string | null = null;
  #generation = 0;
  #diagramRun = 0;
  #diagramAbort: AbortController | null = null;
  #diagramRenderScheduled = false;
  #renderKey: string | null = null;
  #activeLoad: ActiveLoad | null = null;
  #activeRecovery: ActiveRecovery | null = null;
  #decodedImages = new Map<string, Promise<DecodedReviewImage>>();
  #fullscreenRequestedFor: string | null = null;
  #inlineReviewFallback = false;
  #sendingIds = new Set<string>();
  #returnFocus: HTMLElement | null = null;
  #lastSelectionAnnouncement: string | null = null;
  #copyOperation = 0;
  #manualCopyDialog: HTMLElement | null = null;
  #manualCopyReturnFocus: HTMLElement | null = null;
  #submissionMenuReturnFocus: HTMLElement | null = null;
  #compositionActive = false;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
  #documentUpdateCheckTimer: ReturnType<typeof setTimeout> | undefined;
  #documentUpdateCheckInFlight = false;
  #documentUpdateAvailable = false;
  #saveChain: Promise<void> = Promise.resolve();
  #documentBusy = false;
  #destroyed = false;
  #unsubscribePresentation: () => void;
  readonly #abort = new AbortController();

  constructor(options: MountMarkdownReviewOptions) {
    this.#root = options.root ?? document;
    this.#view = this.#root.defaultView ?? window;
    this.#ports = options.ports;
    this.#imageDecoder = options.imageDecoder;
    this.#diagramRenderer = options.diagramRenderer;
    this.#allowNativeDevTools = options.allowNativeDevTools === true;
    this.#round = createReviewRoundState(
      normalizePersistedReviewState(null, new Date().toISOString()),
    );
    this.#unsubscribePresentation = this.#ports.presentation.subscribe((context) => {
      this.#applyTheme(context.theme);
      this.#root.documentElement.dataset["displayMode"] = context.displayMode;
      this.#syncSurfaceLayout();
    });
    this.#installListeners();
    const context = this.#ports.presentation.getContext();
    this.#applyTheme(context.theme);
    this.#root.documentElement.dataset["displayMode"] = context.displayMode;
    this.#syncSurfaceLayout();
  }

  async start(initialDocument: ReviewDocument | undefined): Promise<void> {
    if (initialDocument) await this.openDocument(initialDocument);
  }

  flush(): Promise<void> {
    return this.#saveChain;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#diagramRun += 1;
    this.#diagramAbort?.abort();
    this.#diagramAbort = null;
    this.#abort.abort();
    this.#decodedImages.clear();
    this.#unsubscribePresentation();
    clearReviewHighlights(this.#element("document"));
    this.#closeContextMenu(false);
    this.#closeSubmissionMenu(false);
    this.#element("document").querySelector("[data-review-ui='session-recovery']")?.remove();
    if (this.#selectionFrame !== undefined) {
      this.#view.cancelAnimationFrame(this.#selectionFrame);
      this.#selectionFrame = undefined;
    }
    if (this.#toastTimer !== undefined) clearTimeout(this.#toastTimer);
    if (this.#documentUpdateCheckTimer !== undefined) clearTimeout(this.#documentUpdateCheckTimer);
    this.#closeManualCopy(false);
  }

  showError(error: unknown, retry?: () => void): void {
    if (!this.#destroyed) this.#showLoadError(error, retry);
  }

  async openDocument(reviewDocument: ReviewDocument): Promise<void> {
    if (this.#destroyed) return;
    const generation = ++this.#generation;
    this.#setBusy(true);
    try {
      const persisted = await this.#ports.state.load({
        reviewSessionId: reviewDocument.reviewSessionId,
        path: reviewDocument.path,
        revision: reviewDocument.revision,
      });
      if (generation !== this.#generation || this.#destroyed) return;
      this.#round = createReviewRoundState(
        normalizePersistedReviewState(persisted, new Date().toISOString()),
      );
      this.#applyTheme(this.#round.persisted.theme);
      this.#renderDocument(reviewDocument, generation);
    } catch (error) {
      if (generation !== this.#generation || this.#destroyed) return;
      this.#showLoadError(error);
    } finally {
      if (generation === this.#generation) {
        this.#setBusy(false);
        this.#scheduleDocumentUpdateCheck();
      }
    }
  }

  #element<T extends HTMLElement>(id: string): T {
    const element = this.#root.getElementById(id);
    if (!(element instanceof this.#view.HTMLElement))
      throw new Error(`Missing Markdown Review element #${id}`);
    return element as T;
  }

  #currentDisplayMode(): DisplayMode {
    const mode = this.#root.documentElement.dataset["displayMode"];
    return mode === "fullscreen" || mode === "pip" ? mode : "inline";
  }

  #currentTheme(): ReviewTheme {
    return this.#root.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
  }

  #reviewSurfaceVisible(): boolean {
    return this.#root.documentElement.dataset["surface"] === "review";
  }

  #scrollBehavior(): ScrollBehavior {
    return this.#view.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  #toast(
    message: string,
    options: { readonly actionLabel?: string; readonly onAction?: () => void } = {},
  ): void {
    const toast = this.#element("toast");
    const action = this.#element<HTMLButtonElement>("toast-action");
    this.#element("toast-message").textContent = message;
    action.hidden = !options.actionLabel;
    action.textContent = options.actionLabel ?? "";
    action.onclick =
      options.actionLabel && options.onAction
        ? () => {
            if (this.#toastTimer !== undefined) clearTimeout(this.#toastTimer);
            toast.classList.remove("show");
            action.hidden = true;
            options.onAction?.();
          }
        : null;
    toast.classList.add("show");
    if (this.#toastTimer !== undefined) clearTimeout(this.#toastTimer);
    this.#toastTimer = undefined;
    if (!options.actionLabel) {
      this.#toastTimer = setTimeout(() => {
        toast.classList.remove("show");
        action.hidden = true;
      }, 2600);
    }
  }

  #setBusy(busy: boolean): void {
    this.#documentBusy = busy;
    this.#element("document").setAttribute("aria-busy", String(busy));
    const refreshDisabled =
      busy ||
      !this.#element("review-composer").hidden ||
      this.#ports.presentation.capabilities.documentTools === false;
    this.#element<HTMLButtonElement>("refresh").disabled = refreshDisabled;
    this.#element<HTMLButtonElement>("document-update-refresh").disabled = refreshDisabled;
  }

  #setMeta(message: string, error = false): void {
    const meta = this.#element("meta");
    meta.textContent = message;
    meta.classList.toggle("error", error);
    meta.setAttribute("role", error ? "alert" : "status");
  }

  #showDocumentUpdateAvailable(): void {
    this.#documentUpdateAvailable = true;
    const indicator = this.#element("document-update-indicator");
    indicator.hidden = false;
  }

  #dismissDocumentUpdate(): void {
    this.#element("document-update-indicator").hidden = true;
  }

  #clearDocumentUpdate(): void {
    this.#documentUpdateAvailable = false;
    this.#element("document-update-indicator").hidden = true;
  }

  #showLoadError(error: unknown, retry?: () => void): void {
    const message = `Could not load the review: ${errorMessage(error)}`;
    this.#setMeta(message, true);
    if (!this.#lastGoodDocument) {
      const surface = this.#element("document");
      const empty = this.#root.createElement("div");
      empty.className = "empty error";
      empty.setAttribute("role", "alert");
      empty.textContent = message;
      if (retry) {
        const button = this.#root.createElement("button");
        button.type = "button";
        button.className = "button";
        button.textContent = "Retry";
        button.addEventListener("click", retry, { once: true });
        empty.append(this.#root.createElement("br"), button);
      }
      surface.replaceChildren(empty);
    }
  }

  #closeManualCopy(restoreFocus = true): void {
    const dialog = this.#manualCopyDialog;
    const returnFocus = this.#manualCopyReturnFocus;
    this.#manualCopyDialog = null;
    this.#manualCopyReturnFocus = null;
    const field = dialog?.querySelector<HTMLTextAreaElement>("textarea");
    if (field) field.value = "";
    dialog?.remove();
    if (restoreFocus && returnFocus?.isConnected && !returnFocus.hidden) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  #openManualCopy(text: string, returnFocus: HTMLElement | null): void {
    this.#closeManualCopy(false);
    const dialog = this.#root.createElement("section");
    dialog.className = "manual-copy-dialog";
    dialog.dataset["reviewUi"] = "manual-copy";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "manual-copy-title");
    dialog.setAttribute("aria-describedby", "manual-copy-instructions");

    const panel = this.#root.createElement("div");
    panel.className = "manual-copy-panel";
    const title = this.#root.createElement("h2");
    title.id = "manual-copy-title";
    title.textContent = "Copy selected text";
    const instructions = this.#root.createElement("p");
    instructions.id = "manual-copy-instructions";
    instructions.textContent =
      "Clipboard permission is blocked. Press Command+C or Control+C to copy the selected text.";
    const field = this.#root.createElement("textarea");
    field.className = "manual-copy-field";
    field.readOnly = true;
    field.setAttribute("aria-label", "Selected Markdown text");
    field.value = text;
    const close = this.#root.createElement("button");
    close.type = "button";
    close.className = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => {
      this.#closeManualCopy();
    });
    panel.append(title, instructions, field, close);
    dialog.appendChild(panel);
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.#closeManualCopy();
        return;
      }
      if (event.key !== "Tab") return;
      const controls: HTMLElement[] = [field, close];
      const current = controls.indexOf(this.#root.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (current - 1 + controls.length) % controls.length
        : (current + 1) % controls.length;
      event.preventDefault();
      controls[next]?.focus();
    });
    this.#manualCopyDialog = dialog;
    this.#manualCopyReturnFocus = returnFocus;
    this.#root.body.appendChild(dialog);
    field.focus();
    field.setSelectionRange(0, field.value.length);
  }

  #applyTheme(theme: ReviewTheme): void {
    const changed = this.#root.documentElement.dataset["theme"] !== theme;
    this.#root.documentElement.dataset["theme"] = theme;
    const toggle = this.#element<HTMLButtonElement>("theme-toggle");
    const useDark = theme === "light";
    toggle.title = useDark ? "Use dark theme" : "Use light theme";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(theme === "dark"));
    if (changed && this.#document && !this.#destroyed) this.#scheduleMermaidRender();
  }

  #scheduleMermaidRender(): void {
    if (this.#diagramRenderScheduled) return;
    this.#diagramRenderScheduled = true;
    queueMicrotask(() => {
      this.#diagramRenderScheduled = false;
      if (!this.#destroyed) void this.#installMermaidDiagrams(this.#generation);
    });
  }

  #syncSurfaceLayout(): void {
    const wasVisible = this.#reviewSurfaceVisible();
    const shouldShow = this.#inlineReviewFallback || this.#currentDisplayMode() !== "inline";
    this.#root.documentElement.dataset["surface"] = shouldShow ? "review" : "launcher";
    if (wasVisible !== shouldShow && this.#document) {
      void this.#installLocalImages(this.#document, this.#generation);
      this.#ports.presentation.notifyIntrinsicHeight?.(this.#root.documentElement.scrollHeight);
    }
  }

  #allComments(): QueuedFeedback[] {
    return [...this.#round.persisted.queue]
      .filter((item) => item.path === this.#document?.path)
      .sort((left, right) => left.serial - right.serial);
  }

  #itemIsStale(item: QueuedFeedback): boolean {
    return Boolean(
      item.revision && this.#document?.revision && item.revision !== this.#document.revision,
    );
  }

  #imageQuote(target: HTMLElement): string {
    return `Image: ${target.dataset["alt"] || "Local Markdown image"}`.slice(0, 1400);
  }

  #imageAnchorPosition(
    target: HTMLButtonElement,
    block: HTMLElement,
  ): Pick<ReviewSelection, "anchorX" | "anchorY"> {
    const rect = target.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    if (blockRect.width > 0 && blockRect.height > 0 && (rect.width > 0 || rect.height > 0)) {
      return {
        anchorX: clamp((rect.left + rect.width / 2 - blockRect.left) / blockRect.width, 0.96),
        anchorY: clamp((rect.top + rect.height / 2 - blockRect.top) / blockRect.height, 0.5),
      };
    }
    const targets = [...block.querySelectorAll<HTMLButtonElement>("button.image-review-target")];
    const index = Math.max(0, targets.indexOf(target));
    return { anchorX: 0.5, anchorY: (index + 0.5) / Math.max(1, targets.length) };
  }

  #closestImageTarget(
    candidates: readonly HTMLButtonElement[],
    selection: ReviewSelection,
  ): HTMLButtonElement | null {
    const scored = candidates
      .map((target) => {
        const block = target.closest<HTMLElement>(".review-block");
        if (!block) return null;
        const position = this.#imageAnchorPosition(target, block);
        return {
          target,
          distance: Math.hypot(
            position.anchorX - selection.anchorX,
            position.anchorY - selection.anchorY,
          ),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.distance - right.distance);
    const first = scored[0];
    const second = scored[1];
    if (!first || (second && Math.abs(first.distance - second.distance) < 0.000_001)) return null;
    return first.target;
  }

  #findImageTarget(
    selection: ReviewSelection,
    preferredBlock: HTMLElement | null = null,
    stale = false,
  ): HTMLButtonElement | null {
    if (!selection.imageId) return null;
    const candidates = [
      ...this.#root.querySelectorAll<HTMLButtonElement>("button.image-review-target"),
    ].filter((target) => target.dataset["localImageId"] === selection.imageId);
    if (candidates.length === 0) return null;
    const quoteMatches = candidates.filter(
      (target) => !selection.quote || this.#imageQuote(target) === selection.quote,
    );
    const eligible = quoteMatches.length > 0 ? quoteMatches : candidates;
    if (preferredBlock) {
      const preferred = eligible.filter((target) => preferredBlock.contains(target));
      if (preferred.length === 1) return preferred[0] ?? null;
      if (!stale && preferred.length > 1) return this.#closestImageTarget(preferred, selection);
    }
    const lineMatches = eligible.filter((target) => {
      const block = target.closest<HTMLElement>(".review-block");
      const start = Number(block?.dataset["startLine"]);
      const end = Number(block?.dataset["endLine"]);
      return (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        selection.startLine >= start &&
        selection.startLine <= end
      );
    });
    if (lineMatches.length === 1) return lineMatches[0] ?? null;
    if (!stale && lineMatches.length > 1) return this.#closestImageTarget(lineMatches, selection);
    if (stale && quoteMatches.length === 1) return quoteMatches[0] ?? null;
    return eligible.length === 1 ? (eligible[0] ?? null) : null;
  }

  #syncImageTargetState(target: HTMLButtonElement): void {
    target.classList.toggle(
      "has-comments",
      this.#round.persisted.queue.some(
        (item) =>
          item.path === this.#document?.path &&
          this.#findImageTarget(
            item,
            target.closest<HTMLElement>(".review-block"),
            this.#itemIsStale(item),
          ) === target,
      ),
    );
  }

  #syncImageTargetStates(): void {
    this.#root
      .querySelectorAll<HTMLButtonElement>("button.image-review-target")
      .forEach((target) => {
        this.#syncImageTargetState(target);
      });
  }

  #findAnchorBlock(item: QueuedFeedback): HTMLElement | null {
    if (item.scope === "document") return this.#element("document");
    const blocks = [...this.#root.querySelectorAll<HTMLElement>(".review-block")];
    const imageTarget = this.#findImageTarget(item, null, this.#itemIsStale(item));
    const imageBlock = imageTarget?.closest<HTMLElement>(".review-block") ?? null;
    if (imageBlock) return imageBlock;
    const resolved = findReviewHighlightBlock(this.#element("document"), {
      ...item,
      stale: this.#itemIsStale(item),
    });
    if (resolved) return resolved;
    if (this.#itemIsStale(item) && item.quote) {
      const quote = item.quote.replace(/\s+/g, " ").trim().toLowerCase();
      const relocated = blocks.filter((block) =>
        block.innerText.replace(/\s+/g, " ").trim().toLowerCase().includes(quote),
      );
      if (relocated.length === 1) return relocated[0] ?? null;
    }
    return (
      blocks.find((block) => {
        const start = Number(block.dataset["startLine"]);
        const end = Number(block.dataset["endLine"]);
        return item.startLine >= start && item.startLine <= end;
      }) ??
      blocks.find((block) => Number(block.dataset["startLine"]) >= item.startLine) ??
      blocks.at(-1) ??
      null
    );
  }

  #createQueuedGroup(items: readonly QueuedFeedback[]): HTMLElement {
    const first = items[0];
    if (!first) throw new Error("A queued feedback group requires at least one item");
    const group = this.#root.createElement("section");
    group.className = "queued-group";
    group.classList.toggle("document-feedback-group", first.scope === "document");
    group.dataset["reviewUi"] = "queue-group";
    group.setAttribute("aria-label", `Queued feedback for ${lineLabel(first)}`);
    for (const item of items) {
      const card = this.#root.createElement("article");
      card.className = "queued-card";
      card.dataset["feedbackId"] = item.id;
      const labelId = `queued-comment-label-${item.serial}`;
      card.setAttribute("aria-labelledby", labelId);

      const head = this.#root.createElement("div");
      head.className = "card-head";
      const label = this.#root.createElement("span");
      label.className = "card-label";
      label.id = labelId;
      label.textContent = `Comment ${item.serial} · ${lineLabel(item)}`;
      head.appendChild(label);
      if (this.#itemIsStale(item)) {
        const stale = this.#root.createElement("span");
        stale.className = "status-chip warning";
        stale.textContent = "Source changed";
        head.appendChild(stale);
      }

      const quote = this.#root.createElement("div");
      quote.className = "card-quote";
      quote.textContent = item.quote || "Markdown passage";
      const feedback = this.#root.createElement("div");
      feedback.className = "card-feedback";
      feedback.textContent = parseCommentFeedback(item.feedback).text;
      const actions = this.#root.createElement("div");
      actions.className = "card-actions";
      for (const [actionName, text, className] of [
        ["edit", "Edit", "button"],
        ["remove", "Remove", "button danger"],
      ] as const) {
        const button = this.#root.createElement("button");
        button.type = "button";
        button.className = className;
        button.dataset["queueAction"] = actionName;
        button.textContent = text;
        button.disabled = this.#sendingIds.size > 0;
        button.setAttribute("aria-label", `${text} for comment ${item.serial}, ${lineLabel(item)}`);
        actions.appendChild(button);
      }
      if (item.scope === "document") card.append(head, feedback, actions);
      else card.append(head, quote, feedback, actions);
      group.appendChild(card);
    }
    return group;
  }

  #renderQueueCards(): void {
    this.#root
      .querySelectorAll("[data-review-ui='queue-group'], [data-review-ui='annotation']")
      .forEach((element) => {
        element.remove();
      });
    this.#root.querySelectorAll(".review-block.has-comments").forEach((element) => {
      element.classList.remove("has-comments");
    });
    this.#root.querySelectorAll(".image-review-target.has-comments").forEach((element) => {
      element.classList.remove("has-comments");
    });
    const currentItems = this.#round.persisted.queue.filter(
      (item) => item.path === this.#document?.path,
    );
    renderReviewHighlights(
      this.#element("document"),
      currentItems.map((item) => ({ ...item, stale: this.#itemIsStale(item) })),
    );
    const groups = new Map<HTMLElement, QueuedFeedback[]>();
    const documentItems: QueuedFeedback[] = [];
    const stacks = new Map<HTMLElement, Map<number, number>>();
    for (const item of this.#round.persisted.queue) {
      if (item.path !== this.#document?.path) continue;
      if (item.scope === "document") {
        documentItems.push(item);
        continue;
      }
      const block = this.#findAnchorBlock(item);
      if (!block) continue;
      this.#findImageTarget(item, block, this.#itemIsStale(item))?.classList.add("has-comments");
      block.classList.add("has-comments");
      const stackKey = Math.round(item.anchorY * 20);
      const blockStacks = stacks.get(block) ?? new Map<number, number>();
      const stackIndex = blockStacks.get(stackKey) ?? 0;
      blockStacks.set(stackKey, stackIndex + 1);
      stacks.set(block, blockStacks);

      const badge = this.#root.createElement("button");
      badge.type = "button";
      badge.className = "annotation-badge";
      badge.dataset["reviewUi"] = "annotation";
      badge.dataset["feedbackAnnotation"] = item.id;
      badge.textContent = String(item.serial);
      badge.style.top = `calc(${item.anchorY * 100}% + ${stackIndex * 22}px)`;
      badge.classList.toggle("is-stale", this.#itemIsStale(item));
      badge.disabled = this.#sendingIds.size > 0;
      badge.title = `Comment ${item.serial}: ${parseCommentFeedback(item.feedback).text.slice(0, 160)}`;
      badge.setAttribute(
        "aria-label",
        `Edit queued comment ${item.serial} for ${lineLabel(item)}${this.#itemIsStale(item) ? "; source changed" : ""}`,
      );
      block.appendChild(badge);
      const groupItems = groups.get(block) ?? [];
      groupItems.push(item);
      groups.set(block, groupItems);
    }

    if (documentItems.length > 0) {
      this.#element("document").prepend(this.#createQueuedGroup(documentItems));
    }
    for (const [block, items] of groups) {
      block.insertAdjacentElement("afterend", this.#createQueuedGroup(items));
    }
    this.#updateQueueUi();
  }

  #renderCommentsPanel(): void {
    const list = this.#element("comments-list");
    list.replaceChildren();
    const comments = this.#allComments();
    if (comments.length === 0) {
      const empty = this.#root.createElement("div");
      empty.className = "empty";
      empty.setAttribute("role", "listitem");
      empty.textContent = "No comments yet. Select text or choose an image to add one.";
      list.appendChild(empty);
      return;
    }
    for (const item of comments) {
      const entry = this.#root.createElement("article");
      entry.className = "comment-index-item";
      entry.dataset["commentSerial"] = String(item.serial);
      entry.setAttribute("role", "listitem");
      const head = this.#root.createElement("div");
      head.className = "comment-index-head";
      const serial = this.#root.createElement("span");
      serial.className = "comment-index-serial";
      serial.textContent = `#${item.serial}`;
      const status = this.#root.createElement("span");
      status.className = "status-chip";
      status.textContent = "Queued";
      head.append(serial, status);
      if (this.#itemIsStale(item)) {
        const stale = this.#root.createElement("span");
        stale.className = "status-chip warning";
        stale.textContent = "Source changed";
        head.appendChild(stale);
      }
      const quote = this.#root.createElement("div");
      quote.className = "comment-index-quote";
      quote.textContent =
        item.scope === "document"
          ? "Whole document"
          : `${lineLabel(item)} · ${item.quote || "Markdown passage"}`;
      const feedback = this.#root.createElement("div");
      feedback.className = "comment-index-feedback";
      feedback.textContent = parseCommentFeedback(item.feedback).text;
      const actions = this.#root.createElement("div");
      actions.className = "comment-index-actions";
      const go = this.#root.createElement("button");
      go.type = "button";
      go.className = "button";
      go.dataset["commentAction"] = "go";
      const destination =
        item.scope === "document" ? "document" : item.imageId ? "image" : "passage";
      go.textContent = `Go to ${destination}`;
      go.setAttribute("aria-label", `Go to ${destination} for comment ${item.serial}`);
      actions.appendChild(go);
      if (!this.#element("review-composer").hidden) {
        const reference = this.#root.createElement("button");
        reference.type = "button";
        reference.className = "button";
        reference.dataset["commentAction"] = "reference";
        reference.textContent = `Use #${item.serial}`;
        reference.setAttribute("aria-label", `Insert reference to comment ${item.serial}`);
        actions.appendChild(reference);
      }
      entry.append(head, quote, feedback, actions);
      list.appendChild(entry);
    }
  }

  #updateQueueUi(): void {
    const count = this.#round.persisted.queue.length;
    const total = this.#allComments().length;
    const sending = this.#sendingIds.size > 0;
    const launcherCount = this.#element("launcher-count");
    launcherCount.hidden = count === 0;
    launcherCount.textContent = String(count);
    this.#element("top-count").textContent = String(total);
    const commentsOpen = !this.#element("comments-panel").hidden;
    this.#element("comments-toggle").setAttribute(
      "aria-label",
      `${commentsOpen ? "Hide" : "Show"} ${total} review ${total === 1 ? "comment" : "comments"}`,
    );
    const submitActions = this.#element("submit-actions");
    const send = this.#element<HTMLButtonElement>("send-all");
    const options = this.#element<HTMLButtonElement>("submit-options");
    const review = this.#element<HTMLButtonElement>("submit-review");
    const composerOpen = !this.#element("review-composer").hidden;
    const commonSubmissionDisabled = count === 0 || sending || composerOpen;
    const directSubmissionUnavailable = this.#ports.presentation.capabilities.submission === false;
    const reviewedSubmissionUnavailable =
      typeof this.#ports.submissions.review !== "function" ||
      this.#ports.presentation.capabilities.reviewSubmission === false;
    submitActions.dataset["reviewAvailable"] = String(!reviewedSubmissionUnavailable);
    submitActions.hidden = count === 0;
    send.hidden = count === 0;
    options.hidden = reviewedSubmissionUnavailable;
    this.#element("send-all-label").textContent = sending ? "Submitting…" : "Submit";
    this.#element("send-all-count").textContent = `(${count})`;
    send.disabled = commonSubmissionDisabled || directSubmissionUnavailable;
    options.disabled = commonSubmissionDisabled || reviewedSubmissionUnavailable;
    review.disabled = commonSubmissionDisabled || reviewedSubmissionUnavailable;
    if (options.disabled || options.hidden) this.#closeSubmissionMenu(false);
    send.setAttribute(
      "aria-label",
      directSubmissionUnavailable
        ? "Direct submission to Codex is unavailable in this host"
        : sending
          ? "Submitting review feedback"
          : composerOpen
            ? "Queue or close the open comment before submitting feedback"
            : `Submit ${count} queued ${count === 1 ? "comment" : "comments"} to Codex after confirmation`,
    );
    options.setAttribute(
      "aria-label",
      composerOpen
        ? "Queue or close the open comment before reviewing feedback"
        : `More submission options for ${count} queued ${count === 1 ? "comment" : "comments"}`,
    );
    this.#element("launcher-meta").textContent = count
      ? `${count} ${count === 1 ? "feedback item" : "feedback items"} queued`
      : "Open fullscreen review";
    this.#renderCommentsPanel();
  }

  #canSubmit(): boolean {
    return (
      Boolean(this.#document) &&
      this.#round.persisted.queue.length > 0 &&
      this.#sendingIds.size === 0 &&
      this.#element("review-composer").hidden &&
      this.#manualCopyDialog === null &&
      this.#ports.presentation.capabilities.submission !== false
    );
  }

  #closeSubmissionMenu(restoreFocus = false): void {
    const menu = this.#root.getElementById("submit-menu");
    if (!(menu instanceof this.#view.HTMLElement) || menu.hidden) return;
    menu.hidden = true;
    this.#element("submit-options").setAttribute("aria-expanded", "false");
    const returnFocus = this.#submissionMenuReturnFocus;
    this.#submissionMenuReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected && !returnFocus.hidden) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  #openSubmissionMenu(): void {
    const toggle = this.#element<HTMLButtonElement>("submit-options");
    const review = this.#element<HTMLButtonElement>("submit-review");
    if (
      toggle.disabled ||
      toggle.hidden ||
      typeof this.#ports.submissions.review !== "function" ||
      this.#ports.presentation.capabilities.reviewSubmission === false
    ) {
      return;
    }
    this.#closeContextMenu(false);
    const menu = this.#element("submit-menu");
    this.#submissionMenuReturnFocus = toggle;
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    review.tabIndex = 0;
    review.focus({ preventScroll: true });
  }

  #toggleSubmissionMenu(): void {
    if (this.#element("submit-menu").hidden) this.#openSubmissionMenu();
    else this.#closeSubmissionMenu(true);
  }

  #handleSubmissionMenuKeydown(event: KeyboardEvent): boolean {
    const menu = this.#element("submit-menu");
    const toggle = this.#element("submit-options");
    if (
      menu.hidden &&
      event.target === toggle &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      this.#openSubmissionMenu();
      return true;
    }
    if (menu.hidden || !(event.target instanceof this.#view.HTMLElement)) return false;
    if (!menu.contains(event.target)) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      this.#closeSubmissionMenu(true);
      return true;
    }
    if (event.key === "Tab") {
      this.#closeSubmissionMenu(false);
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home") {
      event.preventDefault();
      this.#element("submit-review").focus({ preventScroll: true });
      return true;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.target.click();
      return true;
    }
    return false;
  }

  #openCommentsPanel(): void {
    this.#renderCommentsPanel();
    this.#setCommentsPanelOpen(true);
  }

  #closeCommentsPanel(restoreFocus = true): void {
    this.#setCommentsPanelOpen(false);
    if (restoreFocus) this.#element("comments-toggle").focus();
  }

  #setCommentsPanelOpen(open: boolean): void {
    this.#element("comments-panel").hidden = !open;
    this.#root.documentElement.dataset["commentsOpen"] = String(open);
    const toggle = this.#element("comments-toggle");
    toggle.setAttribute("aria-expanded", String(open));
    const total = this.#allComments().length;
    toggle.setAttribute(
      "aria-label",
      `${open ? "Hide" : "Show"} ${total} review ${total === 1 ? "comment" : "comments"}`,
    );
  }

  #focusReviewBlock(block: HTMLElement | null): void {
    if (!block) return;
    if (!block.hasAttribute("tabindex")) block.setAttribute("tabindex", "-1");
    block.scrollIntoView?.({ block: "center", behavior: this.#scrollBehavior() });
    block.focus({ preventScroll: true });
  }

  #focusQueuedAnnotation(id: string, fallback: HTMLElement | null): void {
    const badge = [...this.#root.querySelectorAll<HTMLElement>(".annotation-badge")].find(
      (candidate) => candidate.dataset["feedbackAnnotation"] === id,
    );
    if (badge) badge.focus();
    else this.#focusReviewBlock(fallback);
  }

  #insertCommentReference(serial: number): void {
    if (this.#element("review-composer").hidden) return;
    const field = this.#element<HTMLTextAreaElement>("feedback");
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const before = field.value.slice(0, start);
    const after = field.value.slice(end);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    const suffix = after && !/^\s/.test(after) ? " " : "";
    const token = `#${serial}`;
    field.value = `${before}${prefix}${token}${suffix}${after}`;
    const cursor = before.length + prefix.length + token.length;
    field.selectionStart = cursor;
    field.selectionEnd = cursor;
    this.#closeCommentsPanel(false);
    field.focus();
    this.#updateComposerActions();
  }

  #clearPendingSelection(): void {
    this.#pendingSelection = null;
    this.#selectionCopyText = null;
    this.#selectionRange = null;
    this.#element("selection-action").hidden = true;
  }

  #dismissPendingSelection(): void {
    this.#copyOperation += 1;
    this.#clearPendingSelection();
    this.#secondarySelection = null;
    this.#lastSelectionAnnouncement = null;
    this.#view.getSelection?.()?.removeAllRanges();
    this.#element("selection-status").textContent = "Selection cleared.";
  }

  #restoreNativeSelection(range: Range | null, direction: SelectionDirection): void {
    const nativeSelection = this.#view.getSelection?.();
    if (
      !range ||
      !nativeSelection ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected
    ) {
      return;
    }
    try {
      nativeSelection.removeAllRanges();
      if (typeof nativeSelection.setBaseAndExtent === "function") {
        if (direction === "backward") {
          nativeSelection.setBaseAndExtent(
            range.endContainer,
            range.endOffset,
            range.startContainer,
            range.startOffset,
          );
        } else {
          nativeSelection.setBaseAndExtent(
            range.startContainer,
            range.startOffset,
            range.endContainer,
            range.endOffset,
          );
        }
      } else {
        nativeSelection.addRange(range.cloneRange());
      }
    } catch {
      // The document changed or the saved range detached while clipboard work was pending.
    }
  }

  #rangeIntersectsTarget(range: Range, target: Node): boolean {
    try {
      return range.intersectsNode(target);
    } catch {
      return false;
    }
  }

  #targetIsReviewUi(target: Node): boolean {
    const element =
      target instanceof this.#view.Element
        ? target
        : target.parentElement instanceof this.#view.Element
          ? target.parentElement
          : null;
    return Boolean(element?.closest("[data-review-ui], .local-image"));
  }

  #selectionSnapshotForTarget(target: Node): ContextMenuSnapshot {
    if (
      !this.#targetIsReviewUi(target) &&
      this.#pendingSelection &&
      this.#selectionCopyText &&
      this.#selectionRange &&
      this.#rangeIntersectsTarget(this.#selectionRange, target)
    ) {
      return {
        selection: this.#pendingSelection,
        copyText: this.#selectionCopyText,
        range: this.#selectionRange.cloneRange(),
        direction: this.#selectionDirection,
      };
    }
    return { selection: null, copyText: null };
  }

  #selectionSnapshotAtPointer(event: PointerEvent | MouseEvent): ContextMenuSnapshot {
    if (
      !(event.target instanceof this.#view.Node) ||
      this.#targetIsReviewUi(event.target) ||
      !this.#pendingSelection ||
      !this.#selectionCopyText ||
      !this.#selectionRange
    ) {
      return { selection: null, copyText: null };
    }
    const rects = Array.from(this.#selectionRange.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    if (rects.length > 0) {
      const tolerance = 2;
      const inside = rects.some(
        (rect) =>
          event.clientX >= rect.left - tolerance &&
          event.clientX <= rect.right + tolerance &&
          event.clientY >= rect.top - tolerance &&
          event.clientY <= rect.bottom + tolerance,
      );
      return inside
        ? {
            selection: this.#pendingSelection,
            copyText: this.#selectionCopyText,
            range: this.#selectionRange.cloneRange(),
            direction: this.#selectionDirection,
          }
        : { selection: null, copyText: null };
    }
    return this.#selectionSnapshotForTarget(event.target);
  }

  #nativeSelectionDirection(nativeSelection: Selection, range: Range): SelectionDirection {
    if (
      nativeSelection.focusNode === range.startContainer &&
      nativeSelection.focusOffset === range.startOffset
    ) {
      return "backward";
    }
    if (
      nativeSelection.focusNode === range.endContainer &&
      nativeSelection.focusOffset === range.endOffset
    ) {
      return "forward";
    }
    if (!nativeSelection.focusNode) return "forward";
    try {
      const focus = range.cloneRange();
      focus.setStart(nativeSelection.focusNode, nativeSelection.focusOffset);
      focus.collapse(true);
      return range.compareBoundaryPoints(0, focus) === 0 ? "backward" : "forward";
    } catch {
      return "forward";
    }
  }

  #selectionEndpointRect(range: Range): DOMRect | null {
    const fragments = Array.from(range.getClientRects()).filter(
      (rect) =>
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        rect.width > 0 &&
        rect.height > 0,
    );
    const endpoint = this.#selectionDirection === "backward" ? fragments[0] : fragments.at(-1);
    if (endpoint) return endpoint;
    const fallback = range.getBoundingClientRect();
    return Number.isFinite(fallback.left) &&
      Number.isFinite(fallback.top) &&
      fallback.width > 0 &&
      fallback.height > 0
      ? fallback
      : null;
  }

  #positionSelectionAction(): void {
    const button = this.#element<HTMLButtonElement>("selection-action");
    if (
      !this.#pendingSelection ||
      !this.#selectionRange ||
      !this.#element("review-composer").hidden
    ) {
      button.hidden = true;
      return;
    }
    const rect = this.#selectionEndpointRect(this.#selectionRange);
    if (!rect) {
      button.hidden = true;
      return;
    }
    const viewportWidth = this.#view.innerWidth;
    const viewportHeight = this.#view.innerHeight;
    const workspace = this.#root.querySelector<HTMLElement>(".workspace");
    const workspaceRect = workspace?.getBoundingClientRect();
    const visibleLeft =
      workspaceRect && workspaceRect.width > 0 ? Math.max(0, workspaceRect.left) : 0;
    const visibleTop =
      workspaceRect && workspaceRect.height > 0 ? Math.max(0, workspaceRect.top) : 0;
    const visibleRight =
      workspaceRect && workspaceRect.width > 0
        ? Math.min(viewportWidth, workspaceRect.right)
        : viewportWidth;
    const visibleBottom =
      workspaceRect && workspaceRect.height > 0
        ? Math.min(viewportHeight, workspaceRect.bottom)
        : viewportHeight;
    if (
      rect.bottom <= visibleTop ||
      rect.top >= visibleBottom ||
      rect.right <= visibleLeft ||
      rect.left >= visibleRight
    ) {
      button.hidden = true;
      return;
    }
    const gutter = 8;
    const gap = 7;
    const width = button.offsetWidth || 32;
    const height = button.offsetHeight || 32;
    const minimumLeft = visibleLeft + gutter;
    const minimumTop = visibleTop + gutter;
    const maximumLeft = Math.max(minimumLeft, visibleRight - width - gutter);
    const maximumTop = Math.max(minimumTop, visibleBottom - height - gutter);
    let left: number;
    let top: number;
    if (this.#selectionDirection === "backward") {
      left = rect.left - width - gap;
      top = rect.top - height - gap;
      if (left < minimumLeft) left = rect.right + gap;
      if (top < minimumTop) top = rect.bottom + gap;
    } else {
      left = rect.right + gap;
      top = rect.bottom + gap;
      if (left > maximumLeft) left = rect.left - width - gap;
      if (top > maximumTop) top = rect.top - height - gap;
    }
    button.style.left = `${Math.max(minimumLeft, Math.min(maximumLeft, left))}px`;
    button.style.top = `${Math.max(minimumTop, Math.min(maximumTop, top))}px`;
    button.hidden = false;
  }

  #scheduleSelectionAction(capture: boolean): void {
    this.#selectionFrameNeedsCapture ||= capture;
    if (this.#selectionFrame !== undefined) return;
    this.#selectionFrame = this.#view.requestAnimationFrame(() => {
      this.#selectionFrame = undefined;
      if (this.#destroyed) return;
      const needsCapture = this.#selectionFrameNeedsCapture;
      this.#selectionFrameNeedsCapture = false;
      if (needsCapture) this.#captureSelection();
      else this.#positionSelectionAction();
    });
  }

  #captureSelection(): void {
    const nativeSelection = this.#view.getSelection?.();
    if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount === 0) {
      this.#clearPendingSelection();
      return;
    }
    const nativeQuote = nativeSelection.toString().trim();
    if (!nativeQuote) {
      this.#clearPendingSelection();
      return;
    }
    const range = nativeSelection.getRangeAt(0);
    const startNode =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const endNode =
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement;
    if (!(startNode instanceof this.#view.Element) || !(endNode instanceof this.#view.Element)) {
      this.#clearPendingSelection();
      return;
    }
    const captured = captureReviewTextAnchor(this.#element("document"), range);
    if (!captured) {
      this.#clearPendingSelection();
      return;
    }
    const startBlock = captured.startBlock;
    const endBlock = captured.endBlock;
    if (
      !startBlock ||
      !endBlock ||
      !this.#element("document").contains(startBlock) ||
      !this.#element("document").contains(endBlock)
    ) {
      this.#clearPendingSelection();
      return;
    }
    const startLine = Number(startBlock.dataset["startLine"]);
    const endLine = Number(endBlock.dataset["endLine"]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) {
      this.#clearPendingSelection();
      return;
    }
    const quote = captured.quote.slice(0, 1400);
    this.#selectionCopyText = captured.quote;
    this.#selectionRange = range.cloneRange();
    this.#selectionDirection = this.#nativeSelectionDirection(nativeSelection, range);
    const endpointRect = this.#selectionEndpointRect(range) ?? range.getBoundingClientRect();
    const blockRect = startBlock.getBoundingClientRect();
    this.#pendingSelection = {
      startLine,
      endLine,
      anchorX: clamp(
        (endpointRect.left + endpointRect.width / 2 - blockRect.left) /
          Math.max(1, blockRect.width),
        0.96,
      ),
      anchorY: clamp(
        (endpointRect.top + endpointRect.height / 2 - blockRect.top) /
          Math.max(1, blockRect.height),
        1,
      ),
      quote,
      ...(captured.quote.length <= 1400 ? { textAnchor: captured.textAnchor } : {}),
      block: endBlock,
    };
    const button = this.#element<HTMLButtonElement>("selection-action");
    button.setAttribute(
      "aria-label",
      `Add feedback for selection, ${lineLabel(this.#pendingSelection)}`,
    );
    this.#positionSelectionAction();
    const announcement = `${lineLabel(this.#pendingSelection)}\n${this.#pendingSelection.quote}`;
    if (announcement !== this.#lastSelectionAnnouncement) {
      this.#lastSelectionAnnouncement = announcement;
      this.#element("selection-status").textContent =
        `Selection ready for feedback, ${lineLabel(this.#pendingSelection)}. ` +
        "Activate Add feedback or press Control or Command plus Shift plus M.";
    }
  }

  #documentSelection(): ActiveSelection | null {
    if (!this.#document) return null;
    return {
      startLine: 1,
      endLine: Math.max(1, this.#document.lineCount),
      anchorX: 0.5,
      anchorY: 0,
      quote: `Whole document: ${this.#document.filename}`.slice(0, 1400),
      scope: "document",
      block: this.#element("document"),
    };
  }

  #contextMenuItems(): HTMLButtonElement[] {
    return [
      ...this.#element("review-context-menu").querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]',
      ),
    ].filter((item) => !item.hidden && !item.disabled);
  }

  #closeContextMenu(restoreFocus = true): void {
    const menu = this.#root.getElementById("review-context-menu");
    if (!(menu instanceof this.#view.HTMLElement) || menu.hidden) return;
    menu.hidden = true;
    this.#element("review-actions").setAttribute("aria-expanded", "false");
    this.#contextSelection = null;
    this.#contextCopyText = null;
    this.#contextRange = null;
    this.#contextSelectionDirection = "forward";
    this.#contextImageTarget = null;
    const returnFocus = this.#contextMenuReturnFocus;
    this.#contextMenuReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected && !returnFocus.hidden) {
      returnFocus.focus({ preventScroll: true });
    }
  }

  #showContextMenu(options: {
    readonly x: number;
    readonly y: number;
    readonly selection?: ActiveSelection | null;
    readonly copyText?: string | null;
    readonly range?: Range | null;
    readonly direction?: SelectionDirection;
    readonly imageTarget?: HTMLButtonElement | null;
    readonly invoker?: HTMLElement | null;
  }): void {
    const menu = this.#element("review-context-menu");
    this.#closeContextMenu(false);
    this.#contextSelection = options.selection ?? null;
    this.#contextCopyText = options.copyText ?? null;
    this.#contextRange = options.range?.cloneRange() ?? null;
    this.#contextSelectionDirection = options.direction ?? "forward";
    this.#contextImageTarget = options.imageTarget ?? null;
    this.#contextMenuReturnFocus =
      options.invoker ??
      (this.#root.activeElement instanceof this.#view.HTMLElement
        ? this.#root.activeElement
        : null);
    if (
      this.#contextMenuReturnFocus &&
      !this.#contextMenuReturnFocus.hasAttribute("tabindex") &&
      this.#contextMenuReturnFocus.tabIndex < 0
    ) {
      this.#contextMenuReturnFocus.setAttribute("tabindex", "-1");
    }

    const composerOpen = !this.#element("review-composer").hidden;
    const selectionItem = this.#element<HTMLButtonElement>("context-comment-selection");
    const copyItem = this.#element<HTMLButtonElement>("context-copy-selection");
    const imageItem = this.#element<HTMLButtonElement>("context-comment-image");
    const separator = this.#element("context-selection-separator");
    selectionItem.hidden = !this.#contextSelection;
    copyItem.hidden = !this.#contextCopyText;
    imageItem.hidden = !this.#contextImageTarget;
    separator.hidden = !this.#contextSelection && !this.#contextImageTarget;
    selectionItem.disabled = composerOpen;
    imageItem.disabled = composerOpen;
    this.#element<HTMLButtonElement>("context-comment-document").disabled =
      composerOpen || !this.#document;

    for (const item of menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
      item.tabIndex = -1;
    }
    menu.hidden = false;
    this.#element("review-actions").setAttribute("aria-expanded", "true");
    const rect = menu.getBoundingClientRect();
    const viewportGutter = 8;
    const maximumLeft = Math.max(
      viewportGutter,
      this.#view.innerWidth - rect.width - viewportGutter,
    );
    const maximumTop = Math.max(
      viewportGutter,
      this.#view.innerHeight - rect.height - viewportGutter,
    );
    const preferredTop =
      options.y + rect.height + viewportGutter > this.#view.innerHeight
        ? options.y - rect.height
        : options.y;
    menu.style.left = `${Math.max(viewportGutter, Math.min(maximumLeft, options.x))}px`;
    menu.style.top = `${Math.max(viewportGutter, Math.min(maximumTop, preferredTop))}px`;
    const first = this.#contextMenuItems()[0];
    if (first) {
      first.tabIndex = 0;
      first.focus({ preventScroll: true });
    } else {
      this.#closeContextMenu();
      this.#toast("Queue or close the open comment before starting another one.");
    }
  }

  async #copyContextSelection(): Promise<void> {
    const text = this.#contextCopyText;
    const returnFocus = this.#contextMenuReturnFocus;
    const range = this.#contextRange?.cloneRange() ?? null;
    const direction = this.#contextSelectionDirection;
    const generation = this.#generation;
    const renderKey = this.#renderKey;
    const operation = ++this.#copyOperation;
    this.#closeContextMenu();
    if (!text) return;
    if (new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_TEXT_LENGTH) {
      this.#toast("The selected text is too large to copy from the review menu.");
      return;
    }
    try {
      if (!this.#ports.clipboard) throw new Error("Clipboard unavailable");
      await this.#ports.clipboard.writeText(text);
      if (
        this.#destroyed ||
        operation !== this.#copyOperation ||
        generation !== this.#generation ||
        renderKey !== this.#renderKey
      )
        return;
      this.#restoreNativeSelection(range, direction);
      this.#view.requestAnimationFrame(() => {
        if (
          !this.#destroyed &&
          operation === this.#copyOperation &&
          generation === this.#generation &&
          renderKey === this.#renderKey
        ) {
          this.#restoreNativeSelection(range, direction);
        }
      });
      this.#toast("Selected text copied.");
    } catch {
      if (
        this.#destroyed ||
        operation !== this.#copyOperation ||
        generation !== this.#generation ||
        renderKey !== this.#renderKey
      )
        return;
      this.#openManualCopy(text, returnFocus);
    }
  }

  #handleContextMenuAction(action: string): void {
    if (action === "copy-selection") {
      void this.#copyContextSelection();
      return;
    }
    const selection = this.#contextSelection;
    const imageTarget = this.#contextImageTarget;
    const invoker = this.#contextMenuReturnFocus;
    this.#closeContextMenu(false);
    if (action === "comment-selection" && selection) {
      this.#openComposer(selection, { invoker });
    } else if (action === "comment-image" && imageTarget) {
      this.#openImageComposer(imageTarget);
    } else if (action === "comment-document") {
      this.#openComposer(this.#documentSelection(), {
        invoker,
      });
    }
  }

  #handleContextMenuKeydown(event: KeyboardEvent): boolean {
    const menu = this.#element("review-context-menu");
    if (menu.hidden || !(event.target instanceof this.#view.HTMLElement)) return false;
    const items = this.#contextMenuItems();
    const current = items.indexOf(event.target as HTMLButtonElement);
    let next = -1;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      this.#closeContextMenu();
      return true;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.target.click();
      return true;
    } else {
      return false;
    }
    event.preventDefault();
    for (const item of items) item.tabIndex = -1;
    const target = items[next];
    if (target) {
      target.tabIndex = 0;
      target.focus({ preventScroll: true });
    }
    return true;
  }

  #openImageComposer(target: HTMLButtonElement): void {
    if (!this.#element("review-composer").hidden) {
      this.#toast("Queue or close the open comment before selecting another image.");
      return;
    }
    const block = target.closest<HTMLElement>(".review-block");
    const imageId = target.dataset["localImageId"];
    const startLine = Number(block?.dataset["startLine"]);
    const endLine = Number(block?.dataset["endLine"]);
    if (!block || !imageId || !Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine))
      return;
    const position = this.#imageAnchorPosition(target, block);
    const selection: ActiveSelection = {
      startLine,
      endLine,
      anchorX: position.anchorX,
      anchorY: position.anchorY,
      quote: this.#imageQuote(target),
      imageId,
      block,
    };
    this.#clearPendingSelection();
    this.#view.getSelection?.()?.removeAllRanges();
    this.#lastSelectionAnnouncement = `${lineLabel(selection)}\n${selection.quote}`;
    this.#element("selection-status").textContent =
      `Image ready for feedback, ${lineLabel(selection)}. The comment editor is open.`;
    this.#openComposer(selection, { invoker: target });
  }

  #setComposerHelp(open: boolean, restoreFocus = false): void {
    const nextOpen = open && !this.#element("review-composer").hidden;
    this.#element("composer-help-popover").hidden = !nextOpen;
    this.#element("composer-help-toggle").setAttribute("aria-expanded", String(nextOpen));
    if (!nextOpen && restoreFocus) this.#element("composer-help-toggle").focus();
  }

  #updateComposerActions(): void {
    const sending = this.#sendingIds.size > 0;
    const field = this.#element<HTMLTextAreaElement>("feedback");
    this.#element<HTMLButtonElement>("add-queue").disabled =
      !(this.#selection && field.value.trim()) || sending;
    field.disabled = sending;
    this.#element<HTMLButtonElement>("close-composer").disabled = sending;
    this.#element<HTMLButtonElement>("composer-help-toggle").disabled = sending;
    const refreshDisabled =
      this.#documentBusy ||
      !this.#element("review-composer").hidden ||
      this.#ports.presentation.capabilities.documentTools === false;
    this.#element<HTMLButtonElement>("refresh").disabled = refreshDisabled;
    this.#element<HTMLButtonElement>("document-update-refresh").disabled = refreshDisabled;
    const parsed = parseCommentFeedback(field.value);
    const known = new Set(this.#allComments().map((item) => item.serial));
    const unknown = parsed.references.filter((serial) => !known.has(serial));
    const message = this.#element("feedback-message");
    message.classList.toggle("warning", unknown.length > 0);
    message.textContent =
      unknown.length === 0
        ? ""
        : unknown.length === 1
          ? `Comment #${unknown[0]} is not available.`
          : `Comments ${unknown.map((serial) => `#${serial}`).join(", ")} are not available.`;
    this.#renderCommentsPanel();
  }

  #captureComposerDraft(): ComposerDraftSnapshot | null {
    if (this.#element("review-composer").hidden || !this.#selection || !this.#document) return null;
    const field = this.#element<HTMLTextAreaElement>("feedback");
    return {
      path: this.#document.path,
      selection: this.#plainSelection(this.#selection),
      feedback: field.value,
      editingId: this.#editingId,
      sourceRevision: this.#selectionRevision ?? this.#document.revision,
      selectionStart: field.selectionStart,
      selectionEnd: field.selectionEnd,
    };
  }

  #resolveDraftSelection(
    draft: ComposerDraftSnapshot,
    reviewDocument: ReviewDocument,
  ): { readonly selection: ActiveSelection; readonly sourceMissing: boolean } {
    const surface = this.#element("document");
    if (draft.selection.scope === "document") {
      return { selection: { ...draft.selection, block: surface }, sourceMissing: false };
    }
    if (draft.selection.imageId) {
      const imageTarget = this.#findImageTarget(
        draft.selection,
        null,
        draft.sourceRevision !== reviewDocument.revision,
      );
      const placeholder = [...surface.querySelectorAll<HTMLElement>("[data-local-image-id]")].find(
        (candidate) => candidate.dataset["localImageId"] === draft.selection.imageId,
      );
      const block =
        imageTarget?.closest<HTMLElement>(".review-block") ??
        placeholder?.closest<HTMLElement>(".review-block") ??
        null;
      return {
        selection: { ...draft.selection, block: block ?? surface },
        sourceMissing: !block,
      };
    }
    const block = findReviewHighlightBlock(surface, {
      id: "composer-draft",
      serial: 0,
      ...draft.selection,
      stale: draft.sourceRevision !== reviewDocument.revision,
    });
    return {
      selection: { ...draft.selection, block: block ?? surface },
      sourceMissing: !block,
    };
  }

  #restoreComposerDraft(draft: ComposerDraftSnapshot, reviewDocument: ReviewDocument): void {
    if (draft.path !== reviewDocument.path) return;
    const resolved = this.#resolveDraftSelection(draft, reviewDocument);
    this.#openComposer(resolved.selection, {
      editingId: draft.editingId,
      feedback: draft.feedback,
      revision: draft.sourceRevision,
      sourceChanged: draft.sourceRevision !== reviewDocument.revision,
      sourceMissing: resolved.sourceMissing,
    });
    const field = this.#element<HTMLTextAreaElement>("feedback");
    field.setSelectionRange(
      Math.min(draft.selectionStart, field.value.length),
      Math.min(draft.selectionEnd, field.value.length),
    );
  }

  #openComposer(
    selection: ActiveSelection | null,
    options: {
      readonly editingId?: string | null;
      readonly feedback?: string;
      readonly invoker?: HTMLElement | null;
      readonly revision?: string;
      readonly sourceChanged?: boolean;
      readonly sourceMissing?: boolean;
    } = {},
  ): void {
    if (!selection?.block) return;
    this.#closeContextMenu(false);
    this.#root.querySelectorAll(".review-block.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    this.#root.querySelectorAll(".image-review-target.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    if (selection.scope !== "document" && selection.block.matches(".review-block")) {
      selection.block.classList.add("is-selected");
    }
    this.#selection = {
      startLine: selection.startLine,
      endLine: selection.endLine,
      anchorX: clamp(selection.anchorX, 0.96),
      anchorY: clamp(selection.anchorY, 1),
      quote: selection.quote.slice(0, 1400),
      ...(selection.textAnchor ? { textAnchor: selection.textAnchor } : {}),
      ...(selection.imageId ? { imageId: selection.imageId } : {}),
      ...(selection.scope ? { scope: selection.scope } : {}),
      block: selection.block,
    };
    this.#findImageTarget(this.#selection, selection.block)?.classList.add("is-selected");
    this.#editingId = options.editingId ?? null;
    this.#selectionRevision = options.revision ?? this.#document?.revision ?? null;
    this.#returnFocus =
      options.invoker && options.invoker !== this.#element("selection-action")
        ? options.invoker
        : selection.block;
    this.#element("composer-title").textContent = this.#editingId
      ? "Edit queued feedback"
      : "Add feedback";
    this.#element("line-pill").textContent = lineLabel(this.#selection);
    const quote = this.#element("quote");
    this.#element("review-composer").querySelector(".composer-source-warning")?.remove();
    const descriptionIds = ["line-pill", "quote", "feedback-message"];
    if (options.sourceChanged || options.sourceMissing) {
      const warning = this.#root.createElement("div");
      warning.className = "composer-source-warning";
      warning.id = "composer-source-warning";
      warning.setAttribute("role", "status");
      warning.textContent = options.sourceMissing
        ? "Source changed and this passage could not be relocated. This draft remains attached to its original revision."
        : "Source changed while this draft was open. Queueing it will mark the comment as stale.";
      quote.insertAdjacentElement("beforebegin", warning);
      descriptionIds.push(warning.id);
    }
    this.#element("review-composer").setAttribute("aria-describedby", descriptionIds.join(" "));
    this.#element<HTMLTextAreaElement>("feedback").setAttribute(
      "aria-describedby",
      descriptionIds.join(" "),
    );
    quote.hidden = this.#selection.scope === "document";
    quote.textContent = this.#selection.quote || "Markdown passage";
    this.#element<HTMLTextAreaElement>("feedback").value = options.feedback ?? "";
    this.#element("add-queue-label").textContent = this.#editingId ? "Save" : "Queue";
    this.#element("add-queue").setAttribute(
      "aria-label",
      this.#editingId ? "Save feedback" : "Queue feedback",
    );
    if (selection.scope === "document" || selection.block === this.#element("document")) {
      selection.block.prepend(this.#element("review-composer"));
    } else {
      selection.block.insertAdjacentElement("afterend", this.#element("review-composer"));
    }
    this.#element("review-composer").hidden = false;
    this.#setComposerHelp(false);
    this.#element("selection-action").hidden = true;
    this.#updateComposerActions();
    this.#updateQueueUi();
    this.#element<HTMLTextAreaElement>("feedback").focus();
    this.#element("review-composer").scrollIntoView?.({
      block: "nearest",
      behavior: this.#scrollBehavior(),
    });
  }

  #closeComposer(restoreSelection = false, restoreFocus = true): void {
    const returnFocus = this.#returnFocus;
    const returnBlock = this.#selection?.block ?? null;
    this.#setComposerHelp(false);
    this.#element("review-composer").hidden = true;
    this.#element("quote").hidden = false;
    this.#element<HTMLTextAreaElement>("feedback").value = "";
    this.#editingId = null;
    this.#selectionRevision = null;
    this.#selection = null;
    this.#returnFocus = null;
    this.#root.querySelectorAll(".review-block.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    this.#root.querySelectorAll(".image-review-target.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    this.#element("review-composer").querySelector(".composer-source-warning")?.remove();
    this.#element("review-composer").setAttribute(
      "aria-describedby",
      "line-pill quote feedback-message",
    );
    this.#element<HTMLTextAreaElement>("feedback").setAttribute(
      "aria-describedby",
      "line-pill quote feedback-message",
    );
    this.#updateComposerActions();
    this.#updateQueueUi();
    if (!restoreSelection) this.#view.getSelection?.()?.removeAllRanges();
    this.#root.body.appendChild(this.#element("review-composer"));
    this.#renderCommentsPanel();
    if (restoreFocus) {
      queueMicrotask(() => {
        if (returnFocus?.isConnected && !returnFocus.hidden) returnFocus.focus();
        else this.#focusReviewBlock(returnBlock);
      });
    }
  }

  #requestCloseComposer(): void {
    const draft = this.#captureComposerDraft();
    this.#closeComposer();
    if (!draft?.feedback.trim()) return;
    this.#toast("Draft discarded.", {
      actionLabel: "Undo",
      onAction: () => {
        if (this.#document) this.#restoreComposerDraft(draft, this.#document);
      },
    });
  }

  #queueCurrent(): void {
    const feedback = this.#element<HTMLTextAreaElement>("feedback").value.trim();
    if (!this.#selection || !feedback || !this.#document) return;
    const selection = this.#selection;
    const wasEditing = this.#editingId !== null;
    let queued: QueuedFeedback | undefined;
    if (this.#editingId) {
      const original = this.#round.persisted.queue.find((item) => item.id === this.#editingId);
      this.#round = updateQueuedFeedback(this.#round, this.#editingId, {
        selection: this.#plainSelection(selection),
        revision: original?.revision ?? this.#document.revision,
        feedback,
      });
      queued = this.#round.persisted.queue.find((item) => item.id === this.#editingId);
    } else {
      if (this.#round.persisted.queue.length >= MAX_QUEUE_ITEMS) {
        this.#toast(`The review queue supports up to ${MAX_QUEUE_ITEMS} items.`);
        return;
      }
      const id = makeId();
      this.#round = queueFeedback(this.#round, {
        id,
        path: this.#document.path,
        revision: this.#selectionRevision ?? this.#document.revision,
        selection: this.#plainSelection(selection),
        feedback,
        createdAt: new Date().toISOString(),
      });
      queued = this.#round.persisted.queue.find((item) => item.id === id);
    }
    const fallback = selection.block;
    this.#closeComposer(false, false);
    this.#renderQueueCards();
    void this.#persistState();
    if (queued) {
      this.#focusQueuedAnnotation(queued.id, fallback);
      this.#toast(
        wasEditing ? `Comment #${queued.serial} updated.` : `Comment #${queued.serial} queued.`,
      );
    }
  }

  #plainSelection(selection: ActiveSelection): ReviewSelection {
    return {
      startLine: selection.startLine,
      endLine: selection.endLine,
      anchorX: selection.anchorX,
      anchorY: selection.anchorY,
      quote: selection.quote,
      ...(selection.textAnchor ? { textAnchor: selection.textAnchor } : {}),
      ...(selection.imageId ? { imageId: selection.imageId } : {}),
      ...(selection.scope ? { scope: selection.scope } : {}),
    };
  }

  #performRemoveComment(item: QueuedFeedback): void {
    const index = this.#round.persisted.queue.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) return;
    this.#round = removeQueuedFeedback(this.#round, item.id);
    this.#renderQueueCards();
    void this.#persistState();
    const next =
      this.#round.persisted.queue[Math.min(index, this.#round.persisted.queue.length - 1)];
    if (next) this.#focusQueuedAnnotation(next.id, this.#findAnchorBlock(next));
    else this.#element("comments-toggle").focus();
    this.#toast(`Comment #${item.serial} removed.`, {
      actionLabel: "Undo",
      onAction: () => {
        const queue = [...this.#round.persisted.queue];
        queue.splice(Math.min(index, queue.length), 0, item);
        const persisted = normalizePersistedReviewState(
          { ...this.#round.persisted, queue },
          new Date().toISOString(),
        );
        this.#round = createReviewRoundState(persisted);
        this.#renderQueueCards();
        void this.#persistState();
        this.#focusQueuedAnnotation(item.id, this.#findAnchorBlock(item));
        this.#toast(`Comment #${item.serial} restored.`);
      },
    });
  }

  #requestRemoveComment(item: QueuedFeedback): void {
    const dependents = this.#round.persisted.queue.filter(
      (candidate) =>
        candidate.id !== item.id &&
        extractCommentReferences(candidate.feedback).includes(item.serial),
    );
    if (dependents.length > 0) {
      this.#toast(
        `Comment #${item.serial} is referenced by ${dependents.map((candidate) => `#${candidate.serial}`).join(", ")}.`,
        {
          actionLabel: "Remove anyway",
          onAction: () => {
            this.#performRemoveComment(item);
          },
        },
      );
      return;
    }
    this.#performRemoveComment(item);
  }

  #syncSendingUi(): void {
    const sending = this.#sendingIds.size > 0;
    this.#element("review-composer").setAttribute("aria-busy", String(sending));
    this.#element("comments-panel").setAttribute("aria-busy", String(sending));
    this.#root
      .querySelectorAll<HTMLButtonElement>("[data-queue-action], [data-feedback-annotation]")
      .forEach((control) => {
        control.disabled = sending;
      });
    this.#updateComposerActions();
    this.#updateQueueUi();
  }

  async #sendFeedbackItems(intent: SubmissionIntent = "submit"): Promise<void> {
    if (!this.#document || this.#round.persisted.queue.length === 0 || this.#sendingIds.size > 0)
      return;
    if (intent === "submit" && this.#ports.presentation.capabilities.submission === false) {
      this.#toast("Direct submission to Codex is unavailable in this host.");
      return;
    }
    if (!this.#element("review-composer").hidden) {
      this.#toast("Queue or close the open comment before submitting this review round.");
      return;
    }
    const submissionPort = this.#ports.submissions;
    const dispatchSubmission =
      intent === "review"
        ? submissionPort.review?.bind(submissionPort)
        : submissionPort.submit.bind(submissionPort);
    if (
      !dispatchSubmission ||
      (intent === "review" && this.#ports.presentation.capabilities.reviewSubmission === false)
    ) {
      this.#toast("Review before sending is unavailable in this host.");
      return;
    }
    const reviewReturnFocus =
      intent === "review" ? this.#element<HTMLButtonElement>("submit-options") : null;
    this.#closeSubmissionMenu(false);
    const submissionId = makeId();
    let prepared: ReturnType<typeof prepareReviewSubmission>;
    try {
      prepared = prepareReviewSubmission(this.#round, this.#document, submissionId);
    } catch (error) {
      this.#toast(`Could not prepare feedback: ${errorMessage(error)}`);
      return;
    }
    if (!prepared) return;
    this.#round = prepared.state;
    const first = this.#round.persisted.queue[0];
    const fallback = first ? this.#findAnchorBlock(first) : null;
    this.#sendingIds = new Set(prepared.submission.itemIds);
    this.#syncSendingUi();
    let succeeded = false;
    let accepted = false;
    try {
      if (!(await this.#persistState(false))) {
        throw new Error("the stable submission ID could not be saved; feedback was not submitted");
      }
      await dispatchSubmission(prepared.submission);
      accepted = true;
      this.#round = completeReviewSubmission(
        this.#round,
        prepared.submission.submissionId,
        new Date().toISOString(),
      );
      this.#renderQueueCards();
      succeeded = true;
      const count = prepared.submission.itemIds.length;
      const stateCleared = await this.#persistState(false);
      this.#toast(
        stateCleared
          ? count === 1
            ? "Comment submitted to Codex."
            : `${count} comments submitted to Codex.`
          : "Feedback was submitted, but local queue cleanup failed. Do not submit these comments again.",
      );
    } catch (error) {
      if (!accepted) {
        this.#round = retainFailedReviewSubmission(this.#round, prepared.submission.submissionId);
        this.#toast(`Could not submit feedback: ${errorMessage(error)}`);
      } else {
        succeeded = true;
        this.#toast(
          "Feedback was accepted, but the local review state could not be finalized. Do not submit these comments again.",
        );
      }
    } finally {
      this.#sendingIds.clear();
      this.#syncSendingUi();
      if (succeeded && intent === "review") {
        const next = this.#round.persisted.queue[0];
        if (next) this.#focusQueuedAnnotation(next.id, this.#findAnchorBlock(next));
        else if (fallback) this.#focusReviewBlock(fallback);
        else this.#element("comments-toggle").focus();
      } else if (
        !succeeded &&
        reviewReturnFocus?.isConnected &&
        !reviewReturnFocus.hidden &&
        !reviewReturnFocus.disabled
      ) {
        reviewReturnFocus.focus({ preventScroll: true });
      }
    }
  }

  async #persistState(reportFailure = true): Promise<boolean> {
    const snapshot = this.#round.persisted;
    this.#saveChain = this.#saveChain
      .catch(() => undefined)
      .then(() => this.#ports.state.save(snapshot));
    try {
      await this.#saveChain;
      return true;
    } catch (error) {
      if (reportFailure) this.#toast(`Could not save review state: ${errorMessage(error)}`);
      return false;
    }
  }

  #setMermaidError(wrapper: HTMLElement, message: string): void {
    const output = wrapper.querySelector<HTMLElement>(".mermaid-render");
    const source = wrapper.querySelector<HTMLDetailsElement>(".mermaid-source");
    if (!output || !source) return;
    const status = this.#root.createElement("span");
    status.className = "mermaid-status";
    status.textContent = message;
    output.replaceChildren(status);
    output.classList.remove("is-loading", "is-ready");
    output.classList.add("is-error");
    output.removeAttribute("aria-busy");
    output.setAttribute("role", "alert");
    source.open = true;
  }

  #prepareMermaidDiagrams(): void {
    this.#diagramRun += 1;
    this.#diagramAbort?.abort();
    this.#diagramAbort = null;
    const surface = this.#element("document");
    const codeBlocks = [...surface.querySelectorAll<HTMLElement>("pre > code")].filter((code) =>
      [...code.classList].some((token) => token.toLowerCase() === "language-mermaid"),
    );
    let totalBytes = 0;
    for (const [index, code] of codeBlocks.entries()) {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== "PRE" || pre.closest("[data-review-ui]")) continue;
      for (const token of [...code.classList]) {
        if (token.toLowerCase() === "language-mermaid") code.classList.remove(token);
      }
      code.classList.add("language-mermaid");
      const sourceBytes = new TextEncoder().encode(code.textContent ?? "").byteLength;
      totalBytes += sourceBytes;
      const wrapper = this.#root.createElement("div");
      wrapper.className = "mermaid-diagram";
      const output = this.#root.createElement("div");
      output.className = "mermaid-render is-loading";
      output.dataset["reviewUi"] = "mermaid";
      output.setAttribute("aria-busy", "true");
      output.setAttribute("role", "status");
      const status = this.#root.createElement("span");
      status.className = "mermaid-status";
      status.textContent = "Rendering Mermaid diagram…";
      output.appendChild(status);
      const details = this.#root.createElement("details");
      details.className = "mermaid-source";
      details.open = true;
      const summary = this.#root.createElement("summary");
      summary.dataset["reviewUi"] = "mermaid-source-toggle";
      summary.textContent = "Mermaid source";
      pre.replaceWith(wrapper);
      details.append(summary, pre);
      wrapper.append(output, details);
      if (index >= MAX_MERMAID_DIAGRAMS) {
        this.#setMermaidError(
          wrapper,
          `This review renders up to ${MAX_MERMAID_DIAGRAMS} Mermaid diagrams.`,
        );
      } else if (sourceBytes > MAX_MERMAID_SOURCE_BYTES) {
        this.#setMermaidError(wrapper, "This Mermaid diagram exceeds the 32 KiB source limit.");
      } else if (totalBytes > MAX_MERMAID_TOTAL_SOURCE_BYTES) {
        this.#setMermaidError(
          wrapper,
          "The Mermaid diagrams in this review exceed the 128 KiB total source limit.",
        );
      } else if (!this.#diagramRenderer) {
        this.#setMermaidError(wrapper, "Mermaid rendering is unavailable in this host.");
      } else {
        // Keep the source collapsed before the asynchronous render completes so
        // success does not cause a late layout shift that can disturb an active
        // native selection or context-menu focus. A user-opened source remains
        // open, and failures disclose it through #setMermaidError.
        details.open = false;
        wrapper.dataset["mermaidApproved"] = "true";
      }
    }
  }

  async #installMermaidDiagrams(generation: number): Promise<void> {
    const renderer = this.#diagramRenderer;
    if (!renderer || this.#destroyed) return;
    this.#diagramAbort?.abort();
    const abort = new AbortController();
    this.#diagramAbort = abort;
    const run = ++this.#diagramRun;
    const wrappers = [
      ...this.#element("document").querySelectorAll<HTMLElement>('[data-mermaid-approved="true"]'),
    ];
    let totalBytes = 0;
    let totalElements = 0;
    for (const [index, wrapper] of wrappers.entries()) {
      if (generation !== this.#generation || run !== this.#diagramRun || this.#destroyed) return;
      const output = wrapper.querySelector<HTMLElement>(".mermaid-render");
      const details = wrapper.querySelector<HTMLDetailsElement>(".mermaid-source");
      const code = details?.querySelector<HTMLElement>("pre > code.language-mermaid");
      if (!output || !details || !code) continue;
      output.classList.add("is-loading");
      output.classList.remove("is-error");
      output.setAttribute("aria-busy", "true");
      const preserveSourceDisclosure = details.open;
      try {
        const block = wrapper.closest<HTMLElement>(".review-block");
        const startLine = block?.dataset["startLine"];
        const endLine = block?.dataset["endLine"];
        const lineDescription =
          startLine && endLine
            ? startLine === endLine
              ? `, line ${startLine}`
              : `, lines ${startLine}–${endLine}`
            : "";
        const rendered = await renderer.render(code.textContent ?? "", {
          id: `flowzone-mermaid-${generation}-${run}-${index + 1}`,
          theme: this.#currentTheme(),
          accessibleLabel: `Mermaid diagram${lineDescription}`,
          signal: abort.signal,
        });
        if (
          generation !== this.#generation ||
          run !== this.#diagramRun ||
          this.#destroyed ||
          !wrapper.isConnected
        ) {
          return;
        }
        if (
          totalBytes + rendered.byteLength > MAX_MERMAID_TOTAL_OUTPUT_BYTES ||
          totalElements + rendered.elementCount > MAX_MERMAID_TOTAL_ELEMENTS
        ) {
          this.#setMermaidError(
            wrapper,
            "The Mermaid diagrams in this review exceed the rendered complexity limit.",
          );
          continue;
        }
        totalBytes += rendered.byteLength;
        totalElements += rendered.elementCount;
        output.replaceChildren(rendered.element);
        output.classList.remove("is-loading", "is-error");
        output.classList.add("is-ready");
        output.removeAttribute("aria-busy");
        output.removeAttribute("role");
        wrapper.dataset["mermaidRendered"] = "true";
        details.open =
          preserveSourceDisclosure ||
          block?.classList.contains("has-comments") === true ||
          this.#selection?.block === block ||
          this.#pendingSelection?.block === block;
      } catch {
        if (
          generation !== this.#generation ||
          run !== this.#diagramRun ||
          this.#destroyed ||
          !wrapper.isConnected
        ) {
          return;
        }
        this.#setMermaidError(
          wrapper,
          "This Mermaid diagram could not be rendered. Check the source syntax.",
        );
      }
    }
    if (generation === this.#generation && run === this.#diagramRun) {
      if (this.#diagramAbort === abort) this.#diagramAbort = null;
      this.#ports.presentation.notifyIntrinsicHeight?.(this.#root.documentElement.scrollHeight);
    }
  }

  async #loadImageBytes(
    reviewDocument: ReviewDocument,
    image: ReviewImageDescriptor,
    placeholder: HTMLElement,
    generation: number,
  ): Promise<Uint8Array> {
    const chunks = new Array<PrivateReviewImageChunk | undefined>(image.chunkCount);
    let nextChunk = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
      while (nextChunk < image.chunkCount) {
        const chunkIndex = nextChunk;
        nextChunk += 1;
        const chunk = await withRetry(() =>
          this.#ports.documents.loadAssetChunk({
            reviewSessionId: reviewDocument.reviewSessionId,
            revision: reviewDocument.revision,
            imageId: image.id,
            chunkIndex,
          }),
        );
        if (generation !== this.#generation) throw new Error("Image load superseded");
        this.#assertMatchingChunk(chunk, reviewDocument, image, chunkIndex);
        chunks[chunkIndex] = chunk;
        completed += 1;
        const status = placeholder.querySelector<HTMLElement>(".local-image-status");
        if (status) status.textContent = `Loading image… ${completed}/${image.chunkCount}`;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CHUNK_WORKERS, image.chunkCount) }, () => worker()),
    );
    const output = assembleImageChunks(chunks, image.chunkCount, image.byteLength);
    if ((await sha256Hex(output)) !== image.revision) {
      throw new Error("The image digest did not match the review");
    }
    return output;
  }

  async #loadDecodedImage(
    reviewDocument: ReviewDocument,
    image: ReviewImageDescriptor,
    placeholder: HTMLElement,
    generation: number,
  ): Promise<DecodedReviewImage> {
    const outputWidth = Number(placeholder.dataset["rasterWidth"]);
    const outputHeight = Number(placeholder.dataset["rasterHeight"]);
    const outputPixels = outputWidth * outputHeight;
    if (
      !Number.isSafeInteger(outputWidth) ||
      !Number.isSafeInteger(outputHeight) ||
      outputWidth <= 0 ||
      outputHeight <= 0 ||
      outputWidth > image.width ||
      outputHeight > image.height ||
      !Number.isSafeInteger(outputPixels) ||
      outputPixels > MAX_INLINE_IMAGE_TOTAL_PIXELS
    ) {
      throw new Error("Image raster dimensions are invalid");
    }
    const key = JSON.stringify([
      reviewDocument.reviewSessionId,
      reviewDocument.revision,
      image.id,
      image.revision,
      outputWidth,
      outputHeight,
    ]);
    const cached = this.#decodedImages.get(key);
    if (cached) return cached;
    const promise = (async (): Promise<DecodedReviewImage> => {
      const bytes = await this.#loadImageBytes(reviewDocument, image, placeholder, generation);
      if (generation !== this.#generation) throw new Error("Image load superseded");
      if (!this.#imageDecoder) throw new Error("Native browser image decoding is unavailable");
      const decoded = await this.#imageDecoder.decode(bytes, image.mimeType, {
        expectedWidth: image.width,
        expectedHeight: image.height,
        outputWidth,
        outputHeight,
      });
      if (decoded.width !== outputWidth || decoded.height !== outputHeight) {
        throw new Error("Decoded raster dimensions did not match the review");
      }
      return decoded;
    })();
    this.#decodedImages.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      if (this.#decodedImages.get(key) === promise) this.#decodedImages.delete(key);
      throw error;
    }
  }

  #assertMatchingChunk(
    chunk: PrivateReviewImageChunk,
    reviewDocument: ReviewDocument,
    image: ReviewImageDescriptor,
    chunkIndex: number,
  ): void {
    if (
      chunk.reviewSessionId !== reviewDocument.reviewSessionId ||
      chunk.revision !== reviewDocument.revision ||
      chunk.imageId !== image.id ||
      chunk.imageRevision !== image.revision ||
      chunk.mimeType !== image.mimeType ||
      chunk.chunkIndex !== chunkIndex ||
      chunk.chunkCount !== image.chunkCount ||
      chunk.byteOffset !== chunkIndex * IMAGE_CHUNK_BYTES ||
      chunk.byteLength !==
        Math.min(IMAGE_CHUNK_BYTES, image.byteLength - chunkIndex * IMAGE_CHUNK_BYTES)
    ) {
      throw new Error(`Image chunk ${chunkIndex + 1} did not match the review`);
    }
  }

  #setImageError(
    placeholder: HTMLElement,
    image: ReviewImageDescriptor | undefined,
    alt: string,
    error: unknown,
  ): void {
    placeholder.classList.add("is-error");
    placeholder.dataset["loading"] = "";
    const status = this.#root.createElement("span");
    status.className = "local-image-status";
    status.textContent = `Could not render image: ${alt} (${errorMessage(error)})`;
    placeholder.replaceChildren(status);
    if (image) {
      const retry = this.#root.createElement("button");
      retry.className = "button image-retry";
      retry.type = "button";
      retry.textContent = "Retry image";
      retry.setAttribute("aria-label", `Retry image: ${alt}`);
      placeholder.appendChild(retry);
    }
  }

  async #renderLocalImage(
    reviewDocument: ReviewDocument,
    image: ReviewImageDescriptor | undefined,
    placeholder: HTMLElement,
    generation: number,
  ): Promise<void> {
    if (this.#destroyed) return;
    const alt = placeholder.dataset["alt"] || "Local Markdown image";
    try {
      if (placeholder.dataset["loading"] === "true") return;
      placeholder.dataset["loading"] = "true";
      placeholder.classList.remove("is-error");
      const status = placeholder.querySelector<HTMLElement>(".local-image-status");
      if (status) status.textContent = "Loading image…";
      if (!image) throw new Error("Image metadata is unavailable");
      const decoded = await this.#loadDecodedImage(reviewDocument, image, placeholder, generation);
      if (this.#destroyed || generation !== this.#generation) return;
      const target = this.#root.createElement("button");
      target.type = "button";
      target.className = "image-review-target";
      target.dataset["localImageId"] = image.id;
      target.dataset["alt"] = alt;
      target.setAttribute("aria-label", `Add feedback for image: ${alt}`);
      target.title = `Add feedback for image: ${alt}`;
      if (decoded.width < image.width || decoded.height < image.height) {
        target.classList.add("is-downsampled");
        target.style.width = `${image.width}px`;
      }
      const canvas = this.#root.createElement("canvas");
      canvas.className = "local-image-canvas";
      canvas.setAttribute("aria-hidden", "true");
      canvas.width = decoded.width;
      canvas.height = decoded.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      const pixels = context.createImageData(decoded.width, decoded.height);
      pixels.data.set(decoded.data);
      context.putImageData(pixels, 0, 0);
      target.appendChild(canvas);
      placeholder.replaceWith(target);
      if (this.#selection) {
        this.#findImageTarget(this.#selection, this.#selection.block)?.classList.add("is-selected");
      }
      this.#syncImageTargetStates();
    } catch (error) {
      if (this.#destroyed) return;
      if (generation === this.#generation && isExpiredSessionError(error)) {
        void this.#recoverExpiredSession();
      } else if (generation === this.#generation && !errorMessage(error).includes("superseded")) {
        this.#setImageError(placeholder, image, alt, error);
      } else {
        placeholder.dataset["loading"] = "";
      }
    }
  }

  #setPermanentImageError(placeholder: HTMLElement, message: string): void {
    const alt = placeholder.dataset["alt"] || "Local Markdown image";
    delete placeholder.dataset["imageApproved"];
    delete placeholder.dataset["localImageId"];
    this.#setImageError(placeholder, undefined, alt, new Error(message));
  }

  #prepareLocalImages(reviewDocument: ReviewDocument): void {
    const images = new Map(reviewDocument.images.map((image) => [image.id, image]));
    const placeholders = [...this.#root.querySelectorAll<HTMLElement>("[data-local-image-id]")];
    let references = 0;
    const candidates: RasterCandidate[] = [];
    for (const placeholder of placeholders) {
      if (references >= MAX_INLINE_IMAGE_REFERENCES) {
        this.#setPermanentImageError(
          placeholder,
          `this review processes up to ${MAX_INLINE_IMAGE_REFERENCES} local image references`,
        );
        continue;
      }
      references += 1;
      const image = images.get(placeholder.dataset["localImageId"] ?? "");
      if (!image) {
        this.#setPermanentImageError(placeholder, "Image metadata is unavailable");
        continue;
      }
      const pixels = image.width * image.height;
      if (!Number.isSafeInteger(pixels) || pixels <= 0) {
        this.#setPermanentImageError(placeholder, "Image dimensions are invalid");
        continue;
      }
      candidates.push({ placeholder, image, pixels });
    }
    const allocations = allocateRasterPixelBudgets(candidates.map((candidate) => candidate.pixels));
    for (const [index, candidate] of candidates.entries()) {
      const maximumPixels = allocations[index] ?? 0;
      const raster = fitRasterDimensions(
        candidate.image.width,
        candidate.image.height,
        maximumPixels,
      );
      candidate.placeholder.dataset["rasterWidth"] = String(raster.width);
      candidate.placeholder.dataset["rasterHeight"] = String(raster.height);
      candidate.placeholder.dataset["imageApproved"] = "true";
    }
  }

  async #installLocalImages(reviewDocument: ReviewDocument, generation: number): Promise<void> {
    if (!this.#reviewSurfaceVisible()) return;
    const images = new Map(reviewDocument.images.map((image) => [image.id, image]));
    const queue = [
      ...this.#root.querySelectorAll<HTMLElement>(
        '[data-image-approved="true"][data-local-image-id]',
      ),
    ].filter((placeholder) => placeholder.dataset["loading"] !== "true");
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        if (generation !== this.#generation || this.#destroyed) return;
        const placeholder = queue[next];
        next += 1;
        if (placeholder) {
          await this.#renderLocalImage(
            reviewDocument,
            images.get(placeholder.dataset["localImageId"] ?? ""),
            placeholder,
            generation,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(IMAGE_WORKERS, queue.length) }, () => worker()),
    );
    if (generation === this.#generation) {
      this.#decodedImages.clear();
      this.#ports.presentation.notifyIntrinsicHeight?.(this.#root.documentElement.scrollHeight);
    }
  }

  async #requestFullscreen(automatic = false): Promise<boolean> {
    if (this.#currentDisplayMode() !== "inline") return true;
    if (
      this.#ports.presentation.capabilities.displayMode === false ||
      !this.#ports.presentation.requestDisplayMode
    ) {
      if (!automatic) {
        this.#inlineReviewFallback = true;
        this.#syncSurfaceLayout();
        this.#toast("Fullscreen is unavailable. Opened the review inline.");
      }
      return false;
    }
    try {
      const mode = await this.#ports.presentation.requestDisplayMode("fullscreen");
      this.#root.documentElement.dataset["displayMode"] = mode;
      if (!automatic && mode === "inline") {
        this.#inlineReviewFallback = true;
        this.#toast("Fullscreen is unavailable. Opened the review inline.");
      }
      this.#syncSurfaceLayout();
      return mode === "fullscreen";
    } catch {
      if (!automatic) {
        this.#inlineReviewFallback = true;
        this.#syncSurfaceLayout();
        this.#toast("Could not enter fullscreen. Opened the review inline.");
      }
      return false;
    }
  }

  #requestDefaultFullscreen(reviewDocument: ReviewDocument): void {
    const key = documentKey(reviewDocument);
    if (this.#fullscreenRequestedFor === key) return;
    this.#fullscreenRequestedFor = key;
    queueMicrotask(() => {
      void this.#requestFullscreen(true);
    });
  }

  #renderDocument(reviewDocument: ReviewDocument, generation: number): void {
    const key = documentKey(reviewDocument);
    if (key === this.#renderKey) {
      this.#document = reviewDocument;
      this.#lastGoodDocument = reviewDocument;
      this.#setMeta(
        `${reviewDocument.filename} · ${reviewDocument.lineCount} lines · rev ${reviewDocument.revision}`,
      );
      this.#requestDefaultFullscreen(reviewDocument);
      return;
    }
    const draft = this.#captureComposerDraft();
    const commentsOpen = !this.#element("comments-panel").hidden;
    this.#closeManualCopy(false);
    this.#generation = Math.max(this.#generation, generation);
    this.#decodedImages.clear();
    this.#document = reviewDocument;
    this.#lastGoodDocument = reviewDocument;
    this.#renderKey = key;
    this.#clearDocumentUpdate();
    const title = reviewDocument.title || reviewDocument.filename || "Markdown Review";
    this.#element("title").textContent = title;
    this.#element("launcher-title").textContent = title;
    this.#setMeta(
      `${reviewDocument.filename} · ${reviewDocument.lineCount} lines · rev ${reviewDocument.revision}`,
    );
    this.#closeContextMenu(false);
    this.#closeComposer(false, false);
    this.#clearPendingSelection();
    this.#view.getSelection?.()?.removeAllRanges();
    const surface = this.#element("document");
    clearReviewHighlights(surface);
    if (reviewDocument.html) {
      surface.replaceChildren(sanitizeReviewHtml(this.#root, reviewDocument.html));
    } else {
      const empty = this.#root.createElement("div");
      empty.className = "empty";
      empty.textContent = "This Markdown file is empty.";
      surface.replaceChildren(empty);
    }
    this.#prepareMermaidDiagrams();
    this.#prepareLocalImages(reviewDocument);
    if (this.#round.persisted.path !== reviewDocument.path) {
      this.#round = createReviewRoundState(
        normalizePersistedReviewState(null, new Date().toISOString()),
      );
    }
    this.#renderQueueCards();
    this.#setCommentsPanelOpen(commentsOpen);
    if (draft) this.#restoreComposerDraft(draft, reviewDocument);
    void this.#installMermaidDiagrams(this.#generation);
    void this.#installLocalImages(reviewDocument, this.#generation);
    this.#requestDefaultFullscreen(reviewDocument);
  }

  #showSessionRecoveryError(): void {
    const surface = this.#element("document");
    surface.querySelector("[data-review-ui='session-recovery']")?.remove();
    const alert = this.#root.createElement("section");
    alert.className = "session-recovery-alert";
    alert.dataset["reviewUi"] = "session-recovery";
    alert.setAttribute("role", "alert");
    const message = this.#root.createElement("p");
    message.textContent = this.#ports.documents.recover
      ? "The review session expired and could not be restored. Retry recovery or reopen the review from Codex."
      : "The review session expired. Reopen the review from Codex to render its images.";
    alert.appendChild(message);
    if (this.#ports.documents.recover) {
      const retry = this.#root.createElement("button");
      retry.type = "button";
      retry.className = "button";
      retry.textContent = "Retry recovery";
      retry.addEventListener(
        "click",
        () => {
          void this.#recoverExpiredSession();
        },
        { signal: this.#abort.signal },
      );
      alert.appendChild(retry);
    }
    surface.prepend(alert);
    this.#setMeta("The review session expired. Reopen the review if recovery keeps failing.", true);
  }

  async #recoverExpiredSession(): Promise<boolean> {
    const reviewDocument = this.#document;
    if (!reviewDocument || this.#destroyed) return false;
    if (
      this.#activeRecovery?.reviewSessionId === reviewDocument.reviewSessionId &&
      this.#activeRecovery.generation === this.#generation
    ) {
      return this.#activeRecovery.promise;
    }
    const generation = ++this.#generation;
    this.#activeLoad = null;
    this.#decodedImages.clear();
    this.#element("document").querySelector("[data-review-ui='session-recovery']")?.remove();
    const recover = this.#ports.documents.recover?.bind(this.#ports.documents);
    if (!recover) {
      this.#showSessionRecoveryError();
      return false;
    }
    this.#setBusy(true);
    this.#setMeta(`Restoring ${reviewDocument.filename}…`);
    const promise = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        const recovered = await recover({
          reviewSessionId: reviewDocument.reviewSessionId,
          path: reviewDocument.path,
          revision: reviewDocument.revision,
        });
        if (generation !== this.#generation || this.#destroyed) return false;
        if (recovered.path !== reviewDocument.path) {
          throw new Error("The recovered review did not match the open Markdown file");
        }
        if (recovered.reviewSessionId === reviewDocument.reviewSessionId) {
          throw new Error("The recovered review did not rotate the expired session");
        }
        this.#clearDocumentUpdate();
        this.#renderDocument(recovered, generation);
        this.#toast("Review session restored.");
        return true;
      } catch {
        if (generation !== this.#generation || this.#destroyed) return false;
        this.#showSessionRecoveryError();
        return false;
      } finally {
        if (generation === this.#generation) this.#setBusy(false);
        if (this.#activeRecovery?.generation === generation) this.#activeRecovery = null;
      }
    });
    this.#activeRecovery = {
      reviewSessionId: reviewDocument.reviewSessionId,
      generation,
      promise,
    };
    return promise;
  }

  #scheduleDocumentUpdateCheck(): void {
    if (this.#documentUpdateCheckTimer !== undefined) {
      clearTimeout(this.#documentUpdateCheckTimer);
      this.#documentUpdateCheckTimer = undefined;
    }
    if (
      this.#destroyed ||
      !this.#document ||
      typeof this.#ports.documents.checkForUpdate !== "function" ||
      this.#ports.presentation.capabilities.documentTools === false
    ) {
      return;
    }
    this.#documentUpdateCheckTimer = setTimeout(() => {
      this.#documentUpdateCheckTimer = undefined;
      void this.#checkForDocumentUpdate().finally(() => {
        this.#scheduleDocumentUpdateCheck();
      });
    }, DOCUMENT_UPDATE_CHECK_INTERVAL_MS);
  }

  async #checkForDocumentUpdate(): Promise<void> {
    const reviewDocument = this.#document;
    const checkForUpdate = this.#ports.documents.checkForUpdate?.bind(this.#ports.documents);
    if (
      !reviewDocument ||
      !checkForUpdate ||
      this.#destroyed ||
      this.#root.visibilityState === "hidden" ||
      this.#documentBusy ||
      this.#documentUpdateCheckInFlight ||
      this.#activeLoad !== null ||
      this.#activeRecovery !== null ||
      this.#documentUpdateAvailable ||
      this.#sendingIds.size > 0
    ) {
      return;
    }
    const generation = this.#generation;
    this.#documentUpdateCheckInFlight = true;
    try {
      const changed = await checkForUpdate({
        reviewSessionId: reviewDocument.reviewSessionId,
        path: reviewDocument.path,
        revision: reviewDocument.revision,
      });
      if (
        !changed ||
        this.#destroyed ||
        generation !== this.#generation ||
        this.#document?.reviewSessionId !== reviewDocument.reviewSessionId
      ) {
        return;
      }
      this.#showDocumentUpdateAvailable();
    } catch (error) {
      if (this.#destroyed || generation !== this.#generation) return;
      if (isExpiredSessionError(error)) await this.#recoverExpiredSession();
      // Transient background checks stay silent and retry on the next interval.
    } finally {
      this.#documentUpdateCheckInFlight = false;
      if (
        !this.#destroyed &&
        generation === this.#generation &&
        this.#activeLoad === null &&
        this.#activeRecovery === null
      ) {
        this.#setBusy(false);
      }
    }
  }

  async #refreshDocument(): Promise<boolean> {
    if (!this.#document) {
      this.#toast("No Markdown file is open.");
      return false;
    }
    if (!this.#element("review-composer").hidden) {
      this.#toast("Queue or close the open comment before refreshing the Markdown file.");
      return false;
    }
    const sessionId = this.#document.reviewSessionId;
    if (
      this.#activeLoad?.reviewSessionId === sessionId &&
      this.#activeLoad.generation === this.#generation
    ) {
      return this.#activeLoad.promise;
    }
    const generation = ++this.#generation;
    this.#setBusy(true);
    this.#setMeta(`Loading ${this.#document.filename}…`);
    const promise = Promise.resolve().then(async (): Promise<boolean> => {
      try {
        const refreshed = await this.#ports.documents.refresh(sessionId);
        if (generation !== this.#generation) return false;
        this.#clearDocumentUpdate();
        this.#renderDocument(refreshed, generation);
        return true;
      } catch (error) {
        if (generation !== this.#generation) return false;
        if (isExpiredSessionError(error)) {
          this.#activeLoad = null;
          return await this.#recoverExpiredSession();
        }
        this.#showLoadError(error);
        return false;
      } finally {
        if (generation === this.#generation) {
          this.#setBusy(false);
          if (this.#activeLoad?.generation === generation) this.#activeLoad = null;
        }
      }
    });
    this.#activeLoad = { reviewSessionId: sessionId, generation, promise };
    return promise;
  }

  #handleDocumentClick(event: MouseEvent): void {
    if (!(event.target instanceof this.#view.Element)) return;
    const retry = event.target.closest<HTMLButtonElement>(".image-retry");
    if (retry) {
      const placeholder = retry.closest<HTMLElement>("[data-local-image-id]");
      if (placeholder && this.#document) {
        placeholder.dataset["loading"] = "";
        void this.#installLocalImages(this.#document, this.#generation);
      }
      return;
    }
    const imageTarget = event.target.closest<HTMLButtonElement>("button.image-review-target");
    if (imageTarget) {
      event.preventDefault();
      this.#openImageComposer(imageTarget);
      return;
    }
    const annotation = event.target.closest<HTMLElement>("[data-feedback-annotation]");
    if (annotation) {
      const item = this.#round.persisted.queue.find(
        (candidate) => candidate.id === annotation.dataset["feedbackAnnotation"],
      );
      const block = item ? this.#findAnchorBlock(item) : null;
      if (item && block) {
        this.#openComposer(
          { ...item, block },
          {
            editingId: item.id,
            feedback: item.feedback,
            invoker: annotation,
            revision: item.revision,
          },
        );
      }
      return;
    }
    const queueButton = event.target.closest<HTMLButtonElement>("[data-queue-action]");
    if (queueButton) {
      const card = queueButton.closest<HTMLElement>(".queued-card");
      const item = this.#round.persisted.queue.find(
        (candidate) => candidate.id === card?.dataset["feedbackId"],
      );
      if (!item) return;
      if (queueButton.dataset["queueAction"] === "remove") this.#requestRemoveComment(item);
      else if (queueButton.dataset["queueAction"] === "edit") {
        const block = this.#findAnchorBlock(item);
        if (block) {
          this.#openComposer(
            { ...item, block },
            {
              editingId: item.id,
              feedback: item.feedback,
              invoker: queueButton,
              revision: item.revision,
            },
          );
        }
      }
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>(".markdown a[data-review-href]");
    const href = link?.dataset["reviewHref"];
    if (!link || !href) return;
    event.preventDefault();
    const nativeSelection = this.#view.getSelection?.();
    if (
      event.detail > 0 &&
      nativeSelection &&
      !nativeSelection.isCollapsed &&
      nativeSelection.toString().trim() &&
      Array.from({ length: nativeSelection.rangeCount }, (_, index) =>
        nativeSelection.getRangeAt(index),
      ).some((range) => this.#rangeIntersectsTarget(range, link))
    ) {
      return;
    }
    if (
      this.#ports.presentation.capabilities.externalLinks === false ||
      !this.#ports.presentation.openExternal
    ) {
      this.#toast("External links are not available in this host.");
      return;
    }
    try {
      const url = new URL(href, "https://markdown-review.invalid/");
      if (url.origin === "https://markdown-review.invalid") {
        throw new Error("Relative links cannot leave the review surface");
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
        throw new Error("This link protocol is not allowed");
      }
      void this.#ports.presentation.openExternal(url).catch((error: unknown) => {
        this.#toast(`Could not open link: ${errorMessage(error)}`);
      });
    } catch (error) {
      this.#toast(`Could not open link: ${errorMessage(error)}`);
    }
  }

  #handleCommentsClick(event: MouseEvent): void {
    if (!(event.target instanceof this.#view.Element)) return;
    const button = event.target.closest<HTMLButtonElement>("[data-comment-action]");
    const entry = button?.closest<HTMLElement>("[data-comment-serial]");
    if (!button || !entry) return;
    const serial = Number(entry.dataset["commentSerial"]);
    const item = this.#allComments().find((candidate) => candidate.serial === serial);
    if (!item) return;
    if (button.dataset["commentAction"] === "reference") this.#insertCommentReference(serial);
    else if (button.dataset["commentAction"] === "go") {
      const block = this.#findAnchorBlock(item);
      this.#closeCommentsPanel(false);
      this.#focusQueuedAnnotation(item.id, block);
    }
  }

  #installListeners(): void {
    const signal = this.#abort.signal;
    this.#view.addEventListener(
      "scroll",
      () => {
        this.#closeContextMenu(false);
        this.#closeSubmissionMenu(this.#element("submit-menu").contains(this.#root.activeElement));
        this.#scheduleSelectionAction(false);
      },
      { capture: true, passive: true, signal },
    );
    this.#view.addEventListener(
      "resize",
      () => {
        this.#closeContextMenu(false);
        this.#closeSubmissionMenu(this.#element("submit-menu").contains(this.#root.activeElement));
        this.#scheduleSelectionAction(false);
      },
      { passive: true, signal },
    );
    this.#root.addEventListener(
      "selectionchange",
      () => {
        this.#captureSelection();
      },
      { signal },
    );
    this.#root.addEventListener(
      "pointerup",
      () => {
        this.#scheduleSelectionAction(true);
      },
      { signal },
    );
    this.#root.addEventListener(
      "pointerdown",
      (event) => {
        if (!(event.target instanceof this.#view.Node)) return;
        const menu = this.#element("review-context-menu");
        if (
          !menu.contains(event.target) &&
          !this.#element("review-actions").contains(event.target)
        ) {
          this.#closeContextMenu(false);
        }
        if (!this.#element("submit-actions").contains(event.target)) {
          this.#closeSubmissionMenu(false);
        }
        if (event.button === 2) {
          this.#captureSelection();
          this.#secondarySelection = this.#selectionSnapshotAtPointer(event);
        }
        if (!this.#element("composer-help-popover").hidden) {
          if (
            this.#element("composer-help-popover").contains(event.target) ||
            this.#element("composer-help-toggle").contains(event.target)
          )
            return;
          this.#setComposerHelp(false);
        }
      },
      { signal },
    );
    this.#root.addEventListener(
      "contextmenu",
      (event) => {
        if (!(event instanceof this.#view.MouseEvent)) return;
        if (this.#allowNativeDevTools && event.shiftKey) {
          this.#secondarySelection = null;
          this.#closeContextMenu(false);
          return;
        }
        event.preventDefault();
        const secondarySelection = this.#secondarySelection;
        this.#secondarySelection = null;
        if (!(event.target instanceof this.#view.Element)) return;
        const surface = this.#element("document");
        if (!surface.contains(event.target) && event.target !== surface) {
          this.#closeContextMenu(false);
          return;
        }
        const snapshot = this.#targetIsReviewUi(event.target)
          ? { selection: null, copyText: null }
          : (secondarySelection ??
            (event.clientX === 0 && event.clientY === 0
              ? this.#selectionSnapshotForTarget(event.target)
              : this.#selectionSnapshotAtPointer(event)));
        const imageTarget = event.target.closest<HTMLButtonElement>("button.image-review-target");
        const invoker =
          imageTarget ?? event.target.closest<HTMLElement>(".review-block") ?? surface;
        this.#element("selection-action").hidden = true;
        this.#showContextMenu({
          x: event.clientX,
          y: event.clientY,
          selection: snapshot.selection,
          copyText: snapshot.copyText,
          ...(snapshot.range !== undefined ? { range: snapshot.range } : {}),
          ...(snapshot.direction ? { direction: snapshot.direction } : {}),
          imageTarget,
          invoker,
        });
      },
      { capture: true, signal },
    );
    this.#root.addEventListener(
      "compositionstart",
      () => {
        this.#compositionActive = true;
      },
      { signal },
    );
    this.#root.addEventListener(
      "compositionend",
      () => {
        this.#compositionActive = false;
      },
      { signal },
    );
    this.#root.addEventListener(
      "keydown",
      (event) => {
        const legacyKeyCode = Reflect.get(event, "keyCode");
        const editableTarget =
          event.target instanceof this.#view.Element &&
          Boolean(
            event.target.closest(
              'textarea, input, select, [contenteditable]:not([contenteditable="false"])',
            ),
          );
        if (
          !event.defaultPrevented &&
          event.key === "Enter" &&
          event.shiftKey &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.repeat &&
          !event.isComposing &&
          !this.#compositionActive &&
          legacyKeyCode !== 229 &&
          !editableTarget &&
          this.#canSubmit()
        ) {
          event.preventDefault();
          this.#closeSubmissionMenu(false);
          void this.#sendFeedbackItems();
          return;
        }
        if (this.#handleSubmissionMenuKeydown(event)) return;
        if (this.#handleContextMenuKeydown(event)) return;
        if (
          (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) &&
          event.target instanceof this.#view.Element
        ) {
          const surface = this.#element("document");
          if (surface.contains(event.target) || event.target === surface) {
            event.preventDefault();
            const target =
              event.target.closest<HTMLElement>("button.image-review-target, .review-block") ??
              surface;
            const rect = target.getBoundingClientRect();
            const snapshot = this.#selectionSnapshotForTarget(target);
            this.#showContextMenu({
              x: rect.left,
              y: rect.bottom,
              selection: snapshot.selection,
              copyText: snapshot.copyText,
              ...(snapshot.range !== undefined ? { range: snapshot.range } : {}),
              ...(snapshot.direction ? { direction: snapshot.direction } : {}),
              imageTarget: target.closest<HTMLButtonElement>("button.image-review-target"),
              invoker: target,
            });
            return;
          }
        }
        if (event.key === "Escape" && !this.#element("composer-help-popover").hidden) {
          event.preventDefault();
          this.#setComposerHelp(false, true);
        } else if (event.key === "Escape" && !this.#element("comments-panel").hidden) {
          event.preventDefault();
          this.#closeCommentsPanel();
        } else if (event.key === "Escape" && !this.#element("review-composer").hidden) {
          event.preventDefault();
          this.#requestCloseComposer();
        } else if (event.key === "Escape" && this.#pendingSelection) {
          event.preventDefault();
          this.#dismissPendingSelection();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          event.key.toLowerCase() === "m" &&
          this.#pendingSelection &&
          this.#element("review-composer").hidden
        ) {
          event.preventDefault();
          this.#openComposer(this.#pendingSelection);
        }
        if (
          (event.key === "Enter" || event.key === " ") &&
          event.target instanceof this.#view.Element &&
          event.target.closest(".markdown a[data-review-href]")
        ) {
          event.preventDefault();
          event.target.closest<HTMLElement>(".markdown a[data-review-href]")?.click();
        }
      },
      { signal },
    );

    this.#element("review-actions").addEventListener(
      "click",
      () => {
        const button = this.#element<HTMLButtonElement>("review-actions");
        const rect = button.getBoundingClientRect();
        this.#showContextMenu({
          x: rect.right - 240,
          y: rect.bottom + 6,
          selection: this.#pendingSelection,
          copyText: this.#selectionCopyText,
          range: this.#selectionRange,
          direction: this.#selectionDirection,
          invoker: button,
        });
      },
      { signal },
    );
    this.#element("review-context-menu").addEventListener(
      "click",
      (event) => {
        if (!(event.target instanceof this.#view.Element)) return;
        const item = event.target.closest<HTMLButtonElement>("[data-context-action]");
        if (item && !item.disabled) {
          this.#handleContextMenuAction(item.dataset["contextAction"] ?? "");
        }
      },
      { signal },
    );

    this.#element("selection-action").addEventListener(
      "pointerdown",
      (event) => {
        event.preventDefault();
      },
      { signal },
    );
    this.#element("selection-action").addEventListener(
      "click",
      () => {
        this.#openComposer(this.#pendingSelection);
      },
      { signal },
    );
    this.#element("open-review").addEventListener(
      "click",
      () => {
        void this.#requestFullscreen();
      },
      { signal },
    );
    this.#element("close-composer").addEventListener(
      "click",
      () => {
        this.#requestCloseComposer();
      },
      { signal },
    );
    this.#element("composer-help-toggle").addEventListener(
      "click",
      () => {
        this.#setComposerHelp(this.#element("composer-help-popover").hidden);
      },
      { signal },
    );
    this.#element("comments-toggle").addEventListener(
      "click",
      () => {
        if (this.#element("comments-panel").hidden) this.#openCommentsPanel();
        else this.#closeCommentsPanel();
      },
      { signal },
    );
    this.#element("close-comments").addEventListener(
      "click",
      () => {
        this.#closeCommentsPanel();
      },
      { signal },
    );
    this.#element("feedback").addEventListener(
      "input",
      () => {
        this.#updateComposerActions();
      },
      { signal },
    );
    this.#element("feedback").addEventListener(
      "focus",
      () => {
        this.#setComposerHelp(false);
      },
      { signal },
    );
    this.#element("feedback").addEventListener(
      "keydown",
      (event) => {
        if (!(event instanceof this.#view.KeyboardEvent)) return;
        const legacyKeyCode = Reflect.get(event, "keyCode");
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || legacyKeyCode === 229)
          return;
        event.preventDefault();
        const field = this.#element<HTMLTextAreaElement>("feedback");
        if (!field.value.trim()) {
          this.#element("feedback-message").classList.add("warning");
          this.#element("feedback-message").textContent = "Write feedback before queueing.";
        } else if (!this.#element<HTMLButtonElement>("add-queue").disabled) {
          this.#queueCurrent();
        }
      },
      { signal },
    );
    this.#element("add-queue").addEventListener(
      "click",
      () => {
        this.#queueCurrent();
      },
      { signal },
    );
    this.#element("send-all").addEventListener(
      "click",
      () => {
        void this.#sendFeedbackItems();
      },
      { signal },
    );
    this.#element("submit-options").addEventListener(
      "click",
      () => {
        this.#toggleSubmissionMenu();
      },
      { signal },
    );
    this.#element("submit-review").addEventListener(
      "click",
      () => {
        void this.#sendFeedbackItems("review");
      },
      { signal },
    );
    this.#element("theme-toggle").addEventListener(
      "click",
      () => {
        const theme = this.#currentTheme() === "light" ? "dark" : "light";
        this.#applyTheme(theme);
        this.#round = createReviewRoundState(
          normalizePersistedReviewState(
            { ...this.#round.persisted, theme },
            new Date().toISOString(),
          ),
        );
        void this.#persistState();
      },
      { signal },
    );
    this.#element("refresh").addEventListener(
      "click",
      () => {
        void this.#refreshDocument().then((loaded) => {
          this.#toast(
            loaded ? "Reloaded from the .md file." : "The last good review is still shown.",
          );
        });
      },
      { signal },
    );
    this.#element("document-update-refresh").addEventListener(
      "click",
      () => {
        void this.#refreshDocument().then((loaded) => {
          this.#toast(
            loaded ? "Loaded the latest .md version." : "The current review is still shown.",
          );
        });
      },
      { signal },
    );
    this.#element("document-update-dismiss").addEventListener(
      "click",
      () => {
        this.#dismissDocumentUpdate();
      },
      { signal },
    );
    this.#view.addEventListener(
      "focus",
      () => {
        void this.#checkForDocumentUpdate();
      },
      { signal },
    );
    this.#root.addEventListener(
      "visibilitychange",
      () => {
        if (this.#root.visibilityState !== "hidden") void this.#checkForDocumentUpdate();
      },
      { signal },
    );
    this.#element("document").addEventListener(
      "click",
      (event) => {
        if (event instanceof this.#view.MouseEvent) this.#handleDocumentClick(event);
      },
      { signal },
    );
    this.#element("comments-list").addEventListener(
      "click",
      (event) => {
        if (event instanceof this.#view.MouseEvent) this.#handleCommentsClick(event);
      },
      { signal },
    );
  }
}

export function mountMarkdownReview(options: MountMarkdownReviewOptions): MarkdownReviewHandle {
  const controller = new MarkdownReviewController(options);
  void controller.start(options.initialDocument);
  return controller;
}
