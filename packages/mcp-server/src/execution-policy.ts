import { FlowZoneExecutionError, asFlowZoneExecutionError } from "./errors.js";
import { executeExecutor } from "./executors/index.js";
import type { FlowZoneExecutionContext, FlowZoneExecutionResult } from "./plugin.js";
import type { RegisteredFlowZoneAction } from "./registry.js";

const MAX_CONCURRENT_CALLS = 4;
const MAX_RETRIES = 2;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

interface ActionState {
  active: number;
  transientFailures: number;
  circuitOpenedAt?: number;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new FlowZoneExecutionError("cancelled", "The FlowZone action was cancelled.");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    timer.unref();
  });
}

export class FlowZoneExecutionPolicy {
  readonly #states = new Map<string, ActionState>();

  async execute(
    registered: RegisteredFlowZoneAction,
    input: unknown,
    context: FlowZoneExecutionContext,
  ): Promise<FlowZoneExecutionResult> {
    const state = this.#states.get(registered.key) ?? { active: 0, transientFailures: 0 };
    this.#states.set(registered.key, state);
    if (
      state.circuitOpenedAt !== undefined &&
      Date.now() - state.circuitOpenedAt < CIRCUIT_COOLDOWN_MS
    ) {
      throw new FlowZoneExecutionError(
        "unavailable",
        "The FlowZone action is temporarily unavailable.",
        true,
      );
    }
    if (state.active >= MAX_CONCURRENT_CALLS) {
      throw new FlowZoneExecutionError("unavailable", "The FlowZone action is busy.", true);
    }
    state.active += 1;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const result = await executeExecutor(registered.action.executor, input, context);
          state.transientFailures = 0;
          delete state.circuitOpenedAt;
          return result;
        } catch (error: unknown) {
          const failure = asFlowZoneExecutionError(error);
          if (failure.retryable) {
            state.transientFailures += 1;
            if (state.transientFailures >= CIRCUIT_FAILURE_THRESHOLD) {
              state.circuitOpenedAt = Date.now();
            }
          }
          const canRetry =
            registered.action.risk.idempotent &&
            failure.retryable &&
            failure.code !== "cancelled" &&
            attempt < MAX_RETRIES;
          if (!canRetry) throw failure;
          await delay(100 * 2 ** attempt, context.signal);
        }
      }
    } finally {
      state.active -= 1;
    }
  }
}
