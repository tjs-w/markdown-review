# Changelog

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
- Added durable, eye-comfortable selected-text highlights for queued comments in light, dark, and forced-color themes, including exact duplicate-text anchors and safe stale relocation.
- Removed legacy model-visible widget-state publication and shortened the fenced, injection-resistant Codex submission prompt.
- Fixed Submit in Codex by accepting the host's standard empty `message` capability object.
- Moved the selection guidance and keyboard shortcut into an accessible header info tooltip.
- Docked queued comments in a toggleable split-view rail that never overlays the document.
- Prevented narrow host resizing from collapsing the fullscreen review surface.
- Kept the shipped server as a Node 22-compatible CJS bundle and browser assets as checked-in minified bundles.
