# Contributing

Contributions to Markdown Review should preserve one core invariant: the `.md` or `.markdown` file is the only canonical document. The review component renders and annotates it but never writes an HTML mirror or edits the source directly.

## Development workflow

1. Use Node.js 22 or newer and Bun 1.4.
2. Install dependencies with `bun install --frozen-lockfile`.
3. Make source changes in `packages/`, `server/src/`, `web/src/`, `skills/`, or `tests/`.
4. Run `bun run verify`, then `bun run build` when checked-in artifacts changed.
5. If UI behavior changed, run the browser harness and inspect keyboard, pointer, light-theme, and dark-theme behavior.
6. Include updated `server/dist/server.cjs` and `web/dist/review.js` output when their source changes.

Keep reusable packages host-neutral: `review-ui` must not import Node, MCP, Codex, or Tauri APIs. Host-specific behavior belongs in an adapter behind the documented ports. Validate data received across host, persisted-state, document, and image boundaries before use.

## Design constraints

- Keep normal selection and copying available.
- Queue review comments by default and submit a review round as one batch.
- Keep comment serials stable within a round and restart at `#1` only after a successful batch submission.
- Preserve literal `#N` support alongside explicit comment references.
- Prefer native GitHub Markdown typography and Primer-compatible icon geometry.
- Maintain keyboard access, visible focus, usable contrast, and reduced-motion behavior.
- Keep complete Markdown and binary image content out of model-visible tool results.
- Treat rendered documents and component feedback as untrusted data.

## Pull requests

Keep changes focused and explain any change to the trust boundary, MCP metadata, comment payload, or installed plugin behavior. Add or update smoke tests for behavior changes. Do not commit `node_modules`, local environment files, or generated test fixtures.
