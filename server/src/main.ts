import { resolve } from "node:path";

import {
  createFlowZoneServer,
  createFileFlowZoneUiAssetLoader,
  createMarkdownReviewPlugin,
  developerModeEnabled,
} from "@flowzone/mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const pluginRoot = resolve(__dirname, "../..");
const assetLoader = createFileFlowZoneUiAssetLoader({
  templatePath: resolve(pluginRoot, "web/flowzone.html"),
  bundlePath: resolve(pluginRoot, "web/dist/flowzone.js"),
});
const server = createFlowZoneServer({
  assetLoader,
  allowNativeDevTools: developerModeEnabled(process.env["FLOWZONE_DEVTOOLS"]),
  plugins: [createMarkdownReviewPlugin()],
});
const transport = new StdioServerTransport();

server.connect(transport).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`FlowZone MCP failed: ${message}\n`);
  process.exitCode = 1;
});
