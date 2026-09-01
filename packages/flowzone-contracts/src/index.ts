import { z } from "zod";

export const FLOWZONE_PLUGIN_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const FLOWZONE_ACTION_ID_PATTERN = FLOWZONE_PLUGIN_ID_PATTERN;
export const FLOWZONE_VIEW_ID_PATTERN = FLOWZONE_PLUGIN_ID_PATTERN;
export const FLOWZONE_APP_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const MAX_FLOWZONE_PLUGINS = 32;
export const MAX_FLOWZONE_ACTIONS = 64;
export const MAX_FLOWZONE_ACTIONS_PER_PLUGIN = 32;
export const MAX_FLOWZONE_ROUTER_INPUT_BYTES = 256 * 1024;
export const MAX_FLOWZONE_PUBLIC_RESULT_BYTES = 1024 * 1024;
export const MAX_FLOWZONE_PRIVATE_RESULT_BYTES = 20 * 1024 * 1024;
export const MAX_FLOWZONE_MODEL_TEXT_BYTES = 64 * 1024;

const IdentifierSchema = z.string().min(1).max(64);

export const FlowZoneRequestBaseSchema = z
  .object({
    plugin: IdentifierSchema.regex(FLOWZONE_PLUGIN_ID_PATTERN),
    action: IdentifierSchema.regex(FLOWZONE_ACTION_ID_PATTERN),
    input: z.unknown(),
  })
  .strict();

export const FlowZoneResultBaseSchema = z
  .object({
    schema: z.literal("flowzone/result-v1"),
    plugin: IdentifierSchema.regex(FLOWZONE_PLUGIN_ID_PATTERN),
    action: IdentifierSchema.regex(FLOWZONE_ACTION_ID_PATTERN),
    result: z.unknown(),
  })
  .strict();

export const FlowZoneUiEnvelopeBaseSchema = z
  .object({
    schema: z.literal("flowzone/ui-v1"),
    plugin: IdentifierSchema.regex(FLOWZONE_PLUGIN_ID_PATTERN),
    action: IdentifierSchema.regex(FLOWZONE_ACTION_ID_PATTERN),
    view: IdentifierSchema.regex(FLOWZONE_VIEW_ID_PATTERN),
    payload: z.unknown(),
  })
  .strict();

export const FlowZoneGenericViewPayloadSchema = z
  .object({
    title: z.string().min(1).max(128),
    message: z.string().min(1).max(MAX_FLOWZONE_MODEL_TEXT_BYTES),
  })
  .strict();

export const FlowZoneErrorCodeSchema = z.enum([
  "invalid_input",
  "unavailable",
  "timeout",
  "cancelled",
  "invalid_output",
  "internal_error",
]);

export const FlowZonePrivateErrorSchema = z
  .object({
    schema: z.literal("flowzone/error-v1"),
    plugin: IdentifierSchema.optional(),
    action: IdentifierSchema.optional(),
    code: FlowZoneErrorCodeSchema,
    retryable: z.boolean(),
  })
  .strict();

export type FlowZoneRequestBase = z.infer<typeof FlowZoneRequestBaseSchema>;
export type FlowZoneResultBase = z.infer<typeof FlowZoneResultBaseSchema>;
export type FlowZoneUiEnvelopeBase = z.infer<typeof FlowZoneUiEnvelopeBaseSchema>;
export type FlowZoneGenericViewPayload = z.infer<typeof FlowZoneGenericViewPayloadSchema>;
export type FlowZoneErrorCode = z.infer<typeof FlowZoneErrorCodeSchema>;
export type FlowZonePrivateError = z.infer<typeof FlowZonePrivateErrorSchema>;
