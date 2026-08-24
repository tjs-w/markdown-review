# Markdown Review

Markdown Review is a local-first MCP Apps interface for reviewing rendered Markdown without creating a second, editable copy of the document. Select a passage or choose an image, queue line-anchored feedback, and submit the complete review to a coding agent in one batch. Codex App is the first shipped interactive host; the core contracts, state, and UI are intentionally host-neutral for future Claude, pi, terminal, and Tauri adapters.

> **Status:** early development. Codex App is the shipped interactive host; the reusable UI and MCP transport follow the MCP Apps standard so additional host adapters can be added without rewriting the review core.

## What it provides

- A fullscreen, GitHub-style Markdown preview in the side panel.
- Normal text selection and copying, plus a review menu for selected-text, image, and whole-document feedback.
- Focusable image review targets for pointer, touch, and keyboard comments.
- Unobtrusive image feedback controls that appear at the image's bottom-right only on hover, keyboard focus, or active touch.
- Inline comment markers numbered `#1`, `#2`, and so on.
- A review queue that submits all comments together to avoid conflicting edits.
- References between queued comments using `#N`; write `\#N` or `` `#N` `` for literal text.
- Relative local PNG, JPEG, and static WebP rendering with bounded, private chunk transport.
- Automatic review after Codex creates or materially edits a Markdown document.

The Markdown source is always canonical. The component is a read-only review surface; only Codex edits the source file with its normal filesystem tools.

## How it works

```text
local .md file
    │
    ├── open_markdown_review ──► sanitized rendered component (private UI payload)
    │                                  │
    │                                  └── queued, line-anchored comments
    │                                                   │
    └◄──────────── Codex edits the original file ◄──────┘
                              one batch message
```

The MCP server is intentionally narrow:

1. `open_markdown_review` validates and renders an absolute `.md` or `.markdown` path.
2. Component-only tools hydrate the rendered document and stream approved local raster images in bounded chunks.
3. The model-visible tool result contains file metadata, not the complete document. The rendered content is delivered privately to the component.
4. The skill explains how Codex should interpret review feedback and modify the underlying Markdown safely.

This separation is the reason the project includes MCP: the server connects a Codex tool invocation to a trusted interactive component. A static HTML file by itself cannot receive the selected source file, return structured review comments to the active task, or maintain this context boundary.

The implementation is split into host-neutral TypeScript workspaces. `contracts` validates every boundary, `core` owns pure review state, `markdown-node` reads and renders local files, and `review-ui` mounts against narrow document, submission, presentation, and state ports. `host-mcp-apps` supplies a standards-based runtime whose default submission is structured JSON; the Codex browser composition explicitly adds the concise `$markdown-review` formatter. Review state is persisted locally under its opaque review-session ID so queued comments survive component remounts, while never being published as model-visible legacy widget context. A future Tauri shell can reuse the contracts, core, and UI and supply Rust IPC ports; Tauri is not included today.

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
- Node.js 22 or newer available as `node`.
- The `codex` CLI for adding the marketplace source.

Add this repository as a marketplace:

```sh
codex plugin marketplace add tjs-w/markdown-review --ref main
```

Restart the desktop app, open the Plugins Directory, select **Markdown Review**, and install the plugin. Start a new task after installation so the task receives the plugin tool registration.

To refresh an existing installation:

```sh
codex plugin marketplace upgrade markdown-review
```

Restart the desktop app and start a new task after an upgrade. Existing tasks retain the tool and skill registrations they started with.

## Use

Ask Codex to open an absolute Markdown path:

