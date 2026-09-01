import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

import { MAX_FLOWZONE_PRIVATE_RESULT_BYTES } from "@flowzone/contracts";

import { FlowZoneExecutionError } from "../errors.js";
import type {
  FlowZoneCliExecutor,
  FlowZoneExecutionContext,
  FlowZoneExecutionResult,
} from "../plugin.js";
import { ExternalExecutionResponseSchema } from "./response.js";

const MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_VALUE_PATTERN = /^[^\r\n]*$/;
const SENSITIVE_ENV_PATTERN = /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const DANGEROUS_ENV_PATTERN =
  /^(?:BASH_ENV|BUN_OPTIONS|ENV|IFS|LD_PRELOAD|NODE_OPTIONS|NODE_PATH|PERL5OPT|PYTHONHOME|PYTHONPATH|RUBYOPT|DYLD_.+)$/i;
const MAX_ENV_VALUE_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_INTEGRITY_FILES = 32;
const SHELL_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "csh",
  "dash",
  "fish",
  "ksh",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "tcsh",
  "zsh",
]);

interface FileIdentity {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedAtMs: number;
  readonly changedAtMs: number;
  readonly digest?: string;
}

interface PreparedCliExecutor {
  readonly executable: FileIdentity;
  readonly cwd: string;
  readonly integrityFiles: readonly FileIdentity[];
}

const preparedExecutors = new WeakMap<FlowZoneCliExecutor, PreparedCliExecutor>();

function fileIdentity(path: string, includeDigest: boolean): FileIdentity {
  if (!isAbsolute(path)) {
    throw new Error("FlowZone CLI paths must be absolute.");
  }
  const canonical = realpathSync(path);
  const stats = statSync(canonical);
  if (!stats.isFile()) throw new Error(`FlowZone CLI path is not a regular file: ${canonical}`);
  return {
    path: canonical,
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    ...(includeDigest
      ? { digest: createHash("sha256").update(readFileSync(canonical)).digest("hex") }
      : {}),
  };
}

function matchesIdentity(expected: FileIdentity): boolean {
  try {
    const current = fileIdentity(expected.path, expected.digest !== undefined);
    return (
      current.path === expected.path &&
      current.device === expected.device &&
      current.inode === expected.inode &&
      current.size === expected.size &&
      current.modifiedAtMs === expected.modifiedAtMs &&
      current.changedAtMs === expected.changedAtMs &&
      current.digest === expected.digest
    );
  } catch {
    return false;
  }
}

function validateTimeout(timeoutMs: number | undefined): number {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`FlowZone CLI timeout must be between 1 and ${String(MAX_TIMEOUT_MS)} ms.`);
  }
  return timeout;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new FlowZoneExecutionError("cancelled", "The FlowZone action was cancelled.");
  }
}

export function prepareCliExecutor(executor: FlowZoneCliExecutor): void {
  validateTimeout(executor.timeoutMs);
  if (!isAbsolute(executor.cwd)) throw new Error("FlowZone CLI cwd must be absolute.");
  const cwd = realpathSync(executor.cwd);
  if (!statSync(cwd).isDirectory()) throw new Error("FlowZone CLI cwd must be a directory.");
  const args = executor.args ?? [];
  if (args.length > MAX_ARGUMENTS) throw new Error("FlowZone CLI has too many fixed arguments.");
  let argumentBytes = 0;
  for (const argument of args) {
    argumentBytes += Buffer.byteLength(argument, "utf8");
    if (
      Buffer.byteLength(argument, "utf8") > 4096 ||
      argument.includes("\0") ||
      argument.includes("\r") ||
      argument.includes("\n")
    ) {
      throw new Error("FlowZone CLI fixed arguments must be bounded single-line strings.");
    }
  }
  if (argumentBytes > MAX_ARGUMENT_BYTES) {
    throw new Error("FlowZone CLI fixed arguments are too large.");
  }
  const inherited = new Set<string>();
  for (const name of executor.inheritEnv ?? []) {
    if (!ENV_NAME_PATTERN.test(name) || DANGEROUS_ENV_PATTERN.test(name) || inherited.has(name)) {
      throw new Error("FlowZone CLI inherited environment names must be valid and unique.");
    }
    inherited.add(name);
  }
  for (const [name, value] of Object.entries(executor.env ?? {})) {
    if (
      !ENV_NAME_PATTERN.test(name) ||
      DANGEROUS_ENV_PATTERN.test(name) ||
      !HEADER_VALUE_PATTERN.test(value) ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES
    ) {
      throw new Error("FlowZone CLI static environment values are invalid.");
    }
    if (SENSITIVE_ENV_PATTERN.test(name)) {
      throw new Error(
        `FlowZone CLI secret-like environment variable "${name}" must come from a credential provider.`,
      );
    }
    if (inherited.has(name)) {
      throw new Error("FlowZone CLI inherited and static environment names must be unique.");
    }
  }
  if ((executor.integrityFiles?.length ?? 0) > MAX_INTEGRITY_FILES) {
    throw new Error("FlowZone CLI has too many integrity files.");
  }
  const executable = fileIdentity(executor.executable, false);
  if (SHELL_EXECUTABLES.has(basename(executable.path).toLowerCase())) {
    throw new Error("FlowZone CLI adapters cannot use a shell executable.");
  }
  preparedExecutors.set(executor, {
    executable,
    cwd,
    integrityFiles: (executor.integrityFiles ?? []).map((path) => fileIdentity(path, true)),
  });
}

