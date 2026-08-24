import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PrivateReviewImageChunkSchema,
  ReviewDocumentSchema,
  ReviewDocumentSummarySchema,
} from "@markdown-review/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function metadata(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected MCP result metadata");
  }
  return value as Readonly<Record<string, unknown>>;
}

describe("checked-in Node stdio bundle", () => {
  test("launches from a Unicode path, keeps content private, and authorizes chunks by session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "Markdown Review ü space "));
    temporaryDirectories.push(directory);
    const markdownPath = join(directory, "review ü.md");
    const imagePath = join(directory, "pixel.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(imagePath, png);
    await writeFile(markdownPath, "# Portable review\n\nPrivate body.\n\n![pixel](pixel.png)\n");

    const transport = new StdioClientTransport({
      command: "node",
      args: [resolve(pluginRoot, "server/dist/server.cjs")],
      cwd: directory,
      stderr: "pipe",
    });
    const client = new Client({ name: "markdown-review-stdio-test", version: "0.1.0" });
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "open_markdown_review",
        "load_markdown_review_document",
        "load_markdown_review_image_chunk",
      ]);

      const resource = await client.readResource({ uri: "ui://markdown-review/v16.html" });
      const content = resource.contents[0];
      expect(content?.mimeType).toBe("text/html;profile=mcp-app");
      const html = content && "text" in content ? content.text : "";
      expect(html).toContain('id="send-all"');
      expect(html).toContain(">Submit<");
      expect(html).toContain('aria-describedby="review-help-tooltip"');
      expect(html).toContain('id="review-help-tooltip" role="tooltip"');
      expect(html).toContain("Select text to add a comment ·");
      expect(html).not.toContain("MARKDOWN_REVIEW_APP");
      expect(html).not.toContain("MARKDOWN_REVIEW_PNG_DECODER");

      const opened = await client.callTool({
        name: "open_markdown_review",
        arguments: { path: markdownPath },
      });
      expect(opened.isError).toBeUndefined();
      const summary = ReviewDocumentSummarySchema.parse(opened.structuredContent);
      expect(summary.path).toBe(await realpath(markdownPath));
      expect(JSON.stringify(summary)).not.toContain("Private body");
      const document = ReviewDocumentSchema.parse(metadata(opened._meta)["document"]);
      expect(document.html).toContain("Private body");
      expect(document.images).toHaveLength(1);

      const descriptor = document.images[0];
      if (!descriptor) throw new Error("Expected the fixture image descriptor");
      const chunkResult = await client.callTool({
        name: "load_markdown_review_image_chunk",
        arguments: {
          reviewSessionId: document.reviewSessionId,
          revision: document.revision,
          imageId: descriptor.id,
          chunkIndex: 0,
        },
      });
      expect(chunkResult.isError).toBeUndefined();
      const privateChunk = PrivateReviewImageChunkSchema.parse(
        metadata(chunkResult._meta)["imageChunk"],
      );
      expect(Buffer.from(privateChunk.data, "base64")).toEqual(png);
      expect(JSON.stringify(chunkResult.structuredContent)).not.toContain(privateChunk.data);

      const forged = await client.callTool({
        name: "load_markdown_review_document",
        arguments: { reviewSessionId: crypto.randomUUID() },
      });
      expect(forged.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);
});
