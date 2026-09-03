import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FlowZoneUiAssetLoader } from "./assets.js";

export const FLOWZONE_TEMPLATE_URI = "ui://flowzone/v5.html";
export const LEGACY_FLOWZONE_TEMPLATE_URIS = [
  "ui://flowzone/v1.html",
  "ui://flowzone/v2.html",
  "ui://flowzone/v3.html",
  "ui://flowzone/v4.html",
] as const;
export const LEGACY_MARKDOWN_REVIEW_TEMPLATE_URI = "ui://markdown-review/v30.html";

const FLOWZONE_BUNDLE_MARKER = "<!-- FLOWZONE_APP -->";
const LEGACY_BUNDLE_MARKER = "<!-- MARKDOWN_REVIEW_APP -->";
const DYNA_BUNDLE_MARKER = "<!-- DYNA_APP -->";

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

function configureHtml(
  template: string,
  bundle: string,
  developerMode: boolean,
  stylesheet?: string,
): string {
  const marker = template.includes(FLOWZONE_BUNDLE_MARKER)
    ? FLOWZONE_BUNDLE_MARKER
    : template.includes(LEGACY_BUNDLE_MARKER)
      ? LEGACY_BUNDLE_MARKER
      : template.includes(DYNA_BUNDLE_MARKER)
        ? DYNA_BUNDLE_MARKER
        : undefined;
  if (!marker) throw new Error("The FlowZone template is missing its application bundle marker.");
  const styledTemplate = stylesheet
    ? template.replace(
        "</head>",
        `<style>${stylesheet.replaceAll("</style", "<\\/style")}</style></head>`,
      )
    : template;
  const html = styledTemplate.replace(
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

export interface FlowZoneAdditionalUiResource {
  readonly name: string;
  readonly resourceUri: string;
  readonly assetLoader: FlowZoneUiAssetLoader;
  readonly description: string;
  readonly permissions?: Readonly<Record<string, unknown>>;
}

export function registerFlowZoneUiResource(
  server: McpServer,
  resource: FlowZoneAdditionalUiResource,
  allowNativeDevTools = false,
): void {
  const metadata = {
    prefersBorder: true,
    csp: {
      connectDomains: [] as string[],
      resourceDomains: [] as string[],
      frameDomains: [] as string[],
    },
    ...(resource.permissions ? { permissions: resource.permissions } : {}),
  };
  registerAppResource(
    server,
    resource.name,
    resource.resourceUri,
    { _meta: { ui: metadata } },
    async () => {
      const { template, bundle, stylesheet } = await resource.assetLoader.load();
      return {
        contents: [
          {
            uri: resource.resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: configureHtml(template, bundle, allowNativeDevTools, stylesheet),
            _meta: {
              ui: metadata,
              "openai/widgetDescription": resource.description,
              "openai/widgetPrefersBorder": true,
            },
          },
        ],
      };
    },
  );
}

export function registerFlowZoneUi(server: McpServer, options: RegisterFlowZoneUiOptions): void {
  const register = (name: string, resourceUri: string): void => {
    registerFlowZoneUiResource(
      server,
      {
        name,
        resourceUri,
        assetLoader: options.assetLoader,
        description: "FlowZone renders the app view selected by a registered plugin action.",
        permissions: UI_METADATA.permissions,
      },
      options.allowNativeDevTools === true,
    );
  };

  register("FlowZone UI", FLOWZONE_TEMPLATE_URI);
  for (const resourceUri of LEGACY_FLOWZONE_TEMPLATE_URIS) {
    register(`FlowZone UI (legacy ${resourceUri})`, resourceUri);
  }
  if (options.includeLegacyMarkdownAlias !== false) {
    register("Markdown Review UI (legacy URI)", LEGACY_MARKDOWN_REVIEW_TEMPLATE_URI);
  }
}
