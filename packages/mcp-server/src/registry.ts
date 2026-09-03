import { Buffer } from "node:buffer";

import {
  FLOWZONE_ACTION_ID_PATTERN,
  FLOWZONE_APP_TOOL_NAME_PATTERN,
  FLOWZONE_PLUGIN_ID_PATTERN,
  FLOWZONE_VIEW_ID_PATTERN,
  FlowZoneResultBaseSchema,
  MAX_FLOWZONE_ACTIONS,
  MAX_FLOWZONE_ACTIONS_PER_PLUGIN,
  MAX_FLOWZONE_PLUGINS,
} from "@flowzone/contracts";
import { z } from "zod";

import { prepareExecutor } from "./executors/index.js";
import type {
  FlowZoneAction,
  FlowZoneAppTool,
  FlowZoneCredentialProvider,
  FlowZoneExecutor,
  FlowZonePlugin,
} from "./plugin.js";

const MAX_DISPLAY_NAME_LENGTH = 96;
const MAX_VERSION_LENGTH = 64;
const MAX_TITLE_LENGTH = 128;
const MAX_DESCRIPTION_BYTES = 8 * 1024;
const MAX_SCHEMA_BYTES = 256 * 1024;

export interface RegisteredFlowZoneAction {
  readonly plugin: FlowZonePlugin;
  readonly action: FlowZoneAction;
  readonly key: string;
}

export interface RegisteredFlowZoneAppTool {
  readonly plugin: FlowZonePlugin;
  readonly tool: FlowZoneAppTool;
}

export interface RegisteredFlowZonePresentation extends RegisteredFlowZoneAction {
  readonly presentation: NonNullable<FlowZoneAction["presentation"]>;
}

export interface FlowZoneRegistry {
  readonly plugins: readonly FlowZonePlugin[];
  readonly actions: readonly RegisteredFlowZoneAction[];
  readonly routerActions: readonly RegisteredFlowZoneAction[];
  readonly presentations: readonly RegisteredFlowZonePresentation[];
  readonly appTools: readonly RegisteredFlowZoneAppTool[];
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  findRouter(plugin: string, action: string): RegisteredFlowZoneAction | undefined;
  /** Compatibility lookup for execution-policy tests and non-routing callers. */
  find(plugin: string, action: string): RegisteredFlowZoneAction | undefined;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function validateBoundedText(
  value: string,
  label: string,
  maximum: number,
  measureBytes = false,
): void {
  const length = measureBytes ? Buffer.byteLength(value, "utf8") : value.length;
  if (
    value.length === 0 ||
    value.trim() !== value ||
    length > maximum ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${label} is invalid or exceeds its ${String(maximum)} character/byte limit.`);
  }
}

function assertObjectSchema(schema: z.ZodType, label: string): void {
  let json: unknown;
  try {
    json = z.toJSONSchema(schema);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} cannot be converted to JSON Schema: ${message}`);
  }
  const serialized = JSON.stringify(json);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    throw new Error(`${label} exceeds the ${String(MAX_SCHEMA_BYTES)} byte schema limit.`);
  }
  const isObjectBranch = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return (value as Readonly<Record<string, unknown>>)["type"] === "object";
  };
  const jsonRecord =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Readonly<Record<string, unknown>>)
      : undefined;
  const branches =
    jsonRecord === undefined ? undefined : (jsonRecord["anyOf"] ?? jsonRecord["oneOf"]);
  const hasObjectRoot =
    isObjectBranch(json) ||
    (Array.isArray(branches) && branches.length > 0 && branches.every(isObjectBranch));
  if (!hasObjectRoot) {
    throw new Error(`${label} must describe an object.`);
  }
}

function assertSdkOutputSchema(schema: z.ZodType, label: string): void {
  assertObjectSchema(schema, label);
  const json = z.toJSONSchema(schema);
  if ((json as Readonly<Record<string, unknown>>)["type"] !== "object") {
    throw new Error(`${label} must be a direct object schema for MCP output validation.`);
  }
}