function prepared(executor: FlowZoneCliExecutor): PreparedCliExecutor {
  let value = preparedExecutors.get(executor);
  if (!value) {
    prepareCliExecutor(executor);
    value = preparedExecutors.get(executor);
  }
  if (!value) throw new Error("FlowZone CLI preparation failed.");
  return value;
}

async function buildEnvironment(executor: FlowZoneCliExecutor): Promise<NodeJS.ProcessEnv> {
  const environment: NodeJS.ProcessEnv = {};
  const environmentNames = new Set<string>();
  let environmentBytes = 0;
  const add = (name: string, value: string): void => {
    if (
      !ENV_NAME_PATTERN.test(name) ||
      DANGEROUS_ENV_PATTERN.test(name) ||
      !HEADER_VALUE_PATTERN.test(value) ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > MAX_ENV_VALUE_BYTES
    ) {
      throw new FlowZoneExecutionError("unavailable", "FlowZone CLI credentials are invalid.");
    }
    environmentBytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (environmentBytes > MAX_ENVIRONMENT_BYTES) {
      throw new FlowZoneExecutionError("unavailable", "The FlowZone CLI environment is too large.");
    }
    if (environmentNames.has(name)) {
      throw new FlowZoneExecutionError(
        "unavailable",
        "FlowZone CLI environment names must be unique.",
      );
    }
    environmentNames.add(name);
    environment[name] = value;
  };
  for (const name of executor.inheritEnv ?? []) {
    const value = process.env[name];
    if (value !== undefined) add(name, value);
  }
  for (const [name, value] of Object.entries(executor.env ?? {})) add(name, value);
  const credentials = await executor.credentialProvider?.get();
  for (const [name, value] of Object.entries(credentials ?? {})) {
    add(name, value);
  }
  return environment;
}

export async function executeCli(
  executor: FlowZoneCliExecutor,
  input: unknown,
  context: FlowZoneExecutionContext,
): Promise<FlowZoneExecutionResult> {
  const configuration = prepared(executor);
  if (
    !matchesIdentity(configuration.executable) ||
    configuration.integrityFiles.some((identity) => !matchesIdentity(identity))
  ) {
    throw new FlowZoneExecutionError(
      "unavailable",
      "The allowlisted FlowZone CLI changed after registration.",
    );
  }
  throwIfAborted(context.signal);

  const serialized = JSON.stringify({
    schema: "flowzone/cli-request-v1",
    plugin: context.plugin,
    action: context.action,
    input,
  });
  const environment = await buildEnvironment(executor);
  throwIfAborted(context.signal);
  const timeoutMs = validateTimeout(executor.timeoutMs);

  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(configuration.executable.path, [...(executor.args ?? [])], {
      cwd: configuration.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      context.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const stop = (): void => {
      if (forceTimer) return;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 250);
      forceTimer.unref();
    };
    const onAbort = (): void => {
      stop();
      finish(new FlowZoneExecutionError("cancelled", "The FlowZone action was cancelled."));
    };
    const timeoutTimer = setTimeout(() => {
      stop();
      finish(new FlowZoneExecutionError("timeout", "The FlowZone CLI timed out.", true));
    }, timeoutMs);
    timeoutTimer.unref();
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();

    child.on("error", () => {
      finish(new FlowZoneExecutionError("unavailable", "The FlowZone CLI could not start.", true));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_FLOWZONE_PRIVATE_RESULT_BYTES) {
        stop();
        finish(
          new FlowZoneExecutionError("invalid_output", "The FlowZone CLI output is too large."),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_STDERR_BYTES) {
        stop();
        finish(
          new FlowZoneExecutionError(
            "invalid_output",
            "The FlowZone CLI diagnostics are too large.",
          ),
        );
      }
    });
    child.on("close", (code, signal) => {
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = undefined;
      }
      if (code !== 0) {
        finish(
          new FlowZoneExecutionError(
            "unavailable",
            signal ? "The FlowZone CLI was interrupted." : "The FlowZone CLI returned an error.",
          ),
        );
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(serialized);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new FlowZoneExecutionError("invalid_output", "The FlowZone CLI returned invalid JSON.");
  }
  const response = ExternalExecutionResponseSchema.safeParse(parsed);
  if (!response.success) {
    throw new FlowZoneExecutionError(
      "invalid_output",
      "The FlowZone CLI returned an invalid result envelope.",
    );
  }
  return response.data;
}
