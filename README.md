# FlowZone

FlowZone is a local-first MCP plugin host. It exposes one MCP server endpoint and statically composes independently registered plugins behind that connection. It bundles Markdown Review and Dyna, a persistent executive dashboard for scheduled Slack, Outlook, GitLab, and Codex signals.

> **Status:** early development. Dyna's vertical slice is implemented; physical iOS and Android Remote acceptance remains a release gate.

## Bundled plugin: Dyna

- Multiple persistent dashboards and native Codex schedule identities with many-to-many bindings, cadence-aware freshness, ordered per-run promotion, retry deduplication, and full-snapshot retirement.
- Strict source records compiled through a fixed `@json-render/core` catalog; scheduled jobs cannot supply arbitrary UI or code.
- Accessible Apps SDK UI cards, badges, buttons, and annotation forms in a responsive executive view.
- Re-rendering after scheduled updates, durable conversation-driven enrichment overlays, annotations, and monotonic linked task-status changes.
- Revision-bound, claim-revalidated, per-attempt idempotent action requests with expiring leases for native Codex task creation, existing-task attachment, navigation, and status inspection.
- A dedicated `ui://flowzone/dyna/v1.html` resource below a 750 KiB payload budget with a closed network CSP and no clipboard permission.

See [Dyna executive dashboards](./docs/dyna.md) for requirements, architecture, action protocol, implementation status, and the mobile Remote acceptance matrix.

## Bundled plugin: Markdown Review

- A fullscreen, GitHub-style Markdown preview in the side panel.
- Normal text selection and copying, plus a review menu for selected-text, image, and whole-document feedback.
- Focusable image review targets for pointer, touch, and keyboard comments.
- Unobtrusive image feedback controls that appear at the image's bottom-right only on hover, keyboard focus, or active touch.
- Inline comment markers numbered `#1`, `#2`, and so on.
- A review queue that submits all comments together to avoid conflicting edits.
- References between queued comments using `#N`; write `\#N` or `` `#N` `` for literal text.
- Relative local PNG, JPEG, and static WebP rendering with bounded, private chunk transport.
- Local Mermaid rendering for fenced `mermaid` blocks, with theme-aware diagrams and expandable canonical source.
- Automatic review after Codex creates or materially edits a Markdown document.

The Markdown source is always canonical. The component is a read-only review surface; only Codex edits the source file with its normal filesystem tools.

## How it works

```text
Codex / MCP host
       │ one stdio transport
       ▼
FlowZone McpServer
       ├── flowzone(plugin, action, input) · data actions
       │      └── static plugin registry
       │              └── markdown-review/open
       ├── typed app-only component tools
       ├── render_markdown_review → ui://flowzone/v5.html
       └── render_dyna_dashboard → ui://flowzone/dyna/v1.html
```

FlowZone exposes one model-visible `flowzone` data router plus a dedicated model-visible presentation tool for each rendered surface. The startup-built router union enumerates non-visual plugin/action/input combinations and validates both selected input and plugin-owned output. Dedicated presentation tools carry their own risk and MCP Apps resource metadata. Typed helpers used by a UI stay separate and are forcibly registered with `_meta.ui.visibility: ["app"]`.

The Markdown Review plugin is intentionally narrow:

1. `render_markdown_review` validates an absolute `.md` or `.markdown` path and opens the dedicated view.
2. Component-only tools hydrate the rendered document and stream approved local raster images in bounded chunks.
3. The model-visible tool result contains file metadata, not the complete document. The rendered content is delivered privately to the component.
4. While the review remains open, a lightweight private revision check offers `Refresh for latest` without replacing what you are reading. Activating it loads the newest Markdown in place; Codex does not open another review for the same active path after edits.
5. The skill explains how Codex should interpret review feedback and modify the underlying Markdown safely.

This separation is the reason the plugin uses MCP: FlowZone connects a Codex tool invocation to a trusted interactive component. A static HTML file by itself cannot receive the selected source file, return structured review comments to the active task, or maintain this context boundary.

The implementation is split into a generic FlowZone server registry and host-neutral Markdown Review workspaces. `contracts` validates every review boundary, `core` owns pure review state, `markdown-node` reads and renders local files, and `review-ui` mounts against narrow document, submission, presentation, and state ports. `host-mcp-apps` supplies a standards-based runtime whose default submission is structured JSON; the Codex browser composition explicitly adds the concise `$markdown-review` formatter. Review state is persisted locally under its opaque review-session ID so queued comments survive component remounts, while never being published as model-visible legacy widget context.

## Adding a plugin

Every plugin implements the declarative `FlowZonePlugin` contract in `@flowzone/mcp-server`:

```ts
interface FlowZonePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly actions: readonly FlowZoneAction[];
  readonly appTools?: readonly FlowZoneAppTool[];
}
```

