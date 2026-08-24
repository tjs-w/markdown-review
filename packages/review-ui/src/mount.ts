import {
  IMAGE_CHUNK_BYTES,
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
import { shouldRetryPortError } from "./ports";
import {
  captureReviewTextAnchor,
  clearReviewHighlights,
  findReviewHighlightBlock,
  renderReviewHighlights,
} from "./review-highlights";

const IMAGE_WORKERS = 2;
const CHUNK_WORKERS = 4;
const MAX_QUEUE_ITEMS = 20;

interface ActiveSelection extends ReviewSelection {
  readonly block: HTMLElement;
}

interface ActiveLoad {
  readonly reviewSessionId: string;
  readonly generation: number;
  readonly promise: Promise<boolean>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function makeId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `review-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function lineLabel(selection: Pick<ReviewSelection, "startLine" | "endLine"> | null): string {
  if (!selection) return "No selection";
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
  #document: ReviewDocument | null = null;
  #lastGoodDocument: ReviewDocument | null = null;
  #round: ReviewRoundState;
  #pendingSelection: ActiveSelection | null = null;
  #selection: ActiveSelection | null = null;
  #editingId: string | null = null;
  #generation = 0;
  #renderKey: string | null = null;
  #activeLoad: ActiveLoad | null = null;
  #decodedImages = new Map<string, Promise<DecodedReviewImage>>();
  #fullscreenRequestedFor: string | null = null;
  #inlineReviewFallback = false;
  #sendingIds = new Set<string>();
  #returnFocus: HTMLElement | null = null;
  #lastSelectionAnnouncement: string | null = null;
  #toastTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.#abort.abort();
    this.#decodedImages.clear();
    this.#unsubscribePresentation();
    clearReviewHighlights(this.#element("document"));
    if (this.#toastTimer !== undefined) clearTimeout(this.#toastTimer);
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
      if (generation === this.#generation) this.#setBusy(false);
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
    this.#element<HTMLButtonElement>("refresh").disabled =
      busy ||
      !this.#element("review-composer").hidden ||
      this.#ports.presentation.capabilities.documentTools === false;
  }

  #setMeta(message: string, error = false): void {
    const meta = this.#element("meta");
    meta.textContent = message;
    meta.classList.toggle("error", error);
    meta.setAttribute("role", error ? "alert" : "status");
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

  #applyTheme(theme: ReviewTheme): void {
    this.#root.documentElement.dataset["theme"] = theme;
    const toggle = this.#element<HTMLButtonElement>("theme-toggle");
    const useDark = theme === "light";
    toggle.title = useDark ? "Use dark theme" : "Use light theme";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(theme === "dark"));
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
    const stacks = new Map<HTMLElement, Map<number, number>>();
    for (const item of this.#round.persisted.queue) {
      if (item.path !== this.#document?.path) continue;
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

    for (const [block, items] of groups) {
      const first = items[0];
      if (!first) continue;
      const group = this.#root.createElement("section");
      group.className = "queued-group";
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
          button.setAttribute(
            "aria-label",
            `${text} for comment ${item.serial}, ${lineLabel(item)}`,
          );
          actions.appendChild(button);
        }
        card.append(head, quote, feedback, actions);
        group.appendChild(card);
      }
      block.insertAdjacentElement("afterend", group);
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
      quote.textContent = `${lineLabel(item)} · ${item.quote || "Markdown passage"}`;
      const feedback = this.#root.createElement("div");
      feedback.className = "comment-index-feedback";
      feedback.textContent = parseCommentFeedback(item.feedback).text;
      const actions = this.#root.createElement("div");
      actions.className = "comment-index-actions";
      const go = this.#root.createElement("button");
      go.type = "button";
      go.className = "button";
      go.dataset["commentAction"] = "go";
      go.textContent = item.imageId ? "Go to image" : "Go to passage";
      go.setAttribute(
        "aria-label",
        `Go to ${item.imageId ? "image" : "passage"} for comment ${item.serial}`,
      );
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
    const send = this.#element<HTMLButtonElement>("send-all");
    send.hidden = count === 0;
    this.#element("send-all-label").textContent = sending ? "Submitting…" : "Submit";
    this.#element("send-all-count").textContent = `(${count})`;
    const composerOpen = !this.#element("review-composer").hidden;
    const submissionUnavailable = this.#ports.presentation.capabilities.submission === false;
    send.disabled = count === 0 || sending || composerOpen || submissionUnavailable;
    send.setAttribute(
      "aria-label",
      submissionUnavailable
        ? "Submitting review feedback is unavailable in this host"
        : sending
          ? "Submitting review feedback"
          : composerOpen
            ? "Queue or close the open comment before submitting feedback"
            : `Submit ${count} queued comments`,
    );
    this.#element("launcher-meta").textContent = count
      ? `${count} ${count === 1 ? "feedback item" : "feedback items"} queued`
      : "Open fullscreen review";
    this.#renderCommentsPanel();
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
    block.setAttribute("tabindex", "-1");
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

  #captureSelection(): void {
    const nativeSelection = this.#view.getSelection?.();
    if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount === 0) {
      this.#pendingSelection = null;
      this.#element("selection-action").hidden = true;
      return;
    }
    const nativeQuote = nativeSelection.toString().trim();
    if (!nativeQuote) {
      this.#pendingSelection = null;
      this.#element("selection-action").hidden = true;
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
    if (!(startNode instanceof this.#view.Element) || !(endNode instanceof this.#view.Element))
      return;
    const startBlock = startNode.closest<HTMLElement>(".review-block");
    const endBlock = endNode.closest<HTMLElement>(".review-block") ?? startBlock;
    if (!startBlock || !endBlock || !this.#element("document").contains(startBlock)) {
      this.#pendingSelection = null;
      this.#element("selection-action").hidden = true;
      return;
    }
    const startLine = Number(startBlock.dataset["startLine"]);
    const endLine = Number(endBlock.dataset["endLine"]);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) return;
    const captured = captureReviewTextAnchor(this.#element("document"), range);
    const quote = (captured?.quote ?? nativeQuote).slice(0, 1400);
    const rect = range.getBoundingClientRect();
    const blockRect = endBlock.getBoundingClientRect();
    this.#pendingSelection = {
      startLine,
      endLine,
      anchorX: clamp(
        (rect.left + rect.width / 2 - blockRect.left) / Math.max(1, blockRect.width),
        0.96,
      ),
      anchorY: clamp((rect.bottom - blockRect.top) / Math.max(1, blockRect.height), 1),
      quote,
      ...(captured && captured.quote.length <= 1400 ? { textAnchor: captured.textAnchor } : {}),
      block: endBlock,
    };
    const button = this.#element<HTMLButtonElement>("selection-action");
    button.setAttribute(
      "aria-label",
      `Add feedback for selection, ${lineLabel(this.#pendingSelection)}`,
    );
    button.style.left = `${Math.max(8, Math.min(this.#view.innerWidth - 42, rect.left + rect.width / 2 - 17))}px`;
    button.style.top = `${Math.max(8, Math.min(this.#view.innerHeight - 44, rect.bottom + 7))}px`;
    button.hidden = false;
    const announcement = `${lineLabel(this.#pendingSelection)}\n${this.#pendingSelection.quote}`;
    if (announcement !== this.#lastSelectionAnnouncement) {
      this.#lastSelectionAnnouncement = announcement;
      this.#element("selection-status").textContent =
        `Selection ready for feedback, ${lineLabel(this.#pendingSelection)}. ` +
        "Activate Add feedback or press Control or Command plus Shift plus M.";
    }
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
    this.#pendingSelection = null;
    this.#element("selection-action").hidden = true;
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
    this.#element<HTMLButtonElement>("refresh").disabled =
      this.#documentBusy ||
      !this.#element("review-composer").hidden ||
      this.#ports.presentation.capabilities.documentTools === false;
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

  #openComposer(
    selection: ActiveSelection | null,
    options: {
      readonly editingId?: string | null;
      readonly feedback?: string;
      readonly invoker?: HTMLElement | null;
    } = {},
  ): void {
    if (!selection?.block) return;
    this.#root.querySelectorAll(".review-block.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    this.#root.querySelectorAll(".image-review-target.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    selection.block.classList.add("is-selected");
    this.#selection = {
      startLine: selection.startLine,
      endLine: selection.endLine,
      anchorX: clamp(selection.anchorX, 0.96),
      anchorY: clamp(selection.anchorY, 1),
      quote: selection.quote.slice(0, 1400),
      ...(selection.textAnchor ? { textAnchor: selection.textAnchor } : {}),
      ...(selection.imageId ? { imageId: selection.imageId } : {}),
      block: selection.block,
    };
    this.#findImageTarget(this.#selection, selection.block)?.classList.add("is-selected");
    this.#editingId = options.editingId ?? null;
    this.#returnFocus =
      options.invoker && options.invoker !== this.#element("selection-action")
        ? options.invoker
        : selection.block;
    this.#element("composer-title").textContent = this.#editingId
      ? "Edit queued feedback"
      : "Add feedback";
    this.#element("line-pill").textContent = lineLabel(this.#selection);
    this.#element("quote").textContent = this.#selection.quote || "Markdown passage";
    this.#element<HTMLTextAreaElement>("feedback").value = options.feedback ?? "";
    this.#element("add-queue-label").textContent = this.#editingId ? "Save" : "Queue";
    this.#element("add-queue").setAttribute(
      "aria-label",
      this.#editingId ? "Save feedback" : "Queue feedback",
    );
    selection.block.insertAdjacentElement("afterend", this.#element("review-composer"));
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
    this.#element<HTMLTextAreaElement>("feedback").value = "";
    this.#editingId = null;
    this.#selection = null;
    this.#returnFocus = null;
    this.#root.querySelectorAll(".review-block.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
    this.#root.querySelectorAll(".image-review-target.is-selected").forEach((element) => {
      element.classList.remove("is-selected");
    });
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
    const feedback = this.#element<HTMLTextAreaElement>("feedback").value;
    const selection = this.#selection;
    const editingId = this.#editingId;
    const invoker = this.#returnFocus;
    this.#closeComposer();
    if (!feedback.trim() || !selection) return;
    this.#toast("Draft discarded.", {
      actionLabel: "Undo",
      onAction: () => {
        this.#openComposer(selection, { editingId, feedback, invoker });
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
        revision: this.#document.revision,
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

  async #sendFeedbackItems(): Promise<void> {
    if (!this.#document || this.#round.persisted.queue.length === 0 || this.#sendingIds.size > 0)
      return;
    if (this.#ports.presentation.capabilities.submission === false) {
      this.#toast("Submitting review feedback is unavailable in this host.");
      return;
    }
    if (!this.#element("review-composer").hidden) {
      this.#toast("Queue or close the open comment before submitting this review round.");
      return;
    }
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
      const completedState = completeReviewSubmission(
        this.#round,
        prepared.submission.submissionId,
        new Date().toISOString(),
      );
      await this.#ports.submissions.submit(prepared.submission);
      accepted = true;
      this.#round = completedState;
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
      if (succeeded) {
        const next = this.#round.persisted.queue[0];
        if (next) this.#focusQueuedAnnotation(next.id, this.#findAnchorBlock(next));
        else if (fallback) this.#focusReviewBlock(fallback);
        else this.#element("comments-toggle").focus();
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
    const key = JSON.stringify([
      reviewDocument.reviewSessionId,
      reviewDocument.revision,
      image.id,
      image.revision,
    ]);
    const cached = this.#decodedImages.get(key);
    if (cached) return cached;
    const promise = (async (): Promise<DecodedReviewImage> => {
      const bytes = await this.#loadImageBytes(reviewDocument, image, placeholder, generation);
      if (generation !== this.#generation) throw new Error("Image load superseded");
      if (!this.#imageDecoder) throw new Error("Native browser image decoding is unavailable");
      const decoded = await this.#imageDecoder.decode(bytes, image.mimeType);
      if (decoded.width !== image.width || decoded.height !== image.height) {
        throw new Error("Decoded dimensions did not match the review");
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
      this.#syncImageTargetStates();
    } catch (error) {
      if (this.#destroyed) return;
      if (generation === this.#generation && !errorMessage(error).includes("superseded")) {
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
    let totalPixels = 0;
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
      if (totalPixels + pixels > MAX_INLINE_IMAGE_TOTAL_PIXELS) {
        this.#setPermanentImageError(placeholder, "the document exceeds the decoded image limit");
        continue;
      }
      totalPixels += pixels;
      placeholder.dataset["imageApproved"] = "true";
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
    this.#generation = Math.max(this.#generation, generation);
    this.#decodedImages.clear();
    this.#document = reviewDocument;
    this.#lastGoodDocument = reviewDocument;
    this.#renderKey = key;
    const title = reviewDocument.title || reviewDocument.filename || "Markdown Review";
    this.#element("title").textContent = title;
    this.#element("launcher-title").textContent = title;
    this.#setMeta(
      `${reviewDocument.filename} · ${reviewDocument.lineCount} lines · rev ${reviewDocument.revision}`,
    );
    this.#closeComposer(false, false);
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
    this.#prepareLocalImages(reviewDocument);
    this.#closeCommentsPanel(false);
    if (this.#round.persisted.path !== reviewDocument.path) {
      this.#round = createReviewRoundState(
        normalizePersistedReviewState(null, new Date().toISOString()),
      );
    }
    this.#renderQueueCards();
    void this.#installLocalImages(reviewDocument, this.#generation);
    this.#requestDefaultFullscreen(reviewDocument);
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
    if (this.#activeLoad?.reviewSessionId === sessionId) return this.#activeLoad.promise;
    const generation = ++this.#generation;
    this.#setBusy(true);
    this.#setMeta(`Loading ${this.#document.filename}…`);
    const promise = (async (): Promise<boolean> => {
      try {
        const refreshed = await this.#ports.documents.refresh(sessionId);
        if (generation !== this.#generation) return false;
        this.#renderDocument(refreshed, generation);
        return true;
      } catch (error) {
        if (generation !== this.#generation) return false;
        this.#showLoadError(error);
        return false;
      } finally {
        if (generation === this.#generation) {
          this.#setBusy(false);
          if (this.#activeLoad?.generation === generation) this.#activeLoad = null;
        }
      }
    })();
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
          { editingId: item.id, feedback: item.feedback, invoker: annotation },
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
            { editingId: item.id, feedback: item.feedback, invoker: queueButton },
          );
        }
      }
      return;
    }
    const link = event.target.closest<HTMLAnchorElement>(".markdown a[data-review-href]");
    const href = link?.dataset["reviewHref"];
    if (!link || !href) return;
    event.preventDefault();
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
        this.#pendingSelection = null;
        this.#element("selection-action").hidden = true;
      },
      { capture: true, passive: true, signal },
    );
    this.#root.addEventListener(
      "selectionchange",
      () => {
        this.#captureSelection();
      },
      { signal },
    );
    this.#root.addEventListener(
      "pointerdown",
      (event) => {
        if (this.#element("composer-help-popover").hidden) return;
        if (!(event.target instanceof this.#view.Node)) return;
        if (
          this.#element("composer-help-popover").contains(event.target) ||
          this.#element("composer-help-toggle").contains(event.target)
        )
          return;
        this.#setComposerHelp(false);
      },
      { signal },
    );
    this.#root.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !this.#element("composer-help-popover").hidden) {
          event.preventDefault();
          this.#setComposerHelp(false, true);
        } else if (event.key === "Escape" && !this.#element("comments-panel").hidden) {
          event.preventDefault();
          this.#closeCommentsPanel();
        } else if (event.key === "Escape" && !this.#element("review-composer").hidden) {
          event.preventDefault();
          this.#requestCloseComposer();
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
