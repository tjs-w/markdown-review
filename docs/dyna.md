# Dyna executive dashboards

Dyna turns bounded output from recurring Codex jobs into persistent, mobile-friendly executive dashboards. It is bundled inside the FlowZone plugin and uses Codex's existing agent, connector, schedule, and task capabilities instead of introducing a second agent runtime.

## Product requirements

- One user can create many dashboards and many scheduled publishers.
- The relationship is many-to-many: one scheduled publisher can feed several dashboards, and one dashboard can aggregate several publishers.
- A job publishes normalized Slack, Outlook, GitLab, or Codex records. It cannot publish HTML, JSX, JavaScript, CSS, prompts, MCP tool names, or a render tree.
- FlowZone compiles those records into a fixed, validated `json-render` catalog backed by Apps SDK UI components.
- New information can enrich an existing item through a separate overlay. The overlay survives later source runs, records its provenance and base source version, and is visibly marked stale when the source changes underneath it.
- Users can add annotations and request a supported Codex action from a card.
- Task creation, attachment, navigation, and status inspection use the native Codex controller. Dyna stores the host/project identity and monotonic status observations only for explicitly linked tasks; it never scrapes or mirrors task transcripts.
- The component must remain usable in the mobile app through a Codex Remote connection.

## Architecture

```text
Codex scheduled tasks                Codex task controller
  Slack / Outlook / GitLab              create / read / open task
            │                                       ▲
            │ publish bounded records               │ opaque action request
            ▼                                       │
      Dyna SQLite store ── snapshot ──> pure compiler
            ▲                              │
            │ annotations/enrichment       ▼ validate
            │                     @json-render catalog
            │                              │
            └──── app-only tools ── Dyna MCP Apps UI
```

The packages divide responsibility as follows:

| Package                     | Responsibility                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `@flowzone/dyna-contracts`  | Strict Zod records, snapshot schema, and the fixed component catalog                      |
| `@flowzone/dyna-core`       | Deterministic priority ordering and snapshot-to-spec compilation                          |
| `@flowzone/dyna-node`       | SQLite persistence, capability tokens, action state machine, and snapshots                |
| `@flowzone/dyna-ui`         | Responsive React renderer, Apps SDK UI controls, annotations, polling, and host messaging |
| `@flowzone/mcp-server/dyna` | Model-visible actions, private app tools, and the dedicated presentation tool             |

The dedicated `render_dyna_dashboard` tool renders `ui://flowzone/dyna/v1.html`. It is separate from Markdown Review so Dyna does not inherit Mermaid's bundle weight or clipboard permission. Its combined checked-in HTML, JavaScript, and CSS budget is 750 KiB.

## Persistence and refresh

Dyna uses Node's built-in `node:sqlite` API and therefore requires Node 22.13 or newer. The database lives under the operating system's per-user application-data directory, or under `FLOWZONE_DATA_DIR` in tests and controlled deployments. The connection enables WAL, foreign keys, and a five-second busy timeout. Mutations use prepared statements and revision increments; publisher secrets, view capabilities, and completion capabilities are stored only as SHA-256 hashes.

Each publisher is registered against its native Codex schedule ID, title, state, freshness SLA (`staleAfterMinutes`), and last-run result. A successful `replace` run is an atomic full snapshot: omitted publisher memberships become inactive. `upsert` is available for explicit deltas. Failed runs contain no partial items, preserve the last good slice, and make that source—and therefore the aggregate dashboard—visibly stale. Every publication supplies both a stable run ID and the schedule execution's `sourceCompletedAt`. The run ID and a canonical request digest deduplicate exact retries and reject conflicting reuse; the completion time prevents a delayed older execution from replacing a newer slice. Superseded runs are recorded but do not change the dashboard. Canonical source references deduplicate the same Slack message, Outlook message, GitLab entity, or Codex task across schedules.

An active visible component polls every 15 seconds and refreshes immediately when it returns to the foreground. Hidden or unfocused components back off to 60 seconds. Refresh responses include a new private snapshot even when the data revision is unchanged so relative times and freshness continue to age. Each active schedule is fresh until 75% of its configured SLA, aging until the SLA, and stale after it; a failed or never-run active schedule is immediately stale. Every snapshot is read atomically. SQL deduplicates and orders the full eligible set, computes full summary counts, then batch-loads details only for the highest-priority 200 cards. View capabilities use a sliding 30-day lifetime and fail with an explicit reopen instruction after expiry.

