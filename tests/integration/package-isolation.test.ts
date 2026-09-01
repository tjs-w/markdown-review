import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const sourceRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

async function installShippingArtifacts(pluginRoot: string): Promise<void> {
  await mkdir(join(pluginRoot, "server", "dist"), { recursive: true });
  await mkdir(join(pluginRoot, "web", "dist"), { recursive: true });
  await Promise.all([
    copyFile(
      join(sourceRoot, "server", "dist", "server.cjs"),
      join(pluginRoot, "server", "dist", "server.cjs"),
    ),
    copyFile(join(sourceRoot, "web", "flowzone.html"), join(pluginRoot, "web", "flowzone.html")),
    copyFile(
      join(sourceRoot, "web", "dist", "flowzone.js"),
      join(pluginRoot, "web", "dist", "flowzone.js"),
    ),
  ]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("isolated shipping package", () => {
  test("launches with only checked-in artifacts from a path containing spaces and Unicode", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "markdown-review-package-"));
    temporaryDirectories.push(temporaryRoot);
    const pluginRoot = join(temporaryRoot, "Plugin ü with spaces");
    await installShippingArtifacts(pluginRoot);
    const markdownPath = join(temporaryRoot, "review.md");
    await writeFile(markdownPath, "# Isolated package\n");

    const client = new Client({ name: "isolated-package-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [join(pluginRoot, "server", "dist", "server.cjs")],
      cwd: pluginRoot,
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("flowzone");
      expect((await client.listTools()).tools).toHaveLength(5);
      const resource = await client.readResource({ uri: "ui://flowzone/v1.html" });
      const content = resource.contents[0];
      expect(content && "text" in content ? content.text : "").toContain(">Submit<");
      expect(
        (
          await client.callTool({
            name: "flowzone",
            arguments: {
              plugin: "markdown-review",
              action: "open",
              input: { path: markdownPath },
            },
          })
        ).isError,
      ).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 20_000);

  test("replaces stale checked-in artifacts during an in-place upgrade", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "markdown-review-upgrade-"));
    temporaryDirectories.push(temporaryRoot);
    const pluginRoot = join(temporaryRoot, "Existing Plugin ü");
    await mkdir(join(pluginRoot, "server", "dist"), { recursive: true });
    await mkdir(join(pluginRoot, "web", "dist"), { recursive: true });
    await Promise.all([
      writeFile(join(pluginRoot, "server", "dist", "server.cjs"), "throw new Error('old');\n"),
      writeFile(join(pluginRoot, "web", "flowzone.html"), "<title>Old review</title>\n"),
      writeFile(join(pluginRoot, "web", "dist", "flowzone.js"), "old\n"),
    ]);

    await installShippingArtifacts(pluginRoot);

    const client = new Client({ name: "upgrade-package-test", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: [join(pluginRoot, "server", "dist", "server.cjs")],
      cwd: pluginRoot,
      stderr: "pipe",
    });
    await client.connect(transport);
    try {
      const resource = await client.readResource({ uri: "ui://flowzone/v1.html" });
      const content = resource.contents[0];
      const html = content && "text" in content ? content.text : "";
      expect(html).toContain("<title>FlowZone</title>");
      expect(html).toContain(">Submit<");
      expect(html).not.toContain("Old review");
    } finally {
      await client.close();
    }
  }, 20_000);
});