function unionOrSingle(schemas: readonly z.ZodType[]): z.ZodType {
  const first = schemas[0];
  if (!first) {
    return z.object({ unavailable: z.never() }).strict();
  }
  if (schemas.length === 1) return first;
  return z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

function routeKey(plugin: string, action: string): string {
  return `${plugin}.${action}`;
}

function snapshotCredentialProvider(
  provider: FlowZoneCredentialProvider | undefined,
): FlowZoneCredentialProvider | undefined {
  return provider ? Object.freeze({ get: provider.get.bind(provider) }) : undefined;
}

function snapshotExecutor(executor: FlowZoneExecutor): FlowZoneExecutor {
  switch (executor.kind) {
    case "module":
      return Object.freeze({ kind: "module", execute: executor.execute });
    case "cli": {
      const cliCredentialProvider = snapshotCredentialProvider(executor.credentialProvider);
      return Object.freeze({
        kind: "cli",
        executable: executor.executable,
        cwd: executor.cwd,
        ...(executor.args ? { args: Object.freeze([...executor.args]) } : {}),
        ...(executor.inheritEnv ? { inheritEnv: Object.freeze([...executor.inheritEnv]) } : {}),
        ...(executor.env ? { env: Object.freeze({ ...executor.env }) } : {}),
        ...(cliCredentialProvider ? { credentialProvider: cliCredentialProvider } : {}),
        ...(executor.integrityFiles
          ? { integrityFiles: Object.freeze([...executor.integrityFiles]) }
          : {}),
        ...(executor.timeoutMs !== undefined ? { timeoutMs: executor.timeoutMs } : {}),
      });
    }
    case "http": {
      const httpCredentialProvider = snapshotCredentialProvider(executor.credentialProvider);
      return Object.freeze({
        kind: "http",
        endpoint: executor.endpoint,
        ...(executor.headers ? { headers: Object.freeze({ ...executor.headers }) } : {}),
        ...(httpCredentialProvider ? { credentialProvider: httpCredentialProvider } : {}),
        ...(executor.timeoutMs !== undefined ? { timeoutMs: executor.timeoutMs } : {}),
        ...(executor.fetcher ? { fetcher: executor.fetcher } : {}),
      });
    }
  }
}

function snapshotPlugin(plugin: FlowZonePlugin): FlowZonePlugin {
  const actions = plugin.actions.map((action) =>
    Object.freeze({
      ...action,
      risk: Object.freeze({ ...action.risk }),
      ...(action.ui ? { ui: Object.freeze({ ...action.ui }) } : {}),
      ...(action.presentation ? { presentation: Object.freeze({ ...action.presentation }) } : {}),
      executor: snapshotExecutor(action.executor),
    }),
  );
  const appTools = plugin.appTools?.map((tool) =>
    Object.freeze({ ...tool, annotations: Object.freeze({ ...tool.annotations }) }),
  );
  return Object.freeze({
    id: plugin.id,
    displayName: plugin.displayName,
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    actions: Object.freeze(actions),
    ...(appTools ? { appTools: Object.freeze(appTools) } : {}),
  });
}

export function createFlowZoneRegistry(plugins: readonly FlowZonePlugin[]): FlowZoneRegistry {
  if (plugins.length === 0 || plugins.length > MAX_FLOWZONE_PLUGINS) {
    throw new Error(`FlowZone requires between 1 and ${String(MAX_FLOWZONE_PLUGINS)} plugins.`);
  }
  const registeredPlugins = plugins.map(snapshotPlugin);
  const pluginIds = new Set<string>();
  const appToolNames = new Set<string>(["flowzone"]);
  const routeMap = new Map<string, RegisteredFlowZoneAction>();
  const actionMap = new Map<string, RegisteredFlowZoneAction>();
  const actions: RegisteredFlowZoneAction[] = [];
  const routerActions: RegisteredFlowZoneAction[] = [];
  const presentations: RegisteredFlowZonePresentation[] = [];
  const appTools: RegisteredFlowZoneAppTool[] = [];

  for (const plugin of registeredPlugins) {
    if (!FLOWZONE_PLUGIN_ID_PATTERN.test(plugin.id) || pluginIds.has(plugin.id)) {
      throw new Error(`FlowZone plugin id "${plugin.id}" is invalid or registered more than once.`);
    }
    pluginIds.add(plugin.id);
    validateBoundedText(
      plugin.displayName,
      `FlowZone plugin "${plugin.id}" display name`,
      MAX_DISPLAY_NAME_LENGTH,
    );
    if (plugin.version !== undefined) {
      validateBoundedText(
        plugin.version,
        `FlowZone plugin "${plugin.id}" version`,
        MAX_VERSION_LENGTH,
      );
    }
    if (plugin.actions.length === 0 || plugin.actions.length > MAX_FLOWZONE_ACTIONS_PER_PLUGIN) {
      throw new Error(
        `FlowZone plugin "${plugin.id}" must register between 1 and ${String(MAX_FLOWZONE_ACTIONS_PER_PLUGIN)} actions.`,
      );
    }

    const actionIds = new Set<string>();
    for (const action of plugin.actions) {
      if (!FLOWZONE_ACTION_ID_PATTERN.test(action.id) || actionIds.has(action.id)) {
        throw new Error(
          `FlowZone action id "${plugin.id}.${action.id}" is invalid or registered more than once.`,
        );
      }
      actionIds.add(action.id);
      validateBoundedText(
        action.title,
        `FlowZone action "${plugin.id}.${action.id}" title`,
        MAX_TITLE_LENGTH,
      );
      validateBoundedText(
        action.description,
        `FlowZone action "${plugin.id}.${action.id}" description`,
        MAX_DESCRIPTION_BYTES,
        true,
      );
      assertObjectSchema(action.inputSchema, `FlowZone action "${plugin.id}.${action.id}" input`);
      assertObjectSchema(action.outputSchema, `FlowZone action "${plugin.id}.${action.id}" output`);
      if (action.ui) {
        if (!FLOWZONE_VIEW_ID_PATTERN.test(action.ui.view)) {
          throw new Error(`FlowZone view id "${action.ui.view}" is invalid.`);
        }
        if (
          action.ui.legacyMetaKey !== undefined &&
          !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(action.ui.legacyMetaKey)
        ) {
          throw new Error("FlowZone legacy metadata keys must be simple identifiers.");
        }
        assertObjectSchema(
          action.ui.payloadSchema,
          `FlowZone action "${plugin.id}.${action.id}" UI payload`,
        );
      }
      if (action.presentation) {
        if (
          !FLOWZONE_APP_TOOL_NAME_PATTERN.test(action.presentation.toolName) ||
          appToolNames.has(action.presentation.toolName)
        ) {
          throw new Error(
            `FlowZone presentation tool "${action.presentation.toolName}" is invalid or registered more than once.`,
          );
        }
        if (!action.ui) {
          throw new Error("FlowZone presentation actions must declare a UI payload.");
        }
        if (!action.presentation.resourceUri.startsWith("ui://flowzone/")) {
          throw new Error("FlowZone presentation resources must use the ui://flowzone/ namespace.");
        }
        appToolNames.add(action.presentation.toolName);
      }
      prepareExecutor(action.executor);
      const key = routeKey(plugin.id, action.id);
      const registered = Object.freeze({ plugin, action, key });
      actionMap.set(key, registered);
      actions.push(registered);
      if (action.presentation) {
        presentations.push(Object.freeze({ ...registered, presentation: action.presentation }));
      } else {
        routeMap.set(key, registered);
        routerActions.push(registered);
      }
    }

    for (const tool of plugin.appTools ?? []) {
      if (!FLOWZONE_APP_TOOL_NAME_PATTERN.test(tool.name) || appToolNames.has(tool.name)) {
        throw new Error(
          `FlowZone app tool "${tool.name}" is invalid or registered more than once.`,
        );
      }
      appToolNames.add(tool.name);
      validateBoundedText(tool.title, `FlowZone app tool "${tool.name}" title`, MAX_TITLE_LENGTH);
      validateBoundedText(
        tool.description,
        `FlowZone app tool "${tool.name}" description`,
        MAX_DESCRIPTION_BYTES,
        true,
      );
      assertObjectSchema(tool.inputSchema, `FlowZone app tool "${tool.name}" input`);
      if (tool.outputSchema) {
        assertSdkOutputSchema(tool.outputSchema, `FlowZone app tool "${tool.name}" output`);
      }
      appTools.push(Object.freeze({ plugin, tool }));
    }
  }

  if (actions.length > MAX_FLOWZONE_ACTIONS) {
    throw new Error(`FlowZone supports at most ${String(MAX_FLOWZONE_ACTIONS)} actions.`);
  }

  const inputSchema = unionOrSingle(
    routerActions.map(({ plugin, action }) =>
      z
        .object({
          plugin: z.literal(plugin.id),
          action: z.literal(action.id),
          input: action.inputSchema,
        })
        .strict(),
    ),
  );
  // The SDK currently validates output schemas through its object-schema path.
  // Keep the advertised envelope object-shaped and perform action-specific
  // result validation in the router before returning it.
  const outputSchema = FlowZoneResultBaseSchema;
  assertObjectSchema(inputSchema, "FlowZone router input");
  assertObjectSchema(outputSchema, "FlowZone router output");

  return Object.freeze({
    plugins: Object.freeze(registeredPlugins),
    actions: Object.freeze(actions),
    routerActions: Object.freeze(routerActions),
    presentations: Object.freeze(presentations),
    appTools: Object.freeze(appTools),
    inputSchema,
    outputSchema,
    findRouter(plugin: string, action: string) {
      return routeMap.get(routeKey(plugin, action));
    },
    find(plugin: string, action: string) {
      return actionMap.get(routeKey(plugin, action));
    },
  });
}
