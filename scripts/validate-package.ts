import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type UnknownRecord = Record<string, unknown>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as UnknownRecord;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as unknown;
}

async function validateSkill(): Promise<void> {
  const skill = await readFile(resolve(root, "skills/markdown-review/SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(skill)?.[1];
  if (!frontmatter) throw new Error("SKILL.md must begin with YAML frontmatter");
  if (!/^name:\s*markdown-review\s*$/m.test(frontmatter)) {
    throw new Error("SKILL.md frontmatter must declare name: markdown-review");
  }
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() ?? "";
  if (description.length < 20 || description.length > 1_024) {
    throw new Error("SKILL.md description must be between 20 and 1024 characters");
  }
  if (
    !skill.includes("flowzone") ||
    !skill.includes('plugin: "markdown-review"') ||
    !skill.includes('action: "open"')
  ) {
    throw new Error("SKILL.md must route Markdown review requests through FlowZone");
  }
}

async function validatePlugin(): Promise<void> {
  const manifest = asRecord(await readJson(".codex-plugin/plugin.json"), "plugin manifest");
  if (manifest["name"] !== "flowzone") throw new Error("Plugin name must be flowzone");
  if (typeof manifest["version"] !== "string" || !manifest["version"].startsWith("0.1.0+codex.")) {
    throw new Error("Plugin version must include the Codex cachebuster");
  }
  if (manifest["skills"] !== "./skills/" || manifest["mcpServers"] !== "./.mcp.json") {
    throw new Error("Plugin manifest must expose the skill and MCP server manifest");
  }
  const mcpManifest = asRecord(await readJson(".mcp.json"), "MCP manifest");
  const servers = asRecord(mcpManifest["mcpServers"], "mcpServers");
  if (Object.keys(servers).length !== 1) {
    throw new Error("FlowZone must expose exactly one MCP server endpoint");
  }
  const server = asRecord(servers["flowzone"], "flowzone MCP server");
  if (server["command"] !== "node") throw new Error("The shipped MCP server must use Node");
  const args = server["args"];
  if (!Array.isArray(args) || args[0] !== "./server/dist/server.cjs") {
    throw new Error("The MCP server must launch the checked-in Node bundle");
  }
  await Promise.all([
    access(resolve(root, "server/dist/server.cjs")),
    access(resolve(root, "web/flowzone.html")),
    access(resolve(root, "web/dist/flowzone.js")),
  ]);
}

const target = process.argv[2];
if (target === "skill") await validateSkill();
else if (target === "plugin") await validatePlugin();
else throw new Error("Pass either skill or plugin to validate-package.ts");
