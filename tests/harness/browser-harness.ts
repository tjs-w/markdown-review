import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const ToolCallSchema = z
  .object({
    _meta: z.record(z.string(), z.unknown()).optional(),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const pluginRoot = resolve(import.meta.dir, "../..");
let generatedDirectory: string | undefined;
let markdownPath: string;
if (process.argv[2] === "--generated-fixture") {
  generatedDirectory = await mkdtemp(join(tmpdir(), "markdown-review-browser-"));
  markdownPath = join(generatedDirectory, "review fixture.md");
  await writeFile(
    join(generatedDirectory, "fixture.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    join(generatedDirectory, "fixture.jpg"),
    Buffer.from(
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
      "base64",
    ),
  );
  await writeFile(
    join(generatedDirectory, "fixture.webp"),
    Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
  );
  await writeFile(
    markdownPath,
    "# Markdown Review Fixture\n\nSelect and review this paragraph.\n\n## Images\n\n![PNG pixel](fixture.png)\n\n![JPEG pixel](fixture.jpg)\n\n![WebP pixel](fixture.webp)\n\n## Tasks\n\n- [ ] Pending task\n- [x] Completed task\n- Ordinary list item\n",
  );
} else {
  markdownPath = resolve(process.argv[2] ?? resolve(pluginRoot, "scripts/fixture.md"));
}
const requestedPort = Number(process.env["MARKDOWN_REVIEW_PORT"] ?? 43_117);
const transport = new StdioClientTransport({
  command: "node",
  args: [resolve(pluginRoot, "server/dist/server.cjs")],
  cwd: pluginRoot,
  stderr: "pipe",
});
const client = new Client({ name: "markdown-review-browser-harness", version: "0.1.0" });
await client.connect(transport);

const resource = await client.readResource({ uri: "ui://markdown-review/v29.html" });
const resourceContent = resource.contents[0];
if (!resourceContent || !("text" in resourceContent)) {
  throw new Error("The Markdown Review HTML resource was not returned");
}
const opened = await client.callTool({
  name: "open_markdown_review",
  arguments: { path: markdownPath },
});
if (opened.isError) throw new Error("Could not open the browser-harness Markdown fixture");

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const hostScript = `<script>
(() => {
  const initialResult = ${safeJson(opened)};
  const query = new URLSearchParams(window.location.search);
  const reviewDocument = initialResult._meta.document;
  const updatedReviewDocument = {
    ...reviewDocument,
    reviewSessionId: "323e4567-e89b-42d3-a456-426614174000",
    revision: "browser-latest-revision",
    title: "Markdown Review Fixture",
    images: [],
    html: reviewDocument.html.replace(
      "Select and review this paragraph.",
      "Latest source revision is visible."
    )
  };
  const updatedResult = {
    ...initialResult,
    structuredContent: {
      ...initialResult.structuredContent,
      revision: updatedReviewDocument.revision
    },
    _meta: {
      ...initialResult._meta,
      document: updatedReviewDocument
    }
  };
  const seededWidgetState = query.get("seed") === "1"
    ? {
        privateContent: {
          path: reviewDocument.path,
          theme: "light",
          queue: [{
            id: "browser-harness-feedback-1",
            serial: 1,
            path: reviewDocument.path,
            revision: reviewDocument.revision,
            startLine: 3,
            endLine: 3,
            anchorX: 0.5,
            anchorY: 0.5,
            quote: "Select and review this paragraph.",
            feedback: "Make this sentence more specific.",
            createdAt: "2026-08-24T00:00:00.000Z"
          }],
          nextSerial: 2,
          lastSubmission: null,
          pendingSubmission: null
        }
      }
    : null;
  const state = window.__markdownReviewHost = {
    messages: [],
    directSubmissions: [],
    sizeChanges: [],
    externalLinks: [],
    toolCalls: [],
    toolResults: [],
    clipboardWrites: [],
    widgetState: seededWidgetState,
    setWidgetStateCalls: 0,
    documentUpdateAvailable: false
  };
  window.openai = {
    sendFollowUpMessage(request) {
      state.directSubmissions.push(request);
      document.documentElement.dataset.directSubmissionCount = String(state.directSubmissions.length);
      document.documentElement.dataset.lastDirectSubmission = JSON.stringify(request);
      return Promise.resolve();
    }
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(text) {
        state.clipboardWrites.push(text);
        return Promise.resolve();
      }
    }
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value(command) {
      if (command !== "copy") return false;
      const active = document.activeElement;
      const text = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
        ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
        : window.getSelection()?.toString() ?? "";
      state.clipboardWrites.push(text);
      return true;
    }
  });
  if (query.get("codex") === "1") {
    Object.assign(window.openai, {
      widgetState: seededWidgetState,
      setWidgetState(nextState) {
        state.setWidgetStateCalls += 1;
        window.openai.widgetState = nextState;
        state.widgetState = nextState;
      }
    });
  }
  const respond = (id, result) => window.postMessage({ jsonrpc: "2.0", id, result }, "*");
  const notify = (method, params) => window.postMessage({ jsonrpc: "2.0", method, params }, "*");
  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (event.source !== window || !request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return;
    if (request.id === undefined) {
      if (request.method === "ui/notifications/size-changed") {
        state.sizeChanges.push(request.params);
        document.documentElement.dataset.lastReportedHeight = String(request.params?.height ?? "");
        event.stopImmediatePropagation();
      } else if (request.method === "ui/notifications/initialized") {
        event.stopImmediatePropagation();
      }
      return;
    }
    // The harness hosts the app in the same top-level window. Prevent the app's
    // transport from seeing and rejecting its own outbound host request before
    // this mock host can respond. Real MCP Apps hosts use a parent iframe.
    event.stopImmediatePropagation();
    try {
      let result = {};
      if (request.method === "ui/initialize") {
        result = {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "markdown-review-browser-harness", version: "0.1.0" },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            message: {}
          },
          hostContext: {
            theme: "light",
            displayMode: "inline",
            availableDisplayModes: query.get("inline-only") === "1"
              ? ["inline"]
              : ["inline", "fullscreen"]
          }
        };
        respond(request.id, result);
        setTimeout(() => notify("ui/notifications/tool-result", initialResult), 0);
        return;
      }
      if (request.method === "tools/call") {
        state.toolCalls.push(request.params);
        if (
          query.get("auto-update") === "1" &&
          request.params.name === "check_markdown_review_document"
        ) {
          const document = request.params.arguments;
          const changed = state.documentUpdateAvailable === true &&
            document.revision === reviewDocument.revision;
          result = {
            content: [],
            structuredContent: {
              kind: "markdown-review-update-status",
              reviewSessionId: document.reviewSessionId,
              path: document.path,
              revision: changed ? updatedReviewDocument.revision : document.revision,
              changed
            }
          };
        } else if (
          query.get("auto-update") === "1" &&
          request.params.name === "load_markdown_review_document"
        ) {
          state.documentUpdateAvailable = false;
          result = updatedResult;
        } else {
          const response = await fetch("/call", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request.params)
          });
          result = await response.json();
        }
        state.toolResults.push(result);
      } else if (request.method === "ui/message") {
        state.messages.push(request.params);
        document.documentElement.dataset.submittedMessageCount = String(state.messages.length);
        document.documentElement.dataset.lastSubmittedMessage = JSON.stringify(request.params);
        if (query.get("review-error") === "1") result = { isError: true };
      } else if (request.method === "ui/open-link") {
        state.externalLinks.push(request.params.url);
      } else if (request.method === "ui/request-display-mode") {
        result = { mode: request.params.mode };
        notify("ui/notifications/host-context-changed", { displayMode: request.params.mode });
      }
      respond(request.id, result);
    } catch (error) {
      window.postMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: String(error instanceof Error ? error.message : error) }
      }, "*");
    }
  });
})();
</script>`;

const page = resourceContent.text.replace("<body>", `<body>${hostScript}`);

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else rejectBody(new TypeError("Received an unsupported HTTP request chunk"));
    });
    request.once("end", () => {
      resolveBody(Buffer.concat(chunks));
    });
    request.once("error", rejectBody);
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/") {
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(page);
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/call") {
    try {
      const input = ToolCallSchema.parse(
        JSON.parse((await readRequestBody(request)).toString("utf8")),
      );
      const result = await client.callTool({
        name: input.name,
        arguments: input.arguments ?? {},
      });
      json(response, 200, result);
    } catch (error: unknown) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  response.writeHead(404);
  response.end("Not found");
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(requestedPort, "127.0.0.1", () => {
    resolveListen();
  });
});
const address = server.address();
const port = typeof address === "object" && address ? address.port : requestedPort;
process.stdout.write(`Markdown Review browser harness: http://127.0.0.1:${String(port)}\n`);

async function shutdown(): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
  await client.close();
  if (generatedDirectory) await rm(generatedDirectory, { force: true, recursive: true });
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
