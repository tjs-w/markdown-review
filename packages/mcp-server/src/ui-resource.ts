import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FlowZoneUiAssetLoader } from "./assets.js";

export const FLOWZONE_TEMPLATE_URI = "ui://flowzone/v1.html";
export const LEGACY_MARKDOWN_REVIEW_TEMPLATE_URI = "ui://markdown-review/v30.html";

const FLOWZONE_BUNDLE_MARKER = "<!-- FLOWZONE_APP -->";
const LEGACY_BUNDLE_MARKER = "<!-- MARKDOWN_REVIEW_APP -->";

const UI_METADATA = {
  prefersBorder: true,
  csp: {
    connectDomains: [] as string[],
    resourceDomains: [] as string[],
    frameDomains: [] as string[],
  },
  permissions: { clipboardWrite: {} },
};

export interface RegisterFlowZoneUiOptions {
  readonly assetLoader: FlowZoneUiAssetLoader;
  readonly allowNativeDevTools?: boolean;
  readonly includeLegacyMarkdownAlias?: boolean;
}

function configureHtml(template: string, bundle: string, developerMode: boolean): string {
  const marker = template.includes(FLOWZONE_BUNDLE_MARKER)
    ? FLOWZONE_BUNDLE_MARKER
    : template.includes(LEGACY_BUNDLE_MARKER)
      ? LEGACY_BUNDLE_MARKER
      : undefined;
  if (!marker) throw new Error("The FlowZone template is missing its application bundle marker.");
  const html = template.replace(
    marker,
    () => `<script>${bundle.replaceAll("</script", "<\\/script")}</script>`,
  );
  return developerMode
    ? html.replace(
        "<html",
        '<html data-flowzone-developer-mode="true" data-markdown-review-developer-mode="true"',
      )
    : html;
}

export function registerFlowZoneUi(server: McpServer, options: RegisterFlowZoneUiOptions): void {
  const register = (name: string, resourceUri: string): void => {
    registerAppResource(server, name, resourceUri, { _meta: { ui: UI_METADATA } }, async () => {
      const { template, bundle } = await options.assetLoader.load();
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: configureHtml(template, bundle, options.allowNativeDevTools === true),
            _meta: {
              ui: UI_METADATA,
              "openai/widgetDescription":
                "FlowZone renders the app view selected by a registered plugin action.",
              "openai/widgetPrefersBorder": true,
            },
          },
        ],
      };
    });
  };

  register("FlowZone UI", FLOWZONE_TEMPLATE_URI);
  if (options.includeLegacyMarkdownAlias !== false) {
    register("Markdown Review UI (legacy URI)", LEGACY_MARKDOWN_REVIEW_TEMPLATE_URI);
  }
}
