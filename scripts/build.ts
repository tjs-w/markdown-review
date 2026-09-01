import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type BuildOptions } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const temporaryRoot = checkOnly ? await mkdtemp(join(tmpdir(), "flowzone-build-")) : root;

const outputs = [
  {
    source: resolve(root, "server/src/main.ts"),
    destination: "server/dist/server.cjs",
    options: {
      platform: "node",
      format: "cjs",
      target: "node22",
      minify: false,
    } satisfies BuildOptions,
  },
  {
    source: resolve(root, "packages/host-mcp-apps/src/browser-entry.ts"),
    destination: "web/dist/flowzone.js",
    options: {
      platform: "browser",
      format: "iife",
      target: "es2022",
      minify: true,
    } satisfies BuildOptions,
  },
] as const;

async function compile(): Promise<void> {
  for (const output of outputs) {
    await build({
      ...output.options,
      absWorkingDir: root,
      bundle: true,
      charset: "utf8",
      entryPoints: [output.source],
      legalComments: "none",
      logLevel: "info",
      outfile: resolve(temporaryRoot, output.destination),
      sourcemap: false,
    });
  }
}

async function assertArtifactParity(): Promise<void> {
  for (const output of outputs) {
    const expected = await readFile(resolve(root, output.destination));
    const actual = await readFile(resolve(temporaryRoot, output.destination));
    if (!expected.equals(actual)) {
      throw new Error(`${output.destination} differs from a clean build. Run bun run build.`);
    }
  }
}

async function assertBudgets(): Promise<void> {
  const serverBytes = (await stat(resolve(temporaryRoot, "server/dist/server.cjs"))).size;
  const browserBytes = await Promise.all([
    stat(resolve(root, "web/flowzone.html")),
    stat(resolve(temporaryRoot, "web/dist/flowzone.js")),
  ]).then((values) => values.reduce((total, value) => total + value.size, 0));

  if (serverBytes > 2.5 * 1024 * 1024) {
    throw new Error(`Server bundle is ${serverBytes} bytes; the limit is 2.5 MiB.`);
  }
  // Mermaid is bundled into the single offline MCP Apps resource so the strict CSP
  // never needs a script or module origin. Keep the resulting one-file payload bounded.
  if (browserBytes > 4 * 1024 * 1024) {
    throw new Error(`Browser payload is ${browserBytes} bytes; the limit is 4 MiB.`);
  }
}

try {
  await compile();
  await assertBudgets();
  if (checkOnly) await assertArtifactParity();
} finally {
  if (checkOnly) await rm(temporaryRoot, { force: true, recursive: true });
}
