# Changelog

## Unreleased

- Replaced plugin-owned model tools with one schema-driven `flowzone` router backed by an immutable startup registry; Markdown Review now uses the `markdown-review/open` route while retaining its typed app-only helpers and review wire contracts.
- Added in-process, fixed allowlisted CLI/script, and fixed HTTPS executor contracts with bounded input/output, safe errors, cancellation, progress, timeouts, idempotent-only retries, concurrency limits, circuit breaking, command/file identity checks, runtime credentials, and no redirect following.
- Introduced shared FlowZone request/result/UI/error contracts and the `ui://flowzone/v1.html` universal shell with a fixed view registry, closed CSP, and a temporary v30 Markdown resource/private-metadata compatibility bridge.
- Updated the Markdown Review skill to guide router invocation without acting as a runtime backend, and documented plugin authoring and security boundaries.
- Renamed the repository and installable bundle to FlowZone.

All notable changes to this project will be documented here.

## 0.1.0 - 2026-08-24

- Added a fullscreen, GitHub-style rendered Markdown review surface.
- Added copy-friendly text selection with a compact inline feedback composer.
- Added queued, line-anchored comments and one-batch submission.
- Added stable comment references within a review round and escaped literal references.
- Added safe relative local PNG, JPEG, and static WebP rendering through private, bounded chunks and native browser decoding.
- Increased the local-image reference budget to 64, deduplicated immutable snapshots by path and digest, and hardened reference, byte, pixel, container, animation, format, and path-race limits.
- Kept full document content out of model-visible MCP tool results.
- Formatted Submit messages as concise Markdown with a lossless fenced JSON review envelope.
- Added the automatic Markdown review skill, smoke tests, and a browser UI harness.
- Migrated maintained source and tests to strict TypeScript workspaces with Bun 1.4 tooling.
- Split contracts, pure review state, Node Markdown loading, reusable UI, MCP Apps hosting, and server composition into portable packages.
- Added opaque expiring review sessions, immutable image snapshots, SHA-256 image revisions, bounded reads, and LRU cache limits.
- Updated the component resource cache key to `ui://markdown-review/v17.html` and replaced the handwritten bridge with the official MCP Apps client.
- Updated the component resource cache key to `ui://markdown-review/v18.html` and made private component-tool failures explicit, bounded, and safe to diagnose.
- Updated the component resource cache key to `ui://markdown-review/v19.html`, removed the redundant bundled PNG decoder, and kept unsupported AVIF, GIF, SVG, and animated images fail-closed.
- Updated the component resource cache key to `ui://markdown-review/v20.html` and persisted validated review queues across component remounts using the stable review-session ID, bounded local storage, and an awaited teardown flush.
- Updated the component resource cache key to `ui://markdown-review/v21.html` and made rendered images accessible pointer, touch, and keyboard comment targets with durable queued-image highlights.
- Updated the component resource cache key to `ui://markdown-review/v22.html` and replaced the aggregate decoded-pixel admission failure with fair, bounded browser raster allocation so every valid image reference remains visible.
- Updated the component resource cache key to `ui://markdown-review/v23.html`, refined queued-text highlights, kept adjacent headings out of boundary selections, and excluded inserted review UI from native highlight ranges.
- Updated the component resource cache key to `ui://markdown-review/v24.html`, added an accessible review context menu with exact selected-text copy and whole-document feedback, and gated the native DevTools menu behind `MARKDOWN_REVIEW_DEVTOOLS=1` plus `Shift+right-click`.
- Updated the component resource cache key to `ui://markdown-review/v25.html`, moved image feedback affordances to a hover/focus-only bottom-right overlay, and kept directional text-selection actions attached to their focus endpoint across scrolling and reflow.
- Updated the component resource cache key to `ui://markdown-review/v26.html`, recovered fresh private image snapshots after host-session loss through a bundled app-only tool that reapplies canonical-path and size policies, accepted a validated static PNG/JPEG/WebP signature when a supported image filename has a stale extension, preserved drafts and queued revisions across refresh/recovery, fixed stale selection and link-drag gestures, and added a permission-tolerant selected-text copy fallback with an accessible manual-copy escape hatch.
- Updated the component resource cache key to `ui://markdown-review/v27.html`, restored reliable one-click submission through the Codex follow-up bridge, moved the host-reviewed Send popup behind a split-button Review action, and added `Command/Ctrl + Shift + Enter` direct submission.
- Updated the component resource cache key to `ui://markdown-review/v28.html`, kept one active review per Markdown path by avoiding repeat opens after edits, added lightweight private revision checks, refreshed changed source in place, and showed a tiny `File updated` indicator without discarding queued feedback or drafts.
- Updated the component resource cache key to `ui://markdown-review/v29.html` and rendered GFM task-list items as clear read-only checkboxes without duplicate list bullets, while preserving ordinary list markers and forced-colors support.
- Updated the component resource cache key to `ui://markdown-review/v30.html`, replaced automatic source switching with a dismissible `Refresh for latest` prompt, and reshaped the comment editor around a compact rounded command field while retaining explicit queue, close, help, keyboard, and accessibility controls.
- Added durable, eye-comfortable selected-text highlights for queued comments in light, dark, and forced-color themes, including exact duplicate-text anchors and safe stale relocation.
- Removed legacy model-visible widget-state publication and shortened the fenced, injection-resistant Codex submission prompt.
- Fixed Submit in Codex by accepting the host's standard empty `message` capability object.
- Moved the selection guidance and keyboard shortcut into an accessible header info tooltip.
- Docked queued comments in a toggleable split-view rail that never overlays the document.
- Prevented narrow host resizing from collapsing the fullscreen review surface.
- Kept the shipped server as a Node 22-compatible CJS bundle and browser assets as checked-in minified bundles.
