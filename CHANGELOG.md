# Changelog

All notable changes to this project will be documented here.

## 0.1.0 - 2026-08-24

- Added a fullscreen, GitHub-style rendered Markdown review surface.
- Added copy-friendly text selection with a compact inline feedback composer.
- Added queued, line-anchored comments and one-batch submission.
- Added stable comment references within a review round and escaped literal references.
- Added safe relative local PNG rendering through private, bounded chunks.
- Kept full document content out of model-visible MCP tool results.
- Formatted Submit messages as concise Markdown with a lossless fenced JSON review envelope.
- Added the automatic Markdown review skill, smoke tests, and a browser UI harness.
- Migrated maintained source and tests to strict TypeScript workspaces with Bun 1.4 tooling.
- Split contracts, pure review state, Node Markdown loading, reusable UI, MCP Apps hosting, and server composition into portable packages.
- Added opaque expiring review sessions, immutable image snapshots, SHA-256 image revisions, bounded reads, and LRU cache limits.
- Updated the component resource cache key to `ui://markdown-review/v17.html` and replaced the handwritten bridge with the official MCP Apps client.
- Fixed Submit in Codex by accepting the host's standard empty `message` capability object.
- Moved the selection guidance and keyboard shortcut into an accessible header info tooltip.
- Docked queued comments in a toggleable split-view rail that never overlays the document.
- Prevented narrow host resizing from collapsing the fullscreen review surface.
- Kept the shipped server as a Node 22-compatible CJS bundle and browser assets as checked-in minified bundles.