Add the plugin factory to the static list in `server/src/main.ts`. Each action declares strict input/output schemas, risk metadata, and an in-process module, fixed allowlisted CLI/script, or fixed HTTPS backend executor. Runtime discovery, user-selected modules, model-controlled commands, and mutable destinations are unsupported. Skills explain how a model should invoke an action; they are not loaded as runtime backends. See [ARCHITECTURE.md](./ARCHITECTURE.md) and [plugin authoring](./docs/plugin-authoring.md).

## Host support

| Host                               | Current status                                                       |
| ---------------------------------- | -------------------------------------------------------------------- |
| Codex App                          | Shipped interactive MCP Apps UI and Codex submission adapter         |
| Standards-compatible MCP Apps host | Adapter and protocol tested; host-specific acceptance still required |
| Codex CLI / Claude Code            | Headless MCP tool compatibility; no embedded review UI               |
| Claude Desktop / pi                | Architecture-ready, not yet accepted as shipped integrations         |
| Tauri                              | Future shell seam only; no Tauri application is included             |

Unshipped adapters and browser-acceptance follow-ups are tracked in [ROADMAP.md](./ROADMAP.md).

## Install from the repository marketplace

Requirements:

- Codex in the ChatGPT desktop app with plugin support.
- Node.js 22.13 or newer available as `node`.
- The `codex` CLI for adding the marketplace source.

Add this repository as a marketplace:

```sh
codex plugin marketplace add tjs-w/FlowZone --ref main
```

Restart the desktop app, open the Plugins Directory, select **FlowZone**, and install it. Start a new task after installation so the task receives the bundled plugin registrations.

To refresh an existing installation:

```sh
codex plugin marketplace upgrade flowzone
```

Restart the desktop app and start a new task after an upgrade. Existing tasks retain the tool and skill registrations they started with.

## Use

Ask Codex to open an absolute Markdown path:

```text
Open /absolute/path/to/document.md for Markdown review.
```

The bundled skill translates that request to the Markdown presentation tool:

```json
{ "path": "/absolute/path/to/document.md" }
```

In the review:

1. Select text and copy it normally if needed, or choose a rendered image.
2. Right-click the document or choose **Review** for copy and comment actions. The selection's `+` action and each image target remain direct shortcuts.
3. Press Enter to queue the comment; use Shift+Enter for a new line.
4. Reference an earlier queued comment with `#1`, `#2`, and so on.
5. Select **Submit** when the review round is complete.

After a successful submission, the queue clears and the next review round begins again at `#1`. There is deliberately no individual-submit action: batching gives Codex one coherent revision target and reduces source conflicts.

## Local development

```sh
git clone https://github.com/tjs-w/FlowZone.git
cd flowzone
bun install --frozen-lockfile
bun run verify
```

Development and CI use the pinned Bun 1.4 toolchain. Installed plugins do not require Bun: the repository checks in a readable Node-compatible `server.cjs` plus minified browser bundles. Rebuild after changing TypeScript source:

```sh
bun run build
```

Run the browser harness against a Markdown file for UI work:

```sh
bun run browser:harness -- /absolute/path/to/document.md
```

Set `MARKDOWN_REVIEW_PREVIEW_COMPOSER=1` to open the feedback composer automatically in the harness.

The Markdown Review view suppresses the host's native context menu by default. For local plugin debugging only, set `FLOWZONE_DEVTOOLS=1` in the MCP server environment and restart Codex; `Shift+right-click` then bypasses the review menu and opens the host-native menu. Ordinary right-click continues to show review actions. The flag is parsed strictly—only the exact value `1` enables the bypass—and is never enabled in the checked-in `.mcp.json`.

To test this checkout as a local marketplace, add its absolute directory:

```sh
codex plugin marketplace add /absolute/path/to/flowzone
```

Then restart the desktop app and install the plugin from the local marketplace source.

## Safety and privacy boundaries

