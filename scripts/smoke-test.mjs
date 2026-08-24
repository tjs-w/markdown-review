import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(pluginRoot, "scripts/fixture.md");
const fixtureImage = resolve(pluginRoot, "scripts/fixture.png");
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const fixturePng = Buffer.concat([onePixelPng, Buffer.alloc(80 * 1024, 0xab)]);
const transport = new StdioClientTransport({
  command: "node",
  args: ["server/dist/server.cjs"],
  cwd: pluginRoot,
  stderr: "pipe",
});
const client = new Client({ name: "markdown-review-smoke-test", version: "0.1.0" });

try {
  await writeFile(fixtureImage, fixturePng);
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    "open_markdown_review",
    "load_markdown_review_document",
    "load_markdown_review_image_chunk",
  ]);
  const hydrationTool = tools.tools.find((tool) => tool.name === "load_markdown_review_document");
  assert.deepEqual(hydrationTool._meta.ui.visibility, ["app"]);

  const imageChunkTool = tools.tools.find((tool) => tool.name === "load_markdown_review_image_chunk");
  assert.deepEqual(imageChunkTool._meta.ui.visibility, ["app"]);

  const resource = await client.readResource({ uri: "ui://markdown-review/v15.html" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /Queue feedback/);
  assert.match(resource.contents[0].text, /id="send-all"/);
  assert.match(resource.contents[0].text, /id="comments-panel"/);
  assert.doesNotMatch(resource.contents[0].text, /Send this now|id="send-now"/);
  assert.match(resource.contents[0].text, /id="composer-help-toggle"/);
  assert.match(resource.contents[0].text, /id="composer-help-popover"/);
  assert.match(resource.contents[0].text, /referencedComments/);
  assert.match(resource.contents[0].text, /untrusted quoted data/);
  assert.match(resource.contents[0].text, /ui\/initialize/);
  assert.match(resource.contents[0].text, /load_markdown_review_document/);
  assert.match(resource.contents[0].text, /load_markdown_review_image_chunk/);
  assert.match(resource.contents[0].text, /MarkdownReviewPng/);
  assert.doesNotMatch(resource.contents[0].text, /MARKDOWN_REVIEW_PNG_DECODER/);

  const result = await client.callTool({
    name: "open_markdown_review",
    arguments: { path: fixture },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.path, fixture);
  assert.equal(result.structuredContent.title, "Markdown Review Fixture");
  assert.ok(result.structuredContent.blockCount >= 4);
  assert.equal(JSON.stringify(result.structuredContent).includes("smoke test"), false);
  assert.match(result._meta.document.html, /review-block/);
  assert.match(result._meta.document.html, /plugin smoke test/);
  assert.match(result._meta.document.html, /data-local-image-id="local-image-1"/);
  assert.equal(result._meta.document.images[0].mimeType, "image/png");
  assert.equal(result._meta.document.images[0].data, undefined);
  assert.equal(result._meta.document.images[0].byteLength, fixturePng.length);
  assert.equal(result._meta.document.images[0].width, 1);
  assert.equal(result._meta.document.images[0].height, 1);
  assert.ok(result._meta.document.images[0].chunkCount > 1);
  assert.equal(JSON.stringify(result.structuredContent).includes("iVBOR"), false);

  const descriptor = result._meta.document.images[0];
  const reconstructed = [];
  for (let chunkIndex = 0; chunkIndex < descriptor.chunkCount; chunkIndex += 1) {
    const chunkResult = await client.callTool({
      name: "load_markdown_review_image_chunk",
      arguments: {
        path: fixture,
        revision: result._meta.document.revision,
        imageId: descriptor.id,
        chunkIndex,
      },
    });
    assert.equal(chunkResult.isError, undefined);
    assert.equal(chunkResult.structuredContent.kind, "markdown-review-image-chunk");
    assert.equal(chunkResult.structuredContent.chunkIndex, chunkIndex);
    assert.equal(chunkResult.structuredContent.data, undefined);
    assert.ok(chunkResult._meta.imageChunk.data.length <= 32768);
    reconstructed.push(Buffer.from(chunkResult._meta.imageChunk.data, "base64"));
  }
  assert.deepEqual(Buffer.concat(reconstructed), fixturePng);

  const hydrated = await client.callTool({
    name: "load_markdown_review_document",
    arguments: { path: fixture },
  });
  assert.equal(hydrated.isError, undefined);
  assert.equal(hydrated.structuredContent.path, fixture);
  assert.equal(hydrated._meta.document.images[0].mimeType, "image/png");

  const oversizedHeader = Buffer.from(fixturePng);
  oversizedHeader.writeUInt32BE(9000, 16);
  await writeFile(fixtureImage, oversizedHeader);
  const oversized = await client.callTool({
    name: "load_markdown_review_document",
    arguments: { path: fixture },
  });
  assert.equal(oversized.isError, undefined);
  assert.equal(oversized._meta.document.images.length, 0);
  assert.match(oversized._meta.document.html, /decoded dimensions exceed the safety limit/);

  const invalid = await client.callTool({
    name: "open_markdown_review",
    arguments: { path: "relative.md" },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /absolute/);

  process.stdout.write("Markdown Review MCP smoke test passed.\n");
} finally {
  await client.close();
  await unlink(fixtureImage).catch(() => {});
}
