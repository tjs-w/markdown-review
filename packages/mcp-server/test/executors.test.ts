import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { FlowZoneExecutionError } from "../src/errors.js";
import { FlowZoneExecutionPolicy } from "../src/execution-policy.js";
import { executeCli, prepareCliExecutor } from "../src/executors/cli.js";
import { executeHttp, prepareHttpExecutor } from "../src/executors/http.js";
import type {
  FlowZoneCliExecutor,
  FlowZoneExecutionContext,
  FlowZoneHttpExecutor,
  FlowZonePlugin,
} from "../src/plugin.js";
import { createFlowZoneRegistry } from "../src/registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function context(signal: AbortSignal = new AbortController().signal): FlowZoneExecutionContext {
  return {
    plugin: "fixture",
    action: "run",
    requestId: "request-1",
    signal,
    reportProgress: () => Promise.resolve(),
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the promise to reject");
}

async function executableFixture(): Promise<{ directory: string; script: string }> {
  const directory = await mkdtemp(join(tmpdir(), "flowzone-cli-"));
  temporaryDirectories.push(directory);
  const script = join(directory, "adapter.mjs");
  await writeFile(
    script,
    [
      'let source = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { source += chunk; });',
      'process.stdin.on("end", () => {',
      "  const request = JSON.parse(source);",
      "  process.stdout.write(JSON.stringify({ result: { value: request.input.value } }));",
      "});",
    ].join("\n"),
  );
  return { directory, script };
}

describe("allowlisted CLI executor", () => {
  test("uses fixed argv, JSON stdin, a minimal environment, and validated JSON stdout", async () => {
    const { directory, script } = await executableFixture();
    const executor: FlowZoneCliExecutor = {
      kind: "cli",
      executable: process.execPath,
      args: [script],
      cwd: directory,
      integrityFiles: [script],
      timeoutMs: 5_000,
    };
    prepareCliExecutor(executor);
    expect(await executeCli(executor, { value: "$(not executed)" }, context())).toEqual({
      result: { value: "$(not executed)" },
    });
  });

  test("rejects unsafe configuration and detects adapter replacement", async () => {
    const { directory, script } = await executableFixture();
    expect(() => {
      prepareCliExecutor({
        kind: "cli",
        executable: process.execPath,
        args: [script],
        cwd: "relative",
      });
    }).toThrow("cwd must be absolute");
    expect(() => {
      prepareCliExecutor({
        kind: "cli",
        executable: process.execPath,
        args: [script],
        cwd: directory,
        env: { NODE_OPTIONS: "--import=/tmp/untrusted.mjs" },
      });
    }).toThrow("environment values are invalid");
    expect(() => {
      prepareCliExecutor({
        kind: "cli",
        executable: process.execPath,
        args: [script],
        cwd: directory,
        env: { API_TOKEN: "hard-coded" },
      });
    }).toThrow("must come from a credential provider");
    expect(() => {
      prepareCliExecutor({
        kind: "cli",
        executable: "/bin/sh",
        cwd: directory,
      });
    }).toThrow("cannot use a shell executable");

    const executor: FlowZoneCliExecutor = {
      kind: "cli",
      executable: process.execPath,
      args: [script],
      cwd: directory,
      integrityFiles: [script],
    };
    prepareCliExecutor(executor);
    await writeFile(script, "process.stdout.write('{}');\n");
    expect(await captureError(executeCli(executor, { value: "safe" }, context()))).toMatchObject({
      code: "unavailable",
    });
  });
});

