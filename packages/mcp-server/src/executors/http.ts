import { MAX_FLOWZONE_PRIVATE_RESULT_BYTES } from "@flowzone/contracts";

import { FlowZoneExecutionError } from "../errors.js";
import type {
  FlowZoneExecutionContext,
  FlowZoneExecutionResult,
  FlowZoneHttpExecutor,
} from "../plugin.js";
import { ExternalExecutionResponseSchema } from "./response.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE_PATTERN = /^[^\r\n]*$/;
const SENSITIVE_HEADER_PATTERN =
  /^(?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)$/i;
const FORBIDDEN_HEADER_PATTERN =
  /^(?:accept|connection|content-length|content-type|expect|host|proxy-authorization|set-cookie|te|trailer|transfer-encoding|upgrade)$/i;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const MAX_HEADERS_BYTES = 64 * 1024;

function timeout(executor: FlowZoneHttpExecutor): number {
  const value = executor.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`FlowZone HTTP timeout must be between 1 and ${String(MAX_TIMEOUT_MS)} ms.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FlowZoneExecutionError("cancelled", "The FlowZone action was cancelled.");
  }
}

function validateHeaders(headers: Readonly<Record<string, string>>, allowSensitive: boolean): void {
  let totalBytes = 0;
  for (const [name, value] of Object.entries(headers)) {
    if (
      !HEADER_NAME_PATTERN.test(name) ||
      FORBIDDEN_HEADER_PATTERN.test(name) ||
      !HEADER_VALUE_PATTERN.test(value) ||
      Buffer.byteLength(value, "utf8") > MAX_HEADER_VALUE_BYTES
    ) {
      throw new Error("FlowZone HTTP headers are invalid.");
    }
    if (!allowSensitive && SENSITIVE_HEADER_PATTERN.test(name)) {
      throw new Error(
        `FlowZone HTTP sensitive header "${name}" must come from a credential provider.`,
      );
    }
    totalBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_HEADERS_BYTES) throw new Error("FlowZone HTTP headers are too large.");
  }
}

export function prepareHttpExecutor(executor: FlowZoneHttpExecutor): void {
  timeout(executor);
  const endpoint = new URL(executor.endpoint);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.hash !== "" ||
    endpoint.search !== ""
  ) {
    throw new Error("FlowZone HTTP endpoints must be credential-free HTTPS URLs.");
  }
  validateHeaders(executor.headers ?? {}, false);
}

async function readBoundedJsonBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const { value } = next;
      total += value.byteLength;
      if (total > MAX_FLOWZONE_PRIVATE_RESULT_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the stable size error if cancellation itself fails.
        }
        throw new FlowZoneExecutionError(
          "invalid_output",
          "The FlowZone API response is too large.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function executeHttp(
  executor: FlowZoneHttpExecutor,
  input: unknown,
  context: FlowZoneExecutionContext,
): Promise<FlowZoneExecutionResult> {
  prepareHttpExecutor(executor);
  throwIfAborted(context.signal);
  const credentialHeaders = (await executor.credentialProvider?.get()) ?? {};
  validateHeaders(credentialHeaders, true);
  throwIfAborted(context.signal);
  const combinedHeaders = {
    accept: "application/json",
    "content-type": "application/json",
    ...executor.headers,
    ...credentialHeaders,
  };
  validateHeaders(
    Object.fromEntries(
      Object.entries(combinedHeaders).filter(
        ([name]) => name.toLowerCase() !== "accept" && name.toLowerCase() !== "content-type",
      ),
    ),
    true,
  );
  const headers = new Headers(combinedHeaders);
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(context.signal.reason);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const hasTimedOut = (): boolean => timedOut;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("timeout"));
  }, timeout(executor));
  timeoutTimer.unref();

  try {
    const response = await (executor.fetcher ?? fetch)(executor.endpoint, {
      method: "POST",
      headers,
      redirect: "error",
      signal: controller.signal,
      body: JSON.stringify({
        schema: "flowzone/http-request-v1",
        plugin: context.plugin,
        action: context.action,
        input,
      }),
    });
    if (!response.ok) {
      throw new FlowZoneExecutionError(
        "unavailable",
        "The FlowZone API returned an error.",
        response.status === 408 || response.status === 429 || response.status >= 500,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
      throw new FlowZoneExecutionError(
        "invalid_output",
        "The FlowZone API returned an unsupported content type.",
      );
    }
    const declaredLengthHeader = response.headers.get("content-length");
    if (declaredLengthHeader !== null) {
      const declaredLength = Number(declaredLengthHeader);
      if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
        throw new FlowZoneExecutionError(
          "invalid_output",
          "The FlowZone API returned an invalid content length.",
        );
      }
      if (declaredLength > MAX_FLOWZONE_PRIVATE_RESULT_BYTES) {
        throw new FlowZoneExecutionError(
          "invalid_output",
          "The FlowZone API response is too large.",
        );
      }
    }
    const bytes = await readBoundedJsonBody(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new FlowZoneExecutionError("invalid_output", "The FlowZone API returned invalid JSON.");
    }
    const result = ExternalExecutionResponseSchema.safeParse(parsed);
    if (!result.success) {
      throw new FlowZoneExecutionError(
        "invalid_output",
        "The FlowZone API returned an invalid result envelope.",
      );
    }
    return result.data;
  } catch (error: unknown) {
    if (error instanceof FlowZoneExecutionError) throw error;
    throwIfAborted(context.signal);
    if (hasTimedOut()) {
      throw new FlowZoneExecutionError("timeout", "The FlowZone API timed out.", true);
    }
    throw new FlowZoneExecutionError("unavailable", "The FlowZone API is unavailable.", true);
  } finally {
    clearTimeout(timeoutTimer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
