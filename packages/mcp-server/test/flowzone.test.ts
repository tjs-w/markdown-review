import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import type { FlowZoneAction, FlowZonePlugin } from "../src/plugin.js";
import { createFlowZoneServer } from "../src/server.js";
import { FLOWZONE_TEMPLATE_URI, LEGACY_FLOWZONE_TEMPLATE_URIS } from "../src/ui-resource.js";

const assetLoader = {
  load() {
    return Promise.resolve({
      template: "<html><!-- FLOWZONE_APP --></html>",
      bundle: "window.flowzone = true; // </script",
    });
  },
};

function toolVisibility(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const ui = (value as Readonly<Record<string, unknown>>)["ui"];
  return ui && typeof ui === "object"
    ? (ui as Readonly<Record<string, unknown>>)["visibility"]
    : undefined;
}

function firstAction(plugin: FlowZonePlugin): FlowZoneAction {
  const action = plugin.actions[0];
  if (!action) throw new Error("Expected a fixture action");
  return action;
}

function modulePlugin(id: string, actionId = "echo"): FlowZonePlugin {
  const ResultSchema = z.object({ value: z.string().max(128) }).strict();
  return {
    id,
    displayName: `${id} plugin`,
    version: "1.0.0",
    actions: [
      {
        id: actionId,
        title: `${id} echo`,
        description: `Return a bounded value from ${id}.`,
        inputSchema: z.object({ value: z.string().max(128) }).strict(),
        outputSchema: ResultSchema,
        executor: {
          kind: "module",
          execute(input) {
            const { value } = ResultSchema.parse(input);
            return { result: { value: `${id}:${value}` } };
          },
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
}

describe("createFlowZoneServer", () => {
  test("exposes one model router for multiple statically registered plugins", async () => {
    const server = createFlowZoneServer({
      assetLoader,
      version: "1.2.3",
      plugins: [modulePlugin("alpha"), modulePlugin("beta")],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flowzone-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerVersion()).toEqual({ name: "flowzone", version: "1.2.3" });
      expect(client.getInstructions()).toContain("one router tool");
      expect(client.getInstructions()).not.toContain("alpha plugin");
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["flowzone"]);
      expect(toolVisibility(tools.tools[0]?._meta)).toEqual(["model"]);
      expect(tools.tools[0]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      });

      const result = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "beta", action: "echo", input: { value: "ready" } },
      });
      expect(result.structuredContent).toEqual({
        schema: "flowzone/result-v1",
        plugin: "beta",
        action: "echo",
        result: { value: "beta:ready" },
      });
      expect(result.content).toEqual([{ type: "text", text: "beta plugin: beta echo completed." }]);
      expect(result._meta).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("keeps typed plugin helpers app-only and returns UI data in a private envelope", async () => {
    const viewer = modulePlugin("viewer");
    const plugin: FlowZonePlugin = {
      ...viewer,
      actions: [
        {
          ...firstAction(viewer),
          ui: {
            view: "summary",
            payloadSchema: z.object({ privateValue: z.string() }).strict(),
          },
          executor: {
            kind: "module",
            execute() {
              return {
                result: { value: "public" },
                uiPayload: { privateValue: "private" },
              };
            },
          },
        },
      ],
      appTools: [
        {
          name: "viewer_refresh",
          title: "Refresh viewer",
          description: "Refresh the current viewer payload.",
          inputSchema: z.object({ id: z.string() }).strict(),
          outputSchema: z.object({ refreshed: z.boolean() }).strict(),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
            idempotentHint: true,
          },
          handler() {
            return { structuredContent: { refreshed: true }, content: [] };
          },
        },
      ],
    };
    const server = createFlowZoneServer({ assetLoader, plugins: [plugin] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flowzone-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["flowzone", "viewer_refresh"]);
      expect(toolVisibility(tools.tools[1]?._meta)).toEqual(["app"]);
      expect(tools.tools[1]?._meta?.["openai/visibility"]).toBe("private");
      const result = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "viewer", action: "echo", input: { value: "ignored" } },
      });
      expect(result._meta?.["flowzone"]).toEqual({
        schema: "flowzone/ui-v1",
        plugin: "viewer",
        action: "echo",
        view: "summary",
        payload: { privateValue: "private" },
      });
      expect(JSON.stringify(result.structuredContent)).not.toContain("private");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("registers the universal resource with a closed CSP and escaped bundle", async () => {
    const server = createFlowZoneServer({
      assetLoader,
      allowNativeDevTools: true,
      plugins: [modulePlugin("alpha")],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flowzone-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const resources = await client.listResources();
      const resourceUris = resources.resources.map((resource) => resource.uri);
      expect(resourceUris).toContain(FLOWZONE_TEMPLATE_URI);
      for (const legacyUri of LEGACY_FLOWZONE_TEMPLATE_URIS) {
        expect(resourceUris).toContain(legacyUri);
        const legacyResource = await client.readResource({ uri: legacyUri });
        expect(legacyResource.contents[0]?.uri).toBe(legacyUri);
        expect(
          legacyResource.contents[0] && "text" in legacyResource.contents[0]
            ? legacyResource.contents[0].text
            : "",
        ).toContain("<\\/script");
      }
      expect(resources.resources[0]?._meta?.["ui"]).toEqual({
        prefersBorder: true,
        csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
        permissions: { clipboardWrite: {} },
      });
      const resource = await client.readResource({ uri: FLOWZONE_TEMPLATE_URI });
      const content = resource.contents[0];
      expect(content && "text" in content ? content.text : "").toContain(
        'data-flowzone-developer-mode="true"',
      );
      expect(content && "text" in content ? content.text : "").toContain("<\\/script");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects malformed, duplicate, excessive, and unsafe registrations", () => {
    expect(() => createFlowZoneServer({ assetLoader, plugins: [] })).toThrow(
      "between 1 and 32 plugins",
    );
    expect(() =>
      createFlowZoneServer({ assetLoader, plugins: [modulePlugin("../unsafe")] }),
    ).toThrow("invalid or registered more than once");
    expect(() =>
      createFlowZoneServer({
        assetLoader,
        plugins: [modulePlugin("alpha"), modulePlugin("alpha")],
      }),
    ).toThrow("invalid or registered more than once");
    expect(() =>
      createFlowZoneServer({
        assetLoader,
        plugins: Array.from({ length: 33 }, (_, index) => modulePlugin(`plugin-${String(index)}`)),
      }),
    ).toThrow("between 1 and 32 plugins");
    expect(() =>
      createFlowZoneServer({
        assetLoader,
        version: " 1.0.0",
        plugins: [modulePlugin("alpha")],
      }),
    ).toThrow("FlowZone version must be");
    expect(() =>
      createFlowZoneServer({
        assetLoader,
        plugins: [{ ...modulePlugin("alpha"), displayName: "Alpha\nunsafe" }],
      }),
    ).toThrow("display name");
  });

  test("fails closed on invalid action output", async () => {
    const plugin = modulePlugin("alpha");
    const server = createFlowZoneServer({
      assetLoader,
      plugins: [
        {
          ...plugin,
          actions: [
            {
              ...firstAction(plugin),
              executor: { kind: "module", execute: () => ({ result: { value: 42 } }) },
            },
          ],
        },
      ],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flowzone-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "flowzone",
        arguments: { plugin: "alpha", action: "echo", input: { value: "ready" } },
      });
      expect(result.isError).toBeTrue();
      expect(result.content).toEqual([
        { type: "text", text: "The FlowZone action returned an invalid result." },
      ]);
      expect(result._meta?.["flowzoneError"]).toMatchObject({
        code: "invalid_output",
        retryable: false,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("forwards bounded request-scoped progress notifications", async () => {
    const plugin = modulePlugin("alpha");
    const server = createFlowZoneServer({
      assetLoader,
      plugins: [
        {
          ...plugin,
          actions: [
            {
              ...firstAction(plugin),
              executor: {
                kind: "module",
                async execute(_input, context) {
                  await context.reportProgress({ progress: 1, total: 2, message: "Working" });
                  return { result: { value: "done" } };
                },
              },
            },
          ],
        },
      ],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "flowzone-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const progress: unknown[] = [];
    try {
      await client.callTool(
        {
          name: "flowzone",
          arguments: { plugin: "alpha", action: "echo", input: { value: "ready" } },
        },
        undefined,
        { onprogress: (update) => progress.push(update) },
      );
      expect(progress).toEqual([{ progress: 1, total: 2, message: "Working" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
