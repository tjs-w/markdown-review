# Roadmap

The TypeScript migration keeps unshipped host integrations explicit rather than implying support that has not passed real-host acceptance testing.

## 0.2.0 portability and browser acceptance

- Add dedicated Claude Desktop and pi adapters only after their component and state capabilities can be tested in those hosts. Codex CLI and Claude Code remain headless MCP integrations.
- Add the first Tauri shell with capability-scoped Rust IPC ports. The current `contracts`, `core`, and `review-ui` packages, including the host-supplied raster decoder port, are the reusable boundary.
- Add approved Chromium and WebKit visual baselines plus a dedicated Firefox Nightly acceptance job. Playwright Chromium/WebKit behavior and Firefox advisory coverage exist now; visual baselines require review on controlled engine revisions before they can become blocking.
- Add cancellation to `DocumentPort.loadAssetChunk` when MCP Apps exposes a portable cancellation contract. Generation checks already discard stale results and bound residual work to the active worker count.
- Revisit selection-announcement debouncing after screen-reader testing. The current implementation avoids duplicate announcements, dismisses the floating action on scroll, and keeps native selection/copy intact.

These items are not part of the 0.1.0 shipped support claim.
