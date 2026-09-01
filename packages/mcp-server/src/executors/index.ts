import type {
  FlowZoneExecutionContext,
  FlowZoneExecutionResult,
  FlowZoneExecutor,
} from "../plugin.js";
import { executeCli, prepareCliExecutor } from "./cli.js";
import { executeHttp, prepareHttpExecutor } from "./http.js";
import { executeModule } from "./in-process.js";

export function prepareExecutor(executor: FlowZoneExecutor): void {
  switch (executor.kind) {
    case "module":
      return;
    case "cli":
      prepareCliExecutor(executor);
      return;
    case "http":
      prepareHttpExecutor(executor);
      return;
  }
}

export function executeExecutor(
  executor: FlowZoneExecutor,
  input: unknown,
  context: FlowZoneExecutionContext,
): Promise<FlowZoneExecutionResult> {
  switch (executor.kind) {
    case "module":
      return executeModule(executor, input, context);
    case "cli":
      return executeCli(executor, input, context);
    case "http":
      return executeHttp(executor, input, context);
  }
}
