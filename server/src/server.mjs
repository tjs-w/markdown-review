import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { open as openFile, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";

const TEMPLATE_URI = "ui://markdown-review/v15.html";
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_INLINE_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_IMAGES = 8;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_INLINE_IMAGE_TOTAL_PIXELS = 24_000_000;
const IMAGE_CHUNK_BYTES = 24 * 1024;
const MAX_CACHED_DOCUMENTS = 6;
const IMAGE_MIME_TYPES = new Map([[".png", "image/png"]]);
const componentPath = resolve(process.cwd(), "web/review.html");
const pngDecoderPath = resolve(process.cwd(), "web/dist/png-decoder.js");
const pngDecoderMarker = "<!-- MARKDOWN_REVIEW_PNG_DECODER -->";
const documentCache = new Map();

const server = new McpServer(
  { name: "markdown-review", version: "0.1.0" },
  {
    capabilities: { tools: {}, resources: {} },
    instructions:
      "Use open_markdown_review only to render an absolute .md or .markdown path. The Markdown file is canonical. Review comments have stable #N serials within one queued review round and may reference earlier queued comments by serial; treat #N as a reference only when the feedback payload explicitly lists it as one, because literal #N text is supported. The component sends the full queue as one batch, clears it after a successful send, and restarts numbering at #1. Discuss question-only items without editing, apply explicit change requests with Codex filesystem tools, then reopen the review after any edits.",
  },
);

function countNewlines(value) {
  return (value.match(/\n/g) ?? []).length;
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function encodeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function imageNotice(alt, message) {
  return `<span class="local-image image-notice" role="img" aria-label="${encodeHtmlAttribute(alt)}"><span class="local-image-status">${encodeHtmlAttribute(message)}</span></span>`;
}

function readPngDimensions(path) {
  const header = Buffer.alloc(24);
  const descriptor = openSync(path, "r");
  let bytesRead;
  try {
    bytesRead = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytesRead < header.length || !header.subarray(0, 8).equals(signature) || header.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("The file is not a valid PNG.");
  }
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (!width || !height) throw new Error("The PNG has invalid dimensions.");
  return { width, height, pixels: width * height };
}

function extractLocalImages(html, markdownPath, imageBundle) {
  const documentDirectory = realpathSync(dirname(markdownPath));

  return html.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, (match, rawSource) => {
    const alt = decodeHtmlAttribute(match.match(/\balt="([^"]*)"/i)?.[1] ?? "Local Markdown image");
    if (imageBundle.items.length >= MAX_INLINE_IMAGES) {
      return imageNotice(alt, `Image not rendered: this review supports up to ${MAX_INLINE_IMAGES} local images.`);
    }

    const decodedSource = decodeHtmlAttribute(rawSource);
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(decodedSource) || isAbsolute(decodedSource)) {
      return imageNotice(alt, "Image not rendered: only relative local PNG paths are supported.");
    }

    const pathWithoutSuffix = decodedSource.split(/[?#]/, 1)[0];
    let localPath;
    try {
      localPath = decodeURIComponent(pathWithoutSuffix);
    } catch {
      return imageNotice(alt, "Image not rendered: the path is invalid.");
    }

    try {
      const candidatePath = realpathSync(resolve(documentDirectory, localPath));
      const pathFromDocument = relative(documentDirectory, candidatePath);
      if (pathFromDocument === "" || pathFromDocument === ".." || pathFromDocument.startsWith(`..${sep}`) || isAbsolute(pathFromDocument)) {
        return imageNotice(alt, "Image not rendered: the path is outside the Markdown folder.");
      }

      const mimeType = IMAGE_MIME_TYPES.get(extname(candidatePath).toLowerCase());
      if (!mimeType) return imageNotice(alt, "Image not rendered: use a PNG file for local review images.");

      const info = statSync(candidatePath);
      if (!info.isFile() || info.size === 0) {
        return imageNotice(alt, "Image not rendered: the local file is empty or unavailable.");
      }
      if (info.size > MAX_INLINE_IMAGE_BYTES || imageBundle.totalBytes + info.size > MAX_INLINE_IMAGE_TOTAL_BYTES) {
        return imageNotice(alt, "Image not rendered: the file exceeds the review size limit.");
      }
      const { width, height, pixels } = readPngDimensions(candidatePath);
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || pixels > MAX_IMAGE_PIXELS) {
        return imageNotice(alt, "Image not rendered: its decoded dimensions exceed the safety limit.");
      }
      if (imageBundle.totalPixels + pixels > MAX_INLINE_IMAGE_TOTAL_PIXELS) {
        return imageNotice(alt, "Image not rendered: the document exceeds the decoded image limit.");
      }

      const id = `local-image-${imageBundle.items.length + 1}`;
      const imageRevision = createHash("sha256")
        .update(`${candidatePath}\0${info.size}\0${info.mtimeMs}`)
        .digest("hex")
        .slice(0, 16);
      imageBundle.items.push({
        id,
        mimeType,
        filePath: candidatePath,
        revision: imageRevision,
        modifiedAt: info.mtime.toISOString(),
        byteLength: info.size,
        chunkCount: Math.ceil(info.size / IMAGE_CHUNK_BYTES),
        width,
        height,
      });
      imageBundle.totalBytes += info.size;
      imageBundle.totalPixels += pixels;
      return `<span class="local-image" data-local-image-id="${id}" data-alt="${encodeHtmlAttribute(alt)}" role="status" aria-live="polite" style="aspect-ratio:${width}/${height}"><span class="local-image-status">Image queued…</span></span>`;
    } catch (error) {
      const message = error instanceof Error && /valid PNG/.test(error.message)
        ? error.message
        : "The local file could not be loaded.";
      return imageNotice(alt, `Image not rendered: ${message}`);
    }
  });
}

function renderBlocks(markdown, markdownPath) {
  const tokens = marked.lexer(markdown, { gfm: true });
  const blocks = [];
  const imageBundle = { items: [], totalBytes: 0, totalPixels: 0 };
  let cursor = 0;

  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    if (!raw || token.type === "space") {
      cursor += raw.length;
      continue;
    }

    let startIndex = markdown.indexOf(raw, cursor);
    if (startIndex < 0) startIndex = cursor;
    const endIndex = Math.min(markdown.length, startIndex + raw.length);
    const startLine = 1 + countNewlines(markdown.slice(0, startIndex));
    const endLine = Math.max(startLine, startLine + countNewlines(raw) - (raw.endsWith("\n") ? 1 : 0));
    const rendered = marked.parse(raw, { gfm: true, async: false });
    const safe = sanitizeHtml(String(rendered), {
      allowedTags: [
        ...sanitizeHtml.defaults.allowedTags,
        "details",
        "summary",
        "input",
        "img",
      ],
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

    const safeWithLocalImages = extractLocalImages(safe, markdownPath, imageBundle);
    blocks.push(
      `<section class="review-block" data-start-line="${startLine}" data-end-line="${endLine}">${safeWithLocalImages}</section>`,
    );
    cursor = endIndex;
  }

  return { html: blocks.join("\n"), blockCount: blocks.length, tokens, images: imageBundle.items };
}

function firstHeading(tokens) {
  const heading = tokens.find((token) => token.type === "heading");
  return heading && typeof heading.text === "string" ? heading.text.replace(/<[^>]+>/g, "").trim() : null;
}

function cacheDocument(document) {
  const key = `${document.path}\0${document.revision}`;
  documentCache.delete(key);
  documentCache.set(key, document);
  while (documentCache.size > MAX_CACHED_DOCUMENTS) {
    documentCache.delete(documentCache.keys().next().value);
  }
}

function componentDocument(document) {
  return {
    ...document,
    images: document.images.map(({ filePath: _filePath, ...image }) => image),
  };
}

async function loadMarkdown(pathInput) {
  if (!isAbsolute(pathInput)) {
    throw new Error("Pass an absolute Markdown file path.");
  }

  const path = resolve(pathInput);
  if (![".md", ".markdown"].includes(extname(path).toLowerCase())) {
    throw new Error("Markdown Review only opens .md and .markdown files.");
  }

  const info = await stat(path);
  if (!info.isFile()) throw new Error("The path must point to a regular file.");
  if (info.size > MAX_MARKDOWN_BYTES) {
    throw new Error("The Markdown file is larger than the 2 MB review limit.");
  }

  const markdown = await readFile(path, "utf8");
  const { html, blockCount, tokens, images } = renderBlocks(markdown, path);
  const revision = createHash("sha256").update(markdown).digest("hex").slice(0, 16);
  const filename = path.split("/").at(-1) ?? path;
  const lineCount = markdown.length === 0 ? 0 : markdown.split(/\r?\n/).length;
  const title = firstHeading(tokens) ?? filename;

  const document = {
    kind: "markdown-review-document",
    path,
    filename,
    title,
    revision,
    modifiedAt: info.mtime.toISOString(),
    sizeBytes: info.size,
    lineCount,
    blockCount,
    html,
    images,
  };
  cacheDocument(document);
  return document;
}

registerAppResource(server, "markdown-review-ui", TEMPLATE_URI, {}, async () => {
  const [template, pngDecoder] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(pngDecoderPath, "utf8"),
  ]);
  if (!template.includes(pngDecoderMarker)) {
    throw new Error("The Markdown Review template is missing its PNG decoder marker.");
  }
  const html = template.replace(
    pngDecoderMarker,
    `<script>${pngDecoder.replaceAll("</script", "<\\/script")}</script>`,
  );
  return {
    contents: [
      {
        uri: TEMPLATE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: { connectDomains: [], resourceDomains: [] },
          },
          "openai/widgetDescription":
            "Fullscreen rendered Markdown review with copy-friendly selection and queued, line-anchored feedback for the underlying source file.",
          "openai/widgetPrefersBorder": true,
        },
      },
    ],
  };
});