## Action protocol

The browser never receives a native Codex session API. It prepares an allowlisted action through a capability-bound private tool and sends the current task only:

`Handle Dyna action request <request-id> with $flowzone:dyna.`

No source text, prompt, tool name, file path, or task transcript is included in that message. The `$flowzone:dyna` workflow claims the request once and receives immutable context plus a one-time completion token. It then uses the native Codex task tools and completes the state machine:

```text
PREPARED → DELIVERED → CLAIMED → SUCCEEDED
                               ├→ FAILED
                               └→ NEEDS_RECONCILIATION
```

Requests are bound to the dashboard revision, source fingerprint, item, task host, and a random per-attempt idempotency key. Ambiguous host delivery resends the same opaque request, and a remounted component recovers any matching nonterminal attempt from the server; a confirmed terminal result permits a deliberate new attempt. The controller atomically revalidates dashboard membership, revision, and fingerprint before claiming. Requests expire after ten minutes and claims have a five-minute completion lease; abandoned claims transition to `needs_reconciliation` on status inspection or before a new attempt. Claim and completion capabilities are 256-bit random values. Replays, stale screens, cross-dashboard status reads, regressive task observations, and action-incompatible completion payloads fail closed. Uncertain task creation places an item-scoped lock on new creation attempts until `resolve-action-reconciliation` links the verified native task or records that inventory verification found no created task.

## Mobile and Remote acceptance

The Dyna surface is a single responsive column with 44-pixel mobile touch targets, no hover-only controls, no horizontal table, system typography, light/dark support, CSS and host-provided safe-area insets, and reduced-motion support. On connection it advertises and requests the standard MCP Apps `fullscreen` presentation so Codex can open an expanded dashboard work surface alongside the task. MCP Apps does not expose a left/right docking parameter: the Codex host owns that exact placement, and the requirement to dock on the left must be verified against the target Codex desktop build. Inline-only hosts retain the complete content; a rejected expansion also reveals all cards and leaves a manual **Expand dashboard** retry with accessible failure feedback. The annotation sheet traps focus, dismisses with Escape, restores the trigger after cancel or save, and has a programmatic label. The catalog intentionally limits cards to two actions.

A release is not considered mobile-ready from browser emulation alone. Acceptance requires the current iOS and Android ChatGPT mobile apps connected to a Codex Remote host:

1. Open a dashboard from a remotely running task.
2. Background and foreground the app; verify the snapshot catches up without duplicate cards.
3. Add an annotation with the software keyboard open.
4. Create a Codex task from a card, verify exactly one task appears, and open it from the refreshed card.
5. Interrupt connectivity during creation and verify the request becomes failed or needs reconciliation rather than silently succeeding.
6. Verify light/dark themes, large text, screen-reader labels, and 320-pixel-wide layout.

## Delivery plan

The implemented vertical slice includes the contracts, compiler, SQLite store, native schedule inventory, atomic run slices, cross-schedule deduplication, durable enrichment overlays, annotations, the leased one-time action protocol, existing-task attachment, task-status links, the dedicated UI resource, integration tests against the checked-in Node bundle, and Dyna-specific accessibility/action/reflow journeys on Chromium, WebKit, mobile Chromium, and mobile WebKit.

Before declaring the feature generally available:

1. Add publisher rotation/revocation and retention controls.
2. Add user-facing retention/erasure controls and a task picker; the current controller can attach a task when given its exact native ID and host.
3. Run the physical Remote acceptance matrix above and record host/app versions.
4. Add backup/restore tests and formal versioned migrations beyond the included pre-release schema migration.

The design follows the official [OpenAI plugin UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines), [MCP Apps UI reference](https://developers.openai.com/plugins/reference), [scheduled tasks guidance](https://learn.chatgpt.com/docs/automations), and [Remote connections guidance](https://learn.chatgpt.com/docs/remote-connections).
