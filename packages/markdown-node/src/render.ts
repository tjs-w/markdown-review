import { createHash } from "node:crypto";

import { MAX_DOCUMENT_TITLE_LENGTH, type ReviewImageDescriptor } from "@markdown-review/contracts";
import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";

import {
  IMAGE_CHUNK_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGE_REFERENCES,
  MAX_INLINE_IMAGE_TOTAL_BYTES,
  MAX_INLINE_IMAGE_TOTAL_PIXELS,
} from "./constants.js";
import { readFileHandleBounded } from "./bounded-read.js";
import type { MarkdownPathPolicy } from "./path-policy.js";
import { readPngDimensions, validatePng } from "./png.js";

export interface StoredImage {
  readonly descriptor: ReviewImageDescriptor;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly blockCount: number;
  readonly title: string | null;
  readonly images: readonly StoredImage[];
}

interface ImageBudget {
  readonly items: StoredImage[];
  readonly snapshotsByPath: Map<string, StoredImage>;
  references: number;
  totalBytes: number;
  totalPixels: number;
}

function countNewlines(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function encodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function imageNotice(alt: string, message: string): string {
  return `<span class="local-image image-notice" role="img" aria-label="${encodeHtmlAttribute(alt)}"><span class="local-image-status">${encodeHtmlAttribute(message)}</span></span>`;
}

function imagePlaceholder(alt: string, image: StoredImage): string {
  const { id, width, height } = image.descriptor;
  return `<span class="local-image" data-local-image-id="${id}" data-alt="${encodeHtmlAttribute(alt)}" role="status" aria-live="polite" style="aspect-ratio:${width}/${height}"><span class="local-image-status">Image queued…</span></span>`;
}

async function snapshotImage(
  source: string,
  alt: string,
  markdownPath: string,
  budget: ImageBudget,
  pathPolicy: MarkdownPathPolicy,
): Promise<string> {
  if (budget.references >= MAX_INLINE_IMAGE_REFERENCES) {
    return imageNotice(
      alt,
      `Image not rendered: this review processes up to ${MAX_INLINE_IMAGE_REFERENCES} local image references.`,
    );
  }
  budget.references += 1;

  try {
    const imagePath = await pathPolicy.resolveLocalImagePath(markdownPath, source);
    const existing = budget.snapshotsByPath.get(imagePath);
    if (existing) {
      const pixels = existing.descriptor.width * existing.descriptor.height;
      if (budget.totalPixels + pixels > MAX_INLINE_IMAGE_TOTAL_PIXELS) {
        throw new Error("the document exceeds the decoded image limit");
      }
      budget.totalPixels += pixels;
      return imagePlaceholder(alt, existing);
    }

    const snapshot = await readFileHandleBounded(
      imagePath,
      MAX_INLINE_IMAGE_BYTES,
      "The local image",
      { expectedCanonicalPath: imagePath },
    );
    if (snapshot.sizeBytes === 0) throw new Error("the local file is empty or unavailable");
    if (budget.totalBytes + snapshot.sizeBytes > MAX_INLINE_IMAGE_TOTAL_BYTES) {
      throw new Error("the document exceeds the review image-size limit");
    }

    const { width, height, pixels } = readPngDimensions(snapshot.bytes);
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || pixels > MAX_IMAGE_PIXELS) {
      throw new Error("its decoded dimensions exceed the safety limit");
    }
    validatePng(snapshot.bytes, { width, height, pixels });
    if (budget.totalPixels + pixels > MAX_INLINE_IMAGE_TOTAL_PIXELS) {
      throw new Error("the document exceeds the decoded image limit");
    }

    const id = `local-image-${budget.items.length + 1}`;
    const sha256 = createHash("sha256").update(snapshot.bytes).digest("hex");
    const descriptor: ReviewImageDescriptor = {
      id,
      mimeType: "image/png",
      revision: sha256,
      modifiedAt: snapshot.modifiedAt,
      byteLength: snapshot.sizeBytes,
      chunkCount: Math.ceil(snapshot.sizeBytes / IMAGE_CHUNK_BYTES),
      width,
      height,
    };
    const stored = { descriptor, bytes: snapshot.bytes, sha256 };
    budget.items.push(stored);
    budget.snapshotsByPath.set(imagePath, stored);
    budget.totalBytes += snapshot.sizeBytes;
    budget.totalPixels += pixels;
    return imagePlaceholder(alt, stored);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "the local file could not be loaded";
    return imageNotice(alt, `Image not rendered: ${reason}.`);
  }
}

async function replaceLocalImages(
  html: string,
  markdownPath: string,
  budget: ImageBudget,
  pathPolicy: MarkdownPathPolicy,
): Promise<string> {
  const pattern = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
  const pieces: string[] = [];
  let cursor = 0;
  for (;;) {
    const match = pattern.exec(html);
    if (!match) break;
    pieces.push(html.slice(cursor, match.index));
    const rawTag = match[0];
    const rawSource = match[1] ?? "";
    const altMatch = /\balt="([^"]*)"/i.exec(rawTag);
    const alt = decodeHtmlAttribute(altMatch?.[1] ?? "Local Markdown image");
    pieces.push(
      await snapshotImage(decodeHtmlAttribute(rawSource), alt, markdownPath, budget, pathPolicy),
    );
    cursor = match.index + rawTag.length;
  }
  pieces.push(html.slice(cursor));
  return pieces.join("");
}

function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "details", "summary", "input", "img"],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "title"],
      code: ["class"],
      img: ["alt", "height", "src", "title", "width"],
      input: ["checked", "disabled", "type"],
      ol: ["start"],
      td: ["align"],
      th: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
  });
}

export async function renderMarkdown(
  markdown: string,
  markdownPath: string,
  pathPolicy: MarkdownPathPolicy,
): Promise<RenderedMarkdown> {
  const tokens = marked.lexer(markdown, { gfm: true });
  const blocks: string[] = [];
  const budget: ImageBudget = {
    items: [],
    snapshotsByPath: new Map(),
    references: 0,
    totalBytes: 0,
    totalPixels: 0,
  };
  let cursor = 0;
  let cursorLine = 1;

  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (!raw || token.type === "space") {
      cursorLine += countNewlines(raw);
      cursor += raw.length;
      continue;
    }
    let startIndex = markdown.indexOf(raw, cursor);
    if (startIndex < 0) startIndex = cursor;
    const endIndex = Math.min(markdown.length, startIndex + raw.length);
    cursorLine += countNewlines(markdown.slice(cursor, startIndex));
    const startLine = cursorLine;
    const tokenNewlines = countNewlines(raw);
    const endLine = Math.max(startLine, startLine + tokenNewlines - (raw.endsWith("\n") ? 1 : 0));
    const rendered = marked.parse(raw, { gfm: true, async: false });
    const sanitized = sanitizeRenderedHtml(rendered);
    const withImages = await replaceLocalImages(sanitized, markdownPath, budget, pathPolicy);
    blocks.push(
      `<section class="review-block" data-start-line="${startLine}" data-end-line="${endLine}">${withImages}</section>`,
    );
    cursor = endIndex;
    cursorLine += tokenNewlines;
  }

  const heading = tokens.find((token): token is Tokens.Heading => token.type === "heading");
  const headingText = heading?.text
    .replace(/<[^>]+>/g, "")
    .trim()
    .slice(0, MAX_DOCUMENT_TITLE_LENGTH);
  let title: string | null = headingText ?? null;
  if (title === "") title = null;
  return { html: blocks.join("\n"), blockCount: blocks.length, title, images: budget.items };
}
