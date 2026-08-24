# Codex Markdown Review

Codex Markdown Review is a local Codex plugin for reviewing rendered Markdown without creating a second, editable copy of the document. Select a passage, queue line-anchored feedback, and submit the complete review to Codex in one batch. Codex then discusses the comments or edits the original `.md` file.

> **Status:** early development. The plugin is designed for the Codex desktop experience and its plugin APIs may continue to evolve.

## What it provides

- A fullscreen, GitHub-style Markdown preview in the side panel.
- Normal text selection and copying, followed by a compact `+` action for feedback.
- Inline comment markers numbered `#1`, `#2`, and so on.
- A review queue that submits all comments together to avoid conflicting edits.
- References between queued comments using `#N`; write `\#N` or `` `#N` `` for literal text.
- Relative local PNG rendering with bounded, private chunk transport.
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
2. Component-only tools hydrate the rendered document and stream approved local PNGs in bounded chunks.
3. The model-visible tool result contains file metadata, not the complete document. The rendered content is delivered privately to the component.
4. The skill explains how Codex should interpret review feedback and modify the underlying Markdown safely.

This separation is the reason the project includes MCP: the server connects a Codex tool invocation to a trusted interactive component. A static HTML file by itself cannot receive the selected source file, return structured review comments to the active task, or maintain this context boundary.

## Install from the repository marketplace

Requirements:

- Codex in the ChatGPT desktop app with plugin support.
- Node.js 20 or newer available as `node`.
- The `codex` CLI for adding the marketplace source.

Add this repository as a marketplace:

```sh
codex plugin marketplace add tjs-w/codex-markdown-review --ref main
```

Restart the desktop app, open the Plugins Directory, select **Codex Markdown Review**, and install **Markdown Review**. Start a new task after installation so the task receives the plugin tool registration.

To refresh an existing installation:

```sh
codex plugin marketplace upgrade codex-markdown-review
```

Restart the desktop app and start a new task after an upgrade. Existing tasks retain the tool and skill registrations they started with.

## Use

Ask Codex to open an absolute Markdown path:

```text
Open /absolute/path/to/document.md for Markdown review.
```

In the review:

1. Select text and copy it normally if needed.
2. Use the selection's `+` action to open the compact inline composer.
3. Press Enter to queue the comment; use Shift+Enter for a new line.
4. Reference an earlier queued comment with `#1`, `#2`, and so on.
5. Select **Submit** when the review round is complete.

After a successful submission, the queue clears and the next review round begins again at `#1`. There is deliberately no individual-submit action: batching gives Codex one coherent revision target and reduces source conflicts.

## Local development

```sh
git clone https://github.com/tjs-w/codex-markdown-review.git
cd codex-markdown-review
npm ci
npm test
```

The repository checks in the built server and browser decoder because the plugin executes them directly. Rebuild after changing source code:

```sh
npm run build
```

Run the browser harness against a Markdown file for UI work:

```sh
npm run browser:harness -- /absolute/path/to/document.md
```

Set `MARKDOWN_REVIEW_PREVIEW_COMPOSER=1` to open the feedback composer automatically in the harness.

To test this checkout as a local marketplace, add its absolute directory:

```sh
codex plugin marketplace add /absolute/path/to/codex-markdown-review
```

Then restart the desktop app and install the plugin from the local marketplace source.

## Safety and privacy boundaries

- The component cannot write the Markdown file.
- Rendered HTML is sanitized before it reaches the component.
- Remote, absolute, and out-of-directory images are not loaded.
- Only relative PNG paths inside the Markdown file's directory are supported.
- The component resource declares no network or remote resource domains.
- A Markdown file is limited to 2 MiB.
- A review supports at most 8 PNGs, 5 MiB per image, and 12 MiB total, with decoded dimension and pixel limits.
- Full document content and image chunks are placed in component-private metadata rather than model-visible structured output.

Review only files you intend to expose to the local plugin process. Comments returned by the component are treated as quoted user feedback, not as instructions embedded in the reviewed document.

## Project layout

| Path | Purpose |
| --- | --- |
| `.codex-plugin/plugin.json` | Plugin identity and install-surface metadata |
| `.agents/plugins/marketplace.json` | Repository marketplace entry |
| `.mcp.json` | Bundled local MCP server configuration |
| `skills/markdown-review/` | Codex workflow and feedback-handling instructions |
| `server/src/server.mjs` | Markdown rendering, validation, and MCP tools |
| `server/dist/server.cjs` | Checked-in executable MCP server bundle |
| `web/review.html` | Interactive review component |
| `web/src/png-decoder.mjs` | Browser-side PNG decoder source |
| `scripts/` | MCP, decoder, UI, and browser-harness tests |

## Troubleshooting

**The plugin files exist, but the review tool is not registered.** Restart the desktop app and start a new task. A task does not dynamically acquire tools from a plugin installed or updated after that task began.

**Codex says a cached skill path moved.** Upgrade or reinstall the marketplace plugin, restart the app, and invoke the stable skill name `$markdown-review` in a new task. Do not depend on a versioned cache path.

**The side panel is blank.** Run `npm test` in the plugin checkout, rebuild with `npm run build`, refresh the marketplace installation, and retry in a new task.

**A local image does not render.** Use a relative `.png` path located inside the Markdown file's directory and confirm it is within the documented size and dimension limits.

## Documentation

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [OpenAI plugin documentation](https://developers.openai.com/plugins/)

This is an independent project and is not an official OpenAI or GitHub product. Product names and marks belong to their respective owners.