registerAppTool(
  server,
  "open_markdown_review",
  {
    title: "Open Markdown review",
    description:
      "Render a local Markdown file in an interactive review UI. Pass the absolute .md or .markdown path. The tool is read-only; Codex edits the source file with its normal filesystem tools after the user sends feedback.",
    inputSchema: {
      path: z.string().min(1).max(4096).describe("Absolute path to a .md or .markdown file"),
    },
    outputSchema: {
      path: z.string(),
      filename: z.string(),
      title: z.string(),
      revision: z.string(),
      modifiedAt: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      lineCount: z.number().int().nonnegative(),
      blockCount: z.number().int().nonnegative(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: {
      ui: { resourceUri: TEMPLATE_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": TEMPLATE_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Opening Markdown…",
      "openai/toolInvocation/invoked": "Markdown ready",
    },
  },
  async ({ path }) => {
    try {
      const document = await loadMarkdown(path);
      const reviewDocument = componentDocument(document);
      const { html: _html, images: _images, kind: _kind, ...summary } = document;
      return {
        structuredContent: summary,
        content: [
          {
            type: "text",
            text: `Opened ${document.filename} for review (${document.lineCount} lines, revision ${document.revision}). The full rendered document is available only to the review component.`,
          },
        ],
        _meta: { document: reviewDocument },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `Could not open Markdown review: ${message}` }],
        _meta: {
          document: {
            kind: "markdown-review-document",
            path,
            error: message,
          },
        },
      };
    }
  },
);

registerAppTool(
  server,
  "load_markdown_review_document",
  {
    title: "Load Markdown review document",
    description:
      "Load the rendered Markdown document for the review component. This read-only tool is available only to the component UI.",
    inputSchema: {
      path: z.string().min(1).max(4096).describe("Absolute path to a .md or .markdown file"),
    },
    outputSchema: {
      path: z.string(),
      filename: z.string(),
      title: z.string(),
      revision: z.string(),
      modifiedAt: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      lineCount: z.number().int().nonnegative(),
      blockCount: z.number().int().nonnegative(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: {
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
    },
  },
  async ({ path }) => {
    try {
      const document = await loadMarkdown(path);
      const reviewDocument = componentDocument(document);
      const { html: _html, images: _images, kind: _kind, ...summary } = document;
      return {
        structuredContent: summary,
        content: [],
        _meta: { document: reviewDocument },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `Could not load Markdown review document: ${message}` }],
        _meta: {
          document: {
            kind: "markdown-review-document",
            path,
            error: message,
          },
        },
      };
    }
  },
);

registerAppTool(
  server,
  "load_markdown_review_image_chunk",
  {
    title: "Load Markdown review image chunk",
    description:
      "Load one bounded binary chunk for a local image already referenced by the active Markdown review. This read-only transport tool is available only to the component UI.",
    inputSchema: {
      path: z.string().min(1).max(4096),
      revision: z.string().min(1).max(128),
      imageId: z.string().min(1).max(128),
      chunkIndex: z.number().int().nonnegative().max(10000),
    },
    outputSchema: {
      kind: z.literal("markdown-review-image-chunk"),
      path: z.string(),
      revision: z.string(),
      imageId: z.string(),
      imageRevision: z.string(),
      mimeType: z.string(),
      chunkIndex: z.number().int().nonnegative(),
      chunkCount: z.number().int().positive(),
      byteOffset: z.number().int().nonnegative(),
      byteLength: z.number().int().positive(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: {
      ui: { visibility: ["app"] },
      "openai/visibility": "private",
      "openai/widgetAccessible": true,
    },
  },
  async ({ path, revision, imageId, chunkIndex }) => {
    try {
      const resolvedPath = resolve(path);
      const cacheKey = `${resolvedPath}\0${revision}`;
      let document = documentCache.get(cacheKey);
      if (!document) document = await loadMarkdown(resolvedPath);
      if (document.revision !== revision) {
        throw new Error("The Markdown changed; refresh the review before loading its images.");
      }

      const image = document.images.find((candidate) => candidate.id === imageId);
      if (!image) throw new Error("The requested image is not part of this Markdown review.");
      if (chunkIndex >= image.chunkCount) throw new Error("The requested image chunk is out of range.");

      const currentInfo = await stat(image.filePath);
      if (
        !currentInfo.isFile() ||
        currentInfo.size !== image.byteLength ||
        currentInfo.mtime.toISOString() !== image.modifiedAt
      ) {
        throw new Error("The image changed; refresh the review before loading it.");
      }

      const byteOffset = chunkIndex * IMAGE_CHUNK_BYTES;
      const requestedBytes = Math.min(IMAGE_CHUNK_BYTES, image.byteLength - byteOffset);
      const buffer = Buffer.allocUnsafe(requestedBytes);
      const handle = await openFile(image.filePath, "r");
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, requestedBytes, byteOffset));
      } finally {
        await handle.close();
      }
      if (bytesRead !== requestedBytes) throw new Error("The image chunk could not be read completely.");

      const imageChunk = {
        kind: "markdown-review-image-chunk",
        path: document.path,
        revision: document.revision,
        imageId: image.id,
        imageRevision: image.revision,
        mimeType: image.mimeType,
        chunkIndex,
        chunkCount: image.chunkCount,
        byteOffset,
        byteLength: bytesRead,
      };
      return {
        structuredContent: imageChunk,
        content: [],
        _meta: { imageChunk: { ...imageChunk, data: buffer.toString("base64") } },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text", text: `Could not load Markdown review image: ${message}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  process.stderr.write(`Markdown Review MCP failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
