import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Totals {
  foundLines: number;
  hitLines: number;
  foundFunctions: number;
  hitFunctions: number;
}

const EXPECTED_SOURCES = new Set([
  "packages/contracts/src/index.ts",
  "packages/core/src/references.ts",
  "packages/core/src/state.ts",
  "packages/core/src/submission.ts",
  "packages/host-mcp-apps/src/format-codex-submission.ts",
  "packages/host-mcp-apps/src/browser-runtime.ts",
  "packages/host-mcp-apps/src/mcp-apps-host.ts",
  "packages/host-mcp-apps/src/payloads.ts",
  "packages/host-mcp-apps/src/state-store.ts",
  "packages/markdown-node/src/bounded-read.ts",
  "packages/markdown-node/src/path-policy.ts",
  "packages/markdown-node/src/png.ts",
  "packages/markdown-node/src/render.ts",
  "packages/markdown-node/src/service.ts",
  "packages/markdown-node/src/session-store.ts",
  "packages/mcp-server/src/assets.ts",
  "packages/mcp-server/src/server.ts",
  "packages/review-ui/src/mount.ts",
  "packages/review-ui/src/image-assembly.ts",
  "packages/review-ui/src/review-highlights.ts",
]);

function emptyTotals(): Totals {
  return { foundLines: 0, hitLines: 0, foundFunctions: 0, hitFunctions: 0 };
}

function add(target: Totals, source: Totals): void {
  target.foundLines += source.foundLines;
  target.hitLines += source.hitLines;
  target.foundFunctions += source.foundFunctions;
  target.hitFunctions += source.hitFunctions;
}

function field(record: string, name: string): number {
  const match = new RegExp(`^${name}:(\\d+)$`, "m").exec(record);
  return match ? Number(match[1]) : 0;
}

function ratio(hit: number, found: number): number {
  return found === 0 ? 0 : hit / found;
}

function workspaceSource(source: string): string {
  const normalized = source.replaceAll("\\", "/");
  return normalized.replace(/^.*\/packages\//, "packages/").replace(/^.*\/web\/src\//, "web/src/");
}

export function evaluateLcov(
  lcov: string,
  expectedSources: ReadonlySet<string> = EXPECTED_SOURCES,
): string[] {
  const records = lcov.split("end_of_record").filter((record) => record.trim().length > 0);
  const overall = emptyTotals();
  const critical = emptyTotals();
  const seenSources = new Set<string>();
  for (const record of records) {
    const source = workspaceSource(/^SF:(.+)$/m.exec(record)?.[1] ?? "");
    if (!source.startsWith("packages/") && !source.startsWith("web/src/")) continue;
    seenSources.add(source);
    const totals = {
      foundLines: field(record, "LF"),
      hitLines: field(record, "LH"),
      foundFunctions: field(record, "FNF"),
      hitFunctions: field(record, "FNH"),
    };
    add(overall, totals);
    if (source.startsWith("packages/contracts/") || source.startsWith("packages/core/")) {
      add(critical, totals);
    }
  }

  const failures: string[] = [];
  const missingSources = [...expectedSources].filter((source) => !seenSources.has(source));
  if (missingSources.length > 0) {
    failures.push(`missing production coverage records: ${missingSources.join(", ")}`);
  }
  if (overall.foundLines === 0 || overall.foundFunctions === 0) {
    failures.push("overall: no workspace source records found in coverage/lcov.info");
  }
  if (critical.foundLines === 0 || critical.foundFunctions === 0) {
    failures.push("contracts/core: no source records found in coverage/lcov.info");
  }
  for (const [label, totals, minimum] of [
    ["overall", overall, 0.85],
    ["contracts/core", critical, 0.95],
  ] as const) {
    const lineCoverage = ratio(totals.hitLines, totals.foundLines);
    const functionCoverage = ratio(totals.hitFunctions, totals.foundFunctions);
    if (lineCoverage < minimum || functionCoverage < minimum) {
      failures.push(
        `${label}: lines ${(lineCoverage * 100).toFixed(1)}%, functions ${(functionCoverage * 100).toFixed(1)}%; required ${(minimum * 100).toFixed(0)}%`,
      );
    }
  }
  return failures;
}

if (import.meta.main) {
  const lcov = await readFile(resolve("coverage/lcov.info"), "utf8");
  const failures = evaluateLcov(lcov);
  if (failures.length > 0) throw new Error(`Coverage gates failed:\n${failures.join("\n")}`);
}
