import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export interface FlowZoneProgress {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface FlowZoneExecutionContext {
  readonly plugin: string;
  readonly action: string;
  readonly requestId: string | number;
  readonly signal: AbortSignal;
  readonly reportProgress: (progress: FlowZoneProgress) => Promise<void>;
}

export interface FlowZoneExecutionResult {
  readonly result: unknown;
  readonly uiPayload?: unknown;
}

export interface FlowZoneModuleExecutor {
  readonly kind: "module";
  readonly execute: (
    input: unknown,
    context: FlowZoneExecutionContext,
  ) => FlowZoneExecutionResult | Promise<FlowZoneExecutionResult>;
}

export interface FlowZoneCredentialProvider {
  readonly get: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
}

export interface FlowZoneCliExecutor {
  readonly kind: "cli";
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly inheritEnv?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly credentialProvider?: FlowZoneCredentialProvider;
  readonly integrityFiles?: readonly string[];
  readonly timeoutMs?: number;
}

export interface FlowZoneHttpExecutor {
  readonly kind: "http";
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentialProvider?: FlowZoneCredentialProvider;
  readonly timeoutMs?: number;
  /** Test seam; production registrations leave this undefined. */
  readonly fetcher?: typeof fetch;
}

export type FlowZoneExecutor = FlowZoneModuleExecutor | FlowZoneCliExecutor | FlowZoneHttpExecutor;

export interface FlowZoneActionRisk {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly openWorld: boolean;
  readonly idempotent: boolean;
}

export interface FlowZoneActionUi {
  readonly view: string;
  readonly payloadSchema: z.ZodType;
  /** Private metadata key accepted by the pre-FlowZone view during migration. */
  readonly legacyMetaKey?: string;
}

export interface FlowZoneAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly executor: FlowZoneExecutor;
  readonly risk: FlowZoneActionRisk;
  readonly ui?: FlowZoneActionUi;
  readonly summarize?: (result: unknown) => string;
}

export interface FlowZoneAppToolContext {
  readonly signal: AbortSignal;
  readonly requestId: string | number;
}

export interface FlowZoneAppTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema?: z.ZodType;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
    readonly idempotentHint: boolean;
  };
  readonly handler: (
    input: unknown,
    context: FlowZoneAppToolContext,
  ) => CallToolResult | Promise<CallToolResult>;
}

export interface FlowZonePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly actions: readonly FlowZoneAction[];
  readonly appTools?: readonly FlowZoneAppTool[];
}
