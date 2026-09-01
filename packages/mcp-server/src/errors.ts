import type { FlowZoneErrorCode } from "@flowzone/contracts";

export class FlowZoneExecutionError extends Error {
  readonly code: FlowZoneErrorCode;
  readonly retryable: boolean;

  constructor(code: FlowZoneErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "FlowZoneExecutionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function asFlowZoneExecutionError(error: unknown): FlowZoneExecutionError {
  if (error instanceof FlowZoneExecutionError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new FlowZoneExecutionError("cancelled", "The FlowZone action was cancelled.");
  }
  return new FlowZoneExecutionError(
    "internal_error",
    "The FlowZone action could not be completed.",
  );
}
