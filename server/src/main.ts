import { resolve } from "node:path";

import {
  createFileReviewUiAssetLoader,
  createMarkdownReviewServer,
} from "@markdown-review/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const pluginRoot = resolve(__dirname, "../..");
const assetLoader = createFileReviewUiAssetLoader({
  templatePath: resolve(pluginRoot, "web/review.html"),
  pngDecoderPath: resolve(pluginRoot, "web/dist/png-decoder.js"),
  reviewBundlePath: resolve(pluginRoot, "web/dist/review.js"),
});
const server = createMarkdownReviewServer({ assetLoader });
const transport = new StdioServerTransport();

server.connect(transport).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Markdown Review MCP failed: ${message}\n`);
  process.exitCode = 1;
});
