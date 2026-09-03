import { Buffer } from "node:buffer";

import {
  FlowZonePrivateErrorSchema,
  FlowZoneRequestBaseSchema,
  FlowZoneUiEnvelopeBaseSchema,
  MAX_FLOWZONE_MODEL_TEXT_BYTES,
  MAX_FLOWZONE_PRIVATE_RESULT_BYTES,
  MAX_FLOWZONE_PUBLIC_RESULT_BYTES,
  MAX_FLOWZONE_ROUTER_INPUT_BYTES,
} from "@flowzone/contracts";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asFlowZoneExecutionError, FlowZoneExecutionError } from "./errors.js";
import { FlowZoneExecutionPolicy } from "./execution-policy.js";
import type { FlowZoneAppToolContext, FlowZoneProgress } from "./plugin.js";
import type { FlowZoneRegistry, RegisteredFlowZoneAction } from "./registry.js";

const ROUTER_NAME = "flowzone";
const ROUTER_DESCRIPTION =
  "Dispatch one non-visual action from a statically registered FlowZone plugin. Select the plugin and action exactly as defined by the input schema, and place only that action's arguments in input.";

interface ExecutionExtra {
  readonly requestId: string | number;
  readonly signal: AbortSignal;
  readonly progressToken?: string | number;
  readonly sendProgress: (progress: FlowZoneProgress) => Promise<void>;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new FlowZoneExecutionError("invalid_output", "The FlowZone result is not serializable.");
  }
}

function safeSummary(registered: RegisteredFlowZoneAction, result: unknown): string {
  let summary: string;
  try {
    summary =
      registered.action.summarize?.(result) ??
      `${registered.plugin.displayName}: ${registered.action.title} completed.`;
  } catch {
    summary = `${registered.plugin.displayName}: ${registered.action.title} completed.`;
  }
  if (typeof summary !== "string") {
    summary = `${registered.plugin.displayName}: ${registered.action.title} completed.`;
  }
  const sanitized = Array.from(summary, (character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f) ? " " : character;
  }).join("");
  let bounded = "";
  let bytes = 0;
  for (const character of sanitized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_FLOWZONE_MODEL_TEXT_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

function errorResult(error: unknown, plugin?: string, action?: string) {
  const failure = asFlowZoneExecutionError(error);
  const metadata = FlowZonePrivateErrorSchema.parse({
    schema: "flowzone/error-v1",
    ...(plugin ? { plugin } : {}),
    ...(action ? { action } : {}),
    code: failure.code,
    retryable: failure.retryable,
  });
  return {
    isError: true,
    content: [{ type: "text" as const, text: failure.message }],
    _meta: { flowzoneError: metadata },
  };
}

function validateProgress(progress: FlowZoneProgress): FlowZoneProgress {
  if (
    !Number.isFinite(progress.progress) ||
    progress.progress < 0 ||
    (progress.total !== undefined &&
      (!Number.isFinite(progress.total) || progress.total < progress.progress)) ||
    (progress.message !== undefined && Buffer.byteLength(progress.message, "utf8") > 1024)
  ) {
    throw new FlowZoneExecutionError(
      "invalid_output",
      "The FlowZone action reported invalid progress.",
    );
  }
  return progress;
}

export function registerFlowZoneRouter(server: McpServer, registry: FlowZoneRegistry): void {
  const policy = new FlowZoneExecutionPolicy();
  registerAppTool(
    server,
    ROUTER_NAME,
    {
      title: "FlowZone",
      description: ROUTER_DESCRIPTION,
      inputSchema: registry.inputSchema,
      outputSchema: registry.outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: {
        ui: { visibility: ["model"] },
        "openai/widgetAccessible": false,
        "openai/toolInvocation/invoking": "Running FlowZone…",
        "openai/toolInvocation/invoked": "FlowZone ready",
      },
    },
    async (rawRequest, extra) => {
      let request: ReturnType<typeof FlowZoneRequestBaseSchema.parse> | undefined;
      try {
        if (serializedBytes(rawRequest) > MAX_FLOWZONE_ROUTER_INPUT_BYTES) {
          throw new FlowZoneExecutionError("invalid_input", "The FlowZone request is too large.");
        }
        request = FlowZoneRequestBaseSchema.parse(rawRequest);
        const registered = registry.findRouter(request.plugin, request.action);
        if (!registered) {
          throw new FlowZoneExecutionError(
            "invalid_input",
            "The FlowZone action is not registered.",
          );
        }
        const parsedInput = registered.action.inputSchema.safeParse(request.input);
        if (!parsedInput.success) {
          throw new FlowZoneExecutionError(
            "invalid_input",
            "The FlowZone action input is invalid.",
          );
        }
        return await executeRegistered(policy, registered, parsedInput.data, {
          requestId: extra.requestId,
          signal: extra.signal,
          ...(extra._meta?.progressToken !== undefined
            ? { progressToken: extra._meta.progressToken }
            : {}),
          sendProgress: async (progress) => {
            const progressToken = extra._meta?.progressToken;
            if (progressToken === undefined) return;
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, ...progress },
            });
          },
        });
      } catch (error: unknown) {
        return errorResult(error, request?.plugin, request?.action);
      }
    },
  );
}

