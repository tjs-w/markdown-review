import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(resolve(pluginRoot, "web/dist/png-decoder.js"), "utf8");
const context = vm.createContext({
  ArrayBuffer,
  DataView,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  Uint8ClampedArray,
});

new vm.Script(bundle, { filename: "png-decoder.js" }).runInContext(context);

const bytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const decoded = context.MarkdownReviewPng.decodePng(bytes);

assert.equal(decoded.width, 1);
assert.equal(decoded.height, 1);
assert.equal(decoded.data.length, decoded.width * decoded.height * 4);
assert.ok(decoded.data.some((value) => value !== 0));

process.stdout.write("Markdown Review PNG decoder smoke test passed.\n");