- The component cannot write the Markdown file.
- The native browser context menu is suppressed inside the plugin unless the local MCP server starts with the explicit developer flag; this is UI hardening, not a security boundary around Codex App's own menus or shortcuts.
- Rendered HTML is sanitized before it reaches the component.
- Mermaid runs only in the bundled browser view with strict security settings, no interaction binding, a second SVG allowlist pass, and a per-diagram shadow root that contains retained diagram styles. Per-diagram and document-wide source bytes, output bytes, elements, edges, dimensions, and UI wait time are bounded; stale queued renders are cancelled, and external links, resources, focus traps, filters, and active SVG content are removed. The original fenced source remains canonical and selectable, and stays disclosed when it owns a comment.
- Remote, absolute, and out-of-directory images are not loaded.
- Only relative paths to PNG, JPEG (`.jpg`/`.jpeg`), and static WebP files inside the Markdown file's directory are supported. The server verifies extension, signature, bounded container structure, dimensions, and animation policy before the browser performs native decoding. GIF, AVIF, SVG, APNG, and animated WebP are not rendered.
- The component resource declares no network or remote resource domains and requests only clipboard-write access for the explicit **Copy selected text** action.
- A Markdown file is limited to 2 MiB.
- A review processes at most 64 local-image references—including invalid references—5 MiB per unique image, and 12 MiB of unique image snapshots in total, with strict per-image decoded-dimension limits. Every valid reference is rendered: the browser fairly shares a bounded 24-megapixel canvas budget across the document and downscales large images for display instead of omitting them. References that resolve to the same canonical file or identical digest share one immutable snapshot and verified client decode.
- Canonical paths and opened-file identities are rechecked around each bounded read. These checks are defense in depth, not an OS sandbox against another local process that can continuously replace the document directory hierarchy during a read.
- Component access uses opaque, expiring review-session capabilities. Sessions slide for two hours and are bounded by a six-session LRU and a 72 MiB aggregate image cache.
- Image bytes and SHA-256 digests are snapshotted into a session, so later file mutations cannot change an in-flight review.
- Full document content and image chunks are placed in component-private metadata rather than model-visible structured output.
- The startup registry snapshots plugin configuration. CLI adapters use fixed direct execution, JSON stdin, integrity checks, bounded output, cancellation, and timeouts; they are trusted code running as the FlowZone OS user, not sandboxed workloads.
- Backend adapters use fixed credential-free HTTPS endpoints, runtime credential injection, no redirects, bounded response streaming, cancellation, and strict output validation.
- Automatic retries are bounded and available only to actions declared idempotent; per-action concurrency and circuit-breaker limits contain repeated failures.

Review only files you intend to expose to the local FlowZone process. Submitted comments are actionable user feedback; selected quotes and other reviewed document content remain untrusted context, not instructions.

## Project layout

| Path                               | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `.codex-plugin/plugin.json`        | FlowZone bundle identity and install-surface metadata          |
| `.agents/plugins/marketplace.json` | Repository marketplace entry                                   |
| `.mcp.json`                        | Bundled local MCP server configuration                         |
| `skills/markdown-review/`          | Codex workflow and feedback-handling instructions              |
| `skills/dyna/`                     | Schedule, publishing, dashboard, and Codex action workflow     |
| `packages/dyna-contracts/`         | Dyna source, snapshot, action, and render-catalog schemas      |
| `packages/dyna-core/`              | Pure Dyna snapshot-to-component compilation                    |
| `packages/dyna-node/`              | SQLite persistence and capability-bound action state machine   |
| `packages/dyna-ui/`                | Responsive React and Apps SDK UI dashboard                     |
| `packages/flowzone-contracts/`     | Shared router, UI envelope, limits, and error contracts        |
| `packages/contracts/`              | Zod schemas and JSON-safe shared types                         |
| `packages/core/`                   | Pure queue, reference, migration, and submission state         |
| `packages/markdown-node/`          | Bounded local Markdown/image loading and rendering             |
| `packages/review-ui/`              | Reusable DOM controller over host-neutral ports                |
| `packages/host-mcp-apps/`          | Standard MCP Apps host adapter and native browser image decode |
| `packages/mcp-server/`             | Generic FlowZone registry plus bundled plugin factories        |
| `server/src/main.ts`               | Static plugin list and single Node stdio composition root      |
| `server/dist/server.cjs`           | Checked-in executable MCP server bundle                        |
| `web/flowzone.html`                | Universal accessible FlowZone UI shell                         |
| `web/dist/flowzone.js`             | Checked-in minified MCP Apps UI bundle                         |
| `web/dyna.html`, `web/dist/dyna.*` | Dedicated checked-in Dyna MCP Apps resource                    |
| `tests/` and package tests         | Unit, integration, adapter, and browser coverage               |

## Troubleshooting

**FlowZone is installed, but `flowzone` or a new action is not registered.** Restart the desktop app and start a new task. A task does not dynamically acquire tool schemas from a plugin installed or updated after that task began.

**Codex says a cached skill path moved.** Upgrade or reinstall the marketplace plugin, restart the app, and invoke the stable skill name `$markdown-review` in a new task. Do not depend on a versioned cache path.

**The side panel is blank.** Run `bun run verify` in the plugin checkout, rebuild with `bun run build`, refresh the marketplace installation, and retry in a new task.

**A local image does not render.** Use a relative `.png`, `.jpg`, `.jpeg`, or static `.webp` path located inside the Markdown file's directory and confirm it is within the documented size and dimension limits.

**A Mermaid diagram does not render.** Use a fenced `mermaid` code block with valid Mermaid syntax. Expand **Mermaid source** to inspect it; invalid, oversized, or unusually complex diagrams stay visible as source instead of running unbounded browser work.

## Documentation

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin documentation](https://developers.openai.com/plugins/)

FlowZone and Markdown Review are independent projects and are not official OpenAI or GitHub products. Product names and marks belong to their respective owners.
