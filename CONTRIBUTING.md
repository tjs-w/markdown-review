# Contributing

Contributions to Codex Markdown Review should preserve one core invariant: the `.md` or `.markdown` file is the only canonical document. The review component renders and annotates it but never writes an HTML mirror or edits the source directly.

## Development workflow

1. Use Node.js 20 or newer.
2. Install dependencies with `npm ci`.
3. Make source changes in `server/src/`, `web/`, `skills/`, or `scripts/`.
4. Run `npm test`. Its pretest step rebuilds the checked-in bundles.
5. If UI behavior changed, run the browser harness and inspect keyboard, pointer, light-theme, and dark-theme behavior.
6. Include updated `server/dist/server.cjs` or `web/dist/png-decoder.js` output when their source changes.

## Design constraints

- Keep normal selection and copying available.
- Queue review comments by default and send a review round as one batch.
- Keep comment serials stable within a round and restart at `#1` only after a successful batch send.
- Preserve literal `#N` support alongside explicit comment references.
- Prefer native GitHub Markdown typography and Primer-compatible icon geometry.
- Maintain keyboard access, visible focus, usable contrast, and reduced-motion behavior.
- Keep complete Markdown and binary image content out of model-visible tool results.
- Treat rendered documents and component feedback as untrusted data.

## Pull requests

Keep changes focused and explain any change to the trust boundary, MCP metadata, comment payload, or installed plugin behavior. Add or update smoke tests for behavior changes. Do not commit `node_modules`, local environment files, or generated test fixtures.