describe("fixed HTTPS executor", () => {
  test("posts the typed envelope without redirects and injects credentials at execution time", async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, ...(init ? { init } : {}) };
      return Promise.resolve(
        new Response(JSON.stringify({ result: { value: "ok" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    const executor: FlowZoneHttpExecutor = {
      kind: "http",
      endpoint: "https://api.example.test/flowzone",
      headers: { "x-client": "flowzone" },
      credentialProvider: { get: () => ({ authorization: "Bearer test-secret" }) },
      fetcher,
    };
    expect(await executeHttp(executor, { value: "ready" }, context())).toEqual({
      result: { value: "ok" },
    });
    expect(captured?.input).toBe(executor.endpoint);
    expect(captured?.init?.method).toBe("POST");
    expect(captured?.init?.redirect).toBe("error");
    const body = captured?.init?.body;
    if (typeof body !== "string") throw new Error("Expected a JSON request body");
    expect(JSON.parse(body)).toEqual({
      schema: "flowzone/http-request-v1",
      plugin: "fixture",
      action: "run",
      input: { value: "ready" },
    });
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe("Bearer test-secret");
  });

  test("rejects mutable destinations, URL credentials, and transport headers", () => {
    expect(() => {
      prepareHttpExecutor({ kind: "http", endpoint: "http://api.example.test/action" });
    }).toThrow("credential-free HTTPS");
    expect(() => {
      prepareHttpExecutor({ kind: "http", endpoint: "https://api.example.test/action?token=x" });
    }).toThrow("credential-free HTTPS");
    expect(() => {
      prepareHttpExecutor({
        kind: "http",
        endpoint: "https://api.example.test/action",
        headers: { authorization: "Bearer hard-coded" },
      });
    }).toThrow("must come from a credential provider");
    expect(() => {
      prepareHttpExecutor({
        kind: "http",
        endpoint: "https://api.example.test/action",
        headers: { host: "other.example.test" },
      });
    }).toThrow("headers are invalid");
  });

  test("bounds streamed responses and maps timeout failures to stable errors", async () => {
    const oversizedFetcher = (() =>
      Promise.resolve(
        new Response(new Uint8Array(20 * 1024 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    expect(
      await captureError(
        executeHttp(
          {
            kind: "http",
            endpoint: "https://api.example.test/action",
            fetcher: oversizedFetcher,
          },
          {},
          context(),
        ),
      ),
    ).toMatchObject({ code: "invalid_output" });

    const stalledFetcher = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      })) as typeof fetch;
    expect(
      await captureError(
        executeHttp(
          {
            kind: "http",
            endpoint: "https://api.example.test/action",
            fetcher: stalledFetcher,
            timeoutMs: 5,
          },
          {},
          context(),
        ),
      ),
    ).toMatchObject({ code: "timeout", retryable: true });
  });
});

describe("execution policy and immutable registry", () => {
  function policyPlugin(execute: FlowZonePlugin["actions"][number]["executor"]): FlowZonePlugin {
    return {
      id: "fixture",
      displayName: "Fixture",
      actions: [
        {
          id: "run",
          title: "Run fixture",
          description: "Run the fixture action.",
          inputSchema: z.object({}).strict(),
          outputSchema: z.object({ ok: z.boolean() }).strict(),
          executor: execute,
          risk: {
            readOnly: true,
            destructive: false,
            openWorld: false,
            idempotent: true,
          },
        },
      ],
    };
  }

  test("retries only retryable idempotent failures", async () => {
    let attempts = 0;
    const registry = createFlowZoneRegistry([
      policyPlugin({
        kind: "module",
        execute() {
          attempts += 1;
          if (attempts === 1) {
            throw new FlowZoneExecutionError("unavailable", "Try again.", true);
          }
          return { result: { ok: true } };
        },
      }),
    ]);
    const registered = registry.find("fixture", "run");
    if (!registered) throw new Error("Expected registered fixture action");
    expect(await new FlowZoneExecutionPolicy().execute(registered, {}, context())).toEqual({
      result: { ok: true },
    });
    expect(attempts).toBe(2);
  });

  test("propagates cancellation and limits concurrent calls per action", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = createFlowZoneRegistry([
      policyPlugin({
        kind: "module",
        async execute() {
          await gate;
          return { result: { ok: true } };
        },
      }),
    ]);
    const registered = registry.find("fixture", "run");
    if (!registered) throw new Error("Expected registered fixture action");
    const policy = new FlowZoneExecutionPolicy();
    const active = Array.from({ length: 4 }, () => policy.execute(registered, {}, context()));
    await Promise.resolve();
    expect(await captureError(policy.execute(registered, {}, context()))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    release?.();
    await Promise.all(active);

    const controller = new AbortController();
    controller.abort();
    expect(
      await captureError(
        new FlowZoneExecutionPolicy().execute(registered, {}, context(controller.signal)),
      ),
    ).toMatchObject({ code: "cancelled", retryable: false });
  });

  test("snapshots mutable registration data before serving requests", async () => {
    const { directory, script } = await executableFixture();
    const args = [script];
    const plugin: FlowZonePlugin = {
      id: "fixture",
      displayName: "Fixture",
      actions: [
        {
          id: "run",
          title: "Run fixture",
          description: "Run a fixed executable adapter.",
          inputSchema: z.object({ value: z.string() }).strict(),
          outputSchema: z.object({ value: z.string() }).strict(),
          executor: {
            kind: "cli",
            executable: process.execPath,
            args,
            cwd: directory,
            integrityFiles: [script],
          },
          risk: {
            readOnly: true,
            destructive: false,
            openWorld: false,
            idempotent: true,
          },
        },
      ],
    };
    const registry = createFlowZoneRegistry([plugin]);
    args[0] = "/tmp/replaced.mjs";
    const registered = registry.find("fixture", "run");
    expect(registered?.action.executor).toMatchObject({ args: [script] });
  });
});
