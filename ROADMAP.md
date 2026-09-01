# Roadmap

FlowZone keeps future plugins and unshipped host integrations explicit rather than implying support that has not passed acceptance testing.

## FlowZone plugin host

- Add a second bundled plugin to validate the published contracts and universal view registry against a non-document workflow.
- Add optional app-only plugin-scoped health diagnostics without widening the single model-visible router.
- Evaluate stronger per-adapter OS isolation for CLI plugins; the current fixed-command controls intentionally do not claim to sandbox trusted child processes.
- Evaluate Streamable HTTP only with an explicit deployment model and the required authentication, authorization, TLS, CORS, CSRF, request-size, and rate-limit controls. Local stdio remains the shipped transport.

## 0.2.0 portability and browser acceptance

- Add dedicated Claude Desktop and pi adapters only after their component and state capabilities can be tested in those hosts. Codex CLI and Claude Code remain headless MCP integrations.
- Add the first Tauri shell with capability-scoped Rust IPC ports. The current `contracts`, `core`, and `review-ui` packages, including the host-supplied raster decoder port, are the reusable boundary.
- Add approved Chromium and WebKit visual baselines plus a dedicated Firefox Nightly acceptance job. Playwright Chromium/WebKit behavior and Firefox advisory coverage exist now; visual baselines require review on controlled engine revisions before they can become blocking.
- Add cancellation to `DocumentPort.loadAssetChunk` when MCP Apps exposes a portable cancellation contract. Generation checks already discard stale results and bound residual work to the active worker count.
- Revisit selection-announcement debouncing after screen-reader testing. The current implementation avoids duplicate announcements, dismisses the floating action on scroll, and keeps native selection/copy intact.

These items are not part of the 0.1.0 shipped support claim.