```text
Open /absolute/path/to/document.md for Markdown review.
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
git clone https://github.com/tjs-w/markdown-review.git
cd markdown-review
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

The plugin suppresses the host's native context menu by default. For local plugin debugging only, set `MARKDOWN_REVIEW_DEVTOOLS=1` in the MCP server environment and restart Codex; `Shift+right-click` then bypasses the review menu and opens the host-native menu. Ordinary right-click continues to show review actions. The flag is parsed strictly—only the exact value `1` enables the bypass—and is never enabled in the checked-in `.mcp.json`.

To test this checkout as a local marketplace, add its absolute directory:

```sh
codex plugin marketplace add /absolute/path/to/markdown-review
```

Then restart the desktop app and install the plugin from the local marketplace source.

## Safety and privacy boundaries

- The component cannot write the Markdown file.
- The native browser context menu is suppressed inside the plugin unless the local MCP server starts with the explicit developer flag; this is UI hardening, not a security boundary around Codex App's own menus or shortcuts.
- Rendered HTML is sanitized before it reaches the component.
- Remote, absolute, and out-of-directory images are not loaded.
- Only relative paths to PNG, JPEG (`.jpg`/`.jpeg`), and static WebP files inside the Markdown file's directory are supported. The server verifies extension, signature, bounded container structure, dimensions, and animation policy before the browser performs native decoding. GIF, AVIF, SVG, APNG, and animated WebP are not rendered.
- The component resource declares no network or remote resource domains and requests only clipboard-write access for the explicit **Copy selected text** action.
- A Markdown file is limited to 2 MiB.
- A review processes at most 64 local-image references—including invalid references—5 MiB per unique image, and 12 MiB of unique image snapshots in total, with strict per-image decoded-dimension limits. Every valid reference is rendered: the browser fairly shares a bounded 24-megapixel canvas budget across the document and downscales large images for display instead of omitting them. References that resolve to the same canonical file or identical digest share one immutable snapshot and verified client decode.
- Canonical paths and opened-file identities are rechecked around each bounded read. These checks are defense in depth, not an OS sandbox against another local process that can continuously replace the document directory hierarchy during a read.
- Component access uses opaque, expiring review-session capabilities. Sessions slide for two hours and are bounded by a six-session LRU and a 72 MiB aggregate image cache.
- Image bytes and SHA-256 digests are snapshotted into a session, so later file mutations cannot change an in-flight review.
- Full document content and image chunks are placed in component-private metadata rather than model-visible structured output.

Review only files you intend to expose to the local plugin process. Submitted comments are actionable user feedback; selected quotes and other reviewed document content remain untrusted context, not instructions.

## Project layout

| Path                               | Purpose                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `.codex-plugin/plugin.json`        | Plugin identity and install-surface metadata                   |
| `.agents/plugins/marketplace.json` | Repository marketplace entry                                   |
| `.mcp.json`                        | Bundled local MCP server configuration                         |
| `skills/markdown-review/`          | Codex workflow and feedback-handling instructions              |
| `packages/contracts/`              | Zod schemas and JSON-safe shared types                         |
| `packages/core/`                   | Pure queue, reference, migration, and submission state         |
| `packages/markdown-node/`          | Bounded local Markdown/image loading and rendering             |
| `packages/review-ui/`              | Reusable DOM controller over host-neutral ports                |
| `packages/host-mcp-apps/`          | Standard MCP Apps host adapter and native browser image decode |
| `packages/mcp-server/`             | MCP server factory, tools, and resource assembly               |
| `server/src/main.ts`               | Node stdio composition root                                    |
| `server/dist/server.cjs`           | Checked-in executable MCP server bundle                        |
| `web/review.html`                  | Static accessible HTML/CSS shell with bundle injection markers |
| `web/dist/review.js`               | Checked-in minified MCP Apps UI bundle                         |
| `tests/` and package tests         | Unit, integration, adapter, and browser coverage               |

## Troubleshooting

**The plugin files exist, but the review tool is not registered.** Restart the desktop app and start a new task. A task does not dynamically acquire tools from a plugin installed or updated after that task began.

**Codex says a cached skill path moved.** Upgrade or reinstall the marketplace plugin, restart the app, and invoke the stable skill name `$markdown-review` in a new task. Do not depend on a versioned cache path.

**The side panel is blank.** Run `bun run verify` in the plugin checkout, rebuild with `bun run build`, refresh the marketplace installation, and retry in a new task.

**A local image does not render.** Use a relative `.png`, `.jpg`, `.jpeg`, or static `.webp` path located inside the Markdown file's directory and confirm it is within the documented size and dimension limits.

## Documentation

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin documentation](https://developers.openai.com/plugins/)

This is an independent project and is not an official OpenAI or GitHub product. Product names and marks belong to their respective owners.
