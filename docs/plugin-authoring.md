# FlowZone plugin authoring

A FlowZone plugin is a statically imported declaration. It cannot register raw MCP capabilities and cannot create a transport. Start from the exported `FlowZonePlugin`, `FlowZoneAction`, and `FlowZoneAppTool` types in `@flowzone/mcp-server`.

## Action checklist

- Use stable lowercase IDs and bounded human-readable metadata.
- Make input and output schemas strict object-root Zod schemas. Keep discriminated branches object-root as well.
- Return only the smallest model-useful data in `result`.
- Put full documents, binary chunks, credentials, and UI-only state in a validated private UI payload or app-only helper result.
- Set action risk metadata accurately. Only idempotent actions can be retried.
- Honor `context.signal` and report monotonic, bounded progress only when meaningful.
- Convert domain failures to stable safe errors. Never include request bodies, credentials, filesystem details, backend response bodies, or raw stderr.

## Executor selection

Use an in-process module for bundled code and normal local services. Use a CLI adapter only when a reviewed existing program is the integration boundary; command, arguments, cwd, inherited variables, and integrity files must all be static. Model input travels only in the JSON stdin envelope. Treat the adapter as trusted code running with FlowZone's OS privileges.

Use an HTTP adapter only for one fixed HTTPS endpoint. Inject authorization at runtime through a credential provider. FlowZone forbids redirects and query-bearing endpoints and bounds the JSON response, but the plugin remains responsible for backend authorization and tenant isolation.

## UI and app-only helpers

An action may declare a `view` and `payloadSchema`. Add a matching handler to the browser view registry; never parse a private payload without its plugin schema. Actions without a plugin view use FlowZone's generic completion view. The universal resource is owned by FlowZone, not by the plugin.

Use app-only helpers for interactive refresh, pagination, binary chunks, and view-local mutations. Helper names remain globally unique, but FlowZone centrally forces `_meta.ui.visibility: ["app"]`. Do not duplicate these helpers as model-visible actions unless there is a distinct user-authorized workflow.

## Registration and release

Add the plugin factory to `server/src/main.ts`; there is no dynamic discovery. Test duplicate identifiers, malformed input/output, size boundaries, cancellation, private/public separation, executor tampering, and a real stdio call. Update documentation and skill guidance, rotate the manifest cachebuster, rebuild `server/dist/server.cjs` and `web/dist/flowzone.js`, then run the complete verification suite.
