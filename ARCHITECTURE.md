# FlowZone architecture

FlowZone is one MCP server process with one transport and one model-visible router tool. A fixed startup registry dispatches that tool to independently owned plugins. Markdown Review is the first plugin.

```text
Codex / MCP client
        │ one local stdio transport
        ▼
flowzone(plugin, action, input)        model-visible
        │
        ▼
static validated registry
        ├── in-process module
        ├── fixed allowlisted CLI/script
        └── fixed HTTPS backend API
        │
        ▼
ui://flowzone/v1.html                 universal MCP Apps shell
        └── registered plugin view adapter

plugin-owned typed helper tools       app-only
```

The shipped transport is local stdio. A remote transport is not implied by this design; it would require an explicit identity, authentication, authorization, TLS, origin, CSRF, rate-limit, request-size, and audit model before release.

## Public MCP surface

Exactly one tool is model-visible:

```json
{
  "plugin": "markdown-review",
  "action": "open",
  "input": { "path": "/absolute/path/document.md" }
}
```

The router schema is a startup-built union of registered plugin/action/input branches. FlowZone validates the selected branch again before execution and validates the plugin-owned result schema before returning this public envelope:

```json
{
  "schema": "flowzone/result-v1",
  "plugin": "markdown-review",
  "action": "open",
  "result": {}
}
```

Router annotations are deliberately conservative (`readOnly: false`, `destructive: true`, `openWorld: true`, `idempotent: false`) because a single MCP tool can reach actions with different risk. Action-level risk metadata controls internal retry behavior; it does not weaken the router's advertised risk.

Plugin-owned component helpers remain separate typed tools. FlowZone registers them centrally with `_meta.ui.visibility: ["app"]`, so a plugin cannot accidentally make one model-visible. Markdown Review retains its four helper names for document checks, document loading, recovery, and image chunks.

## Plugin contract

Plugins declare data; they do not receive the raw MCP server:

```ts
interface FlowZonePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly actions: readonly FlowZoneAction[];
  readonly appTools?: readonly FlowZoneAppTool[];
}
```

Each action owns strict input and output Zod schemas, risk metadata, one executor, and optional UI metadata. Each UI action owns a private payload schema and a stable view ID. Every app-only helper owns its own input/output schemas and handler.

`createFlowZoneRegistry` validates bounded identifiers, descriptions, schema sizes, counts, duplicate routes, duplicate helper names, and executor configuration. It snapshots registration objects and their nested arrays/records before serving requests. Registration is static: there is no directory scan, runtime module import, user-selected executable, or mutable endpoint.

Skills are model workflow guidance only. A skill may explain which `plugin` and `action` to choose and how to handle the result, but it is never imported or executed as a runtime backend.

## Executors

### In-process modules

An in-process executor is a trusted bundled function. It receives validated input plus request ID, cancellation signal, and bounded progress reporting. It still must enforce plugin-domain policy such as Markdown canonical paths, file limits, or tenant authorization.

### Allowlisted CLI/scripts

CLI configuration is registration-owned and immutable. FlowZone requires an absolute canonical executable and working directory, fixed argument and environment allowlists, optional runtime credential injection, bounded JSON stdin/stdout, bounded diagnostics, a timeout, and process termination on timeout/cancellation. The executable identity and declared adapter files are checked again before every call; adapter files use SHA-256.

FlowZone invokes the executable directly with `shell: false`. Model input never becomes argv, a command string, a path, an environment-variable name, or a working directory. Shell executables must not be registered as adapters. Credentials must come from a credential provider, not static registration metadata.

This is process hardening, not an OS sandbox. The child inherits FlowZone's OS identity and therefore must be treated as trusted code with that user's filesystem and network authority.

### Backend APIs

HTTP configuration uses a fixed credential-free HTTPS URL with no query, fragment, or redirect following. Headers are validated; sensitive headers come from a runtime credential provider. Requests and streamed JSON responses are bounded, timeout/cancellation-aware, and validated against the same result envelope as CLI adapters. Error bodies, credentials, raw stderr, and untrusted exception details never enter model-visible errors.

FlowZone retries only explicitly idempotent actions and only retryable failures, with a small bounded backoff. Per-action concurrency and circuit-breaker limits contain repeated backend failure.

## Universal UI shell

`ui://flowzone/v1.html` is the single model-tool output resource. Public model output stays small; private UI data uses a typed metadata envelope:

```json
{
  "schema": "flowzone/ui-v1",
  "plugin": "markdown-review",
  "action": "open",
  "view": "review",
  "payload": {}
}
```

The browser host dispatches that tuple through a fixed view registry. Markdown Review owns a validated document view; actions without a plugin view receive FlowZone's built-in, bounded generic result view. Unknown plugin view routes and invalid payloads fail closed. The resource CSP permits no network, remote resource, or frame domains and requests clipboard-write only. A legacy `ui://markdown-review/v30.html` resource alias serves the same shell for already cached views; new calls use only `ui://flowzone/v1.html`.

## Markdown Review compatibility

The model-visible `open_markdown_review` tool is intentionally removed at the new-task boundary. The `$markdown-review` skill invokes `flowzone` with `plugin: "markdown-review"`, `action: "open"`, and the absolute path inside `input`.

The Markdown source remains canonical. Existing review submission schemas, state identity, document/image contracts, and app-only helper names are unchanged. A private legacy `document` metadata key accompanies the new FlowZone UI envelope during migration so cached v30 view code can hydrate safely.

## Add a plugin

1. Implement a plugin-owned factory and schemas without importing another plugin's internal modules.
2. Select one executor type and document its trust boundary. For CLI or HTTP, keep every destination and command field in static registration code.
3. Register any UI view in the universal shell and keep helper tools typed and app-only.
4. Add the factory to the fixed `plugins` array in `server/src/main.ts`.
5. Add schema, error, cancellation, size, privacy, and integration tests through the public `flowzone` call.
6. Update the skill only for invocation guidance, rotate the plugin cachebuster, rebuild checked-in artifacts, and run `bun run verify` plus Firefox acceptance.

See [docs/plugin-authoring.md](./docs/plugin-authoring.md) and [SECURITY.md](./SECURITY.md) for the detailed checklist.
