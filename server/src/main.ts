import { resolve } from "node:path";

import {
  createFlowZoneServer,
  createFileFlowZoneUiAssetLoader,
  createMarkdownReviewPlugin,
  developerModeEnabled,
} from "@flowzone/mcp-server";
import { createDynaPlugin } from "@flowzone/mcp-server/dyna";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const pluginRoot = resolve(__dirname, "../..");
const assetLoader = createFileFlowZoneUiAssetLoader({
  templatePath: resolve(pluginRoot, "web/flowzone.html"),
  bundlePath: resolve(pluginRoot, "web/dist/flowzone.js"),
});
const dynaAssetLoader = createFileFlowZoneUiAssetLoader({
  templatePath: resolve(pluginRoot, "web/dyna.html"),
  bundlePath: resolve(pluginRoot, "web/dist/dyna.js"),
  stylesheetPath: resolve(pluginRoot, "web/dist/dyna.css"),
});
const server = createFlowZoneServer({
  assetLoader,
  allowNativeDevTools: developerModeEnabled(process.env["FLOWZONE_DEVTOOLS"]),
  uiResources: [
    {
      name: "FlowZone Dyna UI",
      resourceUri: "ui://flowzone/dyna/v1.html",
      assetLoader: dynaAssetLoader,
      description:
        "Dyna is a responsive executive dashboard for prioritized scheduled signals and Codex actions.",
    },
  ],
  plugins: [createMarkdownReviewPlugin(), createDynaPlugin()],
});
const transport = new StdioServerTransport();

server.connect(transport).catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`FlowZone MCP failed: ${message}\n`);
  process.exitCode = 1;
});
