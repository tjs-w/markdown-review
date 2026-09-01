import type {
  FlowZoneExecutionContext,
  FlowZoneExecutionResult,
  FlowZoneModuleExecutor,
} from "../plugin.js";

export async function executeModule(
  executor: FlowZoneModuleExecutor,
  input: unknown,
  context: FlowZoneExecutionContext,
): Promise<FlowZoneExecutionResult> {
  if (context.signal.aborted) throw context.signal.reason;
  return executor.execute(input, context);
}
