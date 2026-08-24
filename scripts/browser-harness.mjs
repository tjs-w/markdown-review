import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownPath = resolve(process.argv[2] ?? resolve(pluginRoot, "scripts/fixture.md"));
const port = Number(process.env.MARKDOWN_REVIEW_PORT ?? 43117);
const previewComposer = process.env.MARKDOWN_REVIEW_PREVIEW_COMPOSER === "1";
const transport = new StdioClientTransport({
  command: "node",
  args: ["server/dist/server.cjs"],
  cwd: pluginRoot,
  stderr: "pipe",
});
const client = new Client({ name: "markdown-review-browser-harness", version: "0.1.0" });
await client.connect(transport);

const resource = await client.readResource({ uri: "ui://markdown-review/v15.html" });
const opened = await client.callTool({
  name: "open_markdown_review",
  arguments: { path: markdownPath },
});
if (opened.isError) throw new Error(opened.content?.[0]?.text ?? "Could not open browser fixture.");

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const hostScript = `
<script>
  window.__markdownReviewHost = { messages: [], widgetState: null };
  window.openai = {
    theme: "light",
    displayMode: "inline",
    toolResponseMetadata: ${safeJson(opened)},
    setWidgetState(state) { window.__markdownReviewHost.widgetState = state; },
    notifyIntrinsicHeight() {},
    openExternal() {},
    async requestDisplayMode({ mode }) {
      this.displayMode = mode;
      window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals: this } }));
      return { mode };
    },
  };
  window.addEventListener("message", async (event) => {
    const request = event.data;
    if (
      event.source !== window ||
      !request ||
      request.jsonrpc !== "2.0" ||
      request.id === undefined ||
      typeof request.method !== "string"
    ) return;
    try {
      let result = {};
      if (request.method === "ui/initialize") {
        result = {
          protocolVersion: "2026-01-26",
          hostInfo: { name: "markdown-review-browser-harness", version: "0.1.0" },
          hostCapabilities: {},
          hostContext: {},
        };
      } else if (request.method === "tools/call") {
        const response = await fetch("/call", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request.params),
        });
        result = await response.json();
      } else if (request.method === "ui/message") {
        window.__markdownReviewHost.messages.push(request.params);
      }
      window.postMessage({ jsonrpc: "2.0", id: request.id, result }, "*");
    } catch (error) {
      window.postMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: String(error?.message ?? error) },
      }, "*");
    }
  });
</script>`;
const previewScript = previewComposer ? `
<script>
  function openPreviewComposer() {
    const block = document.querySelector(".review-block");
    if (!block || typeof openComposer !== "function") return setTimeout(openPreviewComposer, 50);
    openComposer({
      startLine: Number(block.dataset.startLine),
      endLine: Number(block.dataset.endLine),
      anchorX: 0.94,
      anchorY: 0.9,
      quote: block.innerText,
      block,
    });
  }
  setTimeout(openPreviewComposer, 100);
</script>` : "";
const page = resource.contents[0].text
  .replace("<body>", `<body>${hostScript}`)
  .replace("</body>", `${previewScript}</body>`);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
    return;
  }
  if (request.method === "GET" && request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === "POST" && request.url === "/call") {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    try {
      const input = JSON.parse(Buffer.concat(body).toString("utf8"));
      const result = await client.callTool({ name: input.name, arguments: input.arguments ?? {} });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
    return;
  }
  response.writeHead(404);
  response.end("Not found");
});

await new Promise((resolveListen) => server.listen(port, "127.0.0.1", resolveListen));
process.stdout.write(`Markdown Review browser harness: http://127.0.0.1:${port}\n`);

async function shutdown() {
  await new Promise((resolveClose) => server.close(resolveClose));
  await client.close();
}
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
