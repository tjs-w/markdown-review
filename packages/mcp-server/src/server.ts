import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FlowZoneUiAssetLoader } from "./assets.js";
import type { FlowZonePlugin } from "./plugin.js";
import { createFlowZoneRegistry } from "./registry.js";
import { registerFlowZoneAppTools, registerFlowZoneRouter } from "./router.js";
import { registerFlowZoneUi } from "./ui-resource.js";

const MAX_VERSION_LENGTH = 64;
const FLOWZONE_INSTRUCTIONS =
  "FlowZone exposes one router tool backed by a fixed startup registry. Choose only plugin and action values advertised by the tool schema. Plugin skills provide workflow guidance; they are not runtime backends.";

export interface CreateFlowZoneServerOptions {
  readonly plugins: readonly FlowZonePlugin[];
  readonly assetLoader: FlowZoneUiAssetLoader;
  readonly allowNativeDevTools?: boolean;
  readonly includeLegacyMarkdownAlias?: boolean;
  readonly version?: string;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

export function createFlowZoneServer(options: CreateFlowZoneServerOptions): McpServer {
  const version = options.version ?? "0.1.0";
  if (
    version.length === 0 ||
    version.length > MAX_VERSION_LENGTH ||
    version.trim() !== version ||
    containsControlCharacter(version)
  ) {
    throw new Error(
      `FlowZone version must be 1-${String(MAX_VERSION_LENGTH)} trimmed characters without control characters.`,
    );
  }
  const registry = createFlowZoneRegistry(options.plugins);
  const server = new McpServer(
    { name: "flowzone", version },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: FLOWZONE_INSTRUCTIONS,
    },
  );
  registerFlowZoneUi(server, {
    assetLoader: options.assetLoader,
    ...(options.allowNativeDevTools !== undefined
      ? { allowNativeDevTools: options.allowNativeDevTools }
      : {}),
    ...(options.includeLegacyMarkdownAlias !== undefined
      ? { includeLegacyMarkdownAlias: options.includeLegacyMarkdownAlias }
      : {}),
  });
  registerFlowZoneRouter(server, registry);
  registerFlowZoneAppTools(server, registry);
  return server;
}

export type { FlowZonePlugin } from "./plugin.js";