async function executeRegistered(
  policy: FlowZoneExecutionPolicy,
  registered: RegisteredFlowZoneAction,
  input: unknown,
  extra: ExecutionExtra,
) {
  let lastProgress = -1;
  const execution = await policy.execute(registered, input, {
    plugin: registered.plugin.id,
    action: registered.action.id,
    requestId: extra.requestId,
    signal: extra.signal,
    reportProgress: async (candidate) => {
      if (extra.progressToken === undefined) return;
      const progress = validateProgress(candidate);
      if (progress.progress < lastProgress) {
        throw new FlowZoneExecutionError(
          "invalid_output",
          "The FlowZone action reported non-monotonic progress.",
        );
      }
      lastProgress = progress.progress;
      await extra.sendProgress(progress);
    },
  });
  const parsedResult = registered.action.outputSchema.safeParse(execution.result);
  if (!parsedResult.success) {
    throw new FlowZoneExecutionError(
      "invalid_output",
      "The FlowZone action returned an invalid result.",
    );
  }
  if (serializedBytes(parsedResult.data) > MAX_FLOWZONE_PUBLIC_RESULT_BYTES) {
    throw new FlowZoneExecutionError("invalid_output", "The FlowZone result is too large.");
  }
  const structuredContent = {
    schema: "flowzone/result-v1" as const,
    plugin: registered.plugin.id,
    action: registered.action.id,
    result: parsedResult.data,
  };
  const summary = safeSummary(registered, parsedResult.data);
  const metadata: Record<string, unknown> = {};
  if (registered.action.ui) {
    const parsedPayload = registered.action.ui.payloadSchema.safeParse(execution.uiPayload);
    if (!parsedPayload.success) {
      throw new FlowZoneExecutionError(
        "invalid_output",
        "The FlowZone action returned an invalid UI payload.",
      );
    }
    const envelope = FlowZoneUiEnvelopeBaseSchema.parse({
      schema: "flowzone/ui-v1",
      plugin: registered.plugin.id,
      action: registered.action.id,
      view: registered.action.ui.view,
      payload: parsedPayload.data,
    });
    metadata["flowzone"] = envelope;
    if (registered.action.ui.legacyMetaKey)
      metadata[registered.action.ui.legacyMetaKey] = parsedPayload.data;
  } else if (execution.uiPayload !== undefined) {
    throw new FlowZoneExecutionError(
      "invalid_output",
      "The FlowZone action returned an unexpected UI payload.",
    );
  }
  if (
    serializedBytes(structuredContent) > MAX_FLOWZONE_PUBLIC_RESULT_BYTES ||
    serializedBytes(metadata) > MAX_FLOWZONE_PRIVATE_RESULT_BYTES
  ) {
    throw new FlowZoneExecutionError("invalid_output", "The FlowZone result is too large.");
  }
  return {
    structuredContent,
    content: [{ type: "text" as const, text: summary }],
    ...(Object.keys(metadata).length > 0 ? { _meta: metadata } : {}),
  };
}

export function registerFlowZonePresentations(server: McpServer, registry: FlowZoneRegistry): void {
  const policy = new FlowZoneExecutionPolicy();
  for (const registered of registry.presentations) {
    const { action, presentation } = registered;
    registerAppTool(
      server,
      presentation.toolName,
      {
        title: action.title,
        description: action.description,
        inputSchema: action.inputSchema,
        outputSchema: registry.outputSchema,
        annotations: {
          readOnlyHint: action.risk.readOnly,
          destructiveHint: action.risk.destructive,
          openWorldHint: action.risk.openWorld,
          idempotentHint: action.risk.idempotent,
        },
        _meta: {
          ui: { resourceUri: presentation.resourceUri, visibility: ["model"] },
          "openai/outputTemplate": presentation.resourceUri,
          "openai/widgetAccessible": false,
          "openai/toolInvocation/invoking": `Opening ${action.title}…`,
          "openai/toolInvocation/invoked": `${action.title} ready`,
        },
      },
      async (rawInput, extra) => {
        try {
          const parsed = action.inputSchema.safeParse(rawInput);
          if (!parsed.success)
            throw new FlowZoneExecutionError(
              "invalid_input",
              "The FlowZone presentation input is invalid.",
            );
          return await executeRegistered(policy, registered, parsed.data, {
            requestId: extra.requestId,
            signal: extra.signal,
            ...(extra._meta?.progressToken !== undefined
              ? { progressToken: extra._meta.progressToken }
              : {}),
            sendProgress: async (progress) => {
              const progressToken = extra._meta?.progressToken;
              if (progressToken === undefined) return;
              await extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, ...progress },
              });
            },
          });
        } catch (error: unknown) {
          return errorResult(error, registered.plugin.id, action.id);
        }
      },
    );
  }
}

export function registerFlowZoneAppTools(server: McpServer, registry: FlowZoneRegistry): void {
  for (const { tool } of registry.appTools) {
    registerAppTool(
      server,
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: tool.annotations,
        _meta: {
          ui: { visibility: ["app"] },
          "openai/visibility": "private",
          "openai/widgetAccessible": true,
        },
      },
      async (input, extra) => {
        const context: FlowZoneAppToolContext = {
          signal: extra.signal,
          requestId: extra.requestId,
        };
        try {
          const result = await tool.handler(input, context);
          if (serializedBytes(result) > MAX_FLOWZONE_PRIVATE_RESULT_BYTES) {
            throw new FlowZoneExecutionError(
              "invalid_output",
              "The FlowZone app response is too large.",
            );
          }
          return result;
        } catch (error: unknown) {
          return errorResult(error);
        }
      },
    );
  }
}
