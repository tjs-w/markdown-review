import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

import {
  DynaActionItemContextSchema,
  DynaActionKindSchema,
  DynaActionRequestSchema,
  DynaAnnotationSchema,
  DynaDashboardSchema,
  DynaDashboardSnapshotSchema,
  DynaItemContextSchema,
  DynaPublishedItemSchema,
  DynaPublisherSchema,
  DynaSourceRefSchema,
  DynaTaskStatusSchema,
  type DynaCard,
  type DynaDashboard,
  type DynaDashboardSnapshot,
  type DynaItemContext,
  type DynaPublishedItem,
  type DynaPublisher,
  type DynaTaskStatus,
} from "@flowzone/dyna-contracts";
import type { z } from "zod";

type DynaActionKind = z.infer<typeof DynaActionKindSchema>;
type SqlRow = Readonly<Record<string, unknown>>;

const VIEW_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const ACTION_TTL_MS = 10 * 60 * 1_000;
const CLAIM_LEASE_MS = 5 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface DynaPublishResult {
  readonly accepted: number;
  readonly deduplicated: boolean;
  readonly superseded: boolean;
  readonly status: "succeeded" | "failed";
}

export interface DynaPublishOptions {
  readonly runId: string;
  readonly sourceCompletedAt: string;
  readonly mode: "replace" | "upsert";
  readonly status: "succeeded" | "failed";
  readonly failureMessage?: string;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hashesMatch(value: string, stored: unknown): boolean {
  if (!(stored instanceof Uint8Array)) return false;
  const candidate = tokenHash(value);
  const expected = Buffer.from(stored);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Dyna database column ${key} is invalid.`);
  return value;
}

function optionalString(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Dyna database column ${key} is invalid.`);
  return value;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Dyna stored data is invalid.");
  }
}

function normalizeTimestamp(value: string, rejectFuture = false): { iso: string; epoch: number } {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("Dyna received an invalid timestamp.");
  if (rejectFuture && epoch > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new Error("Dyna source timestamps cannot be more than five minutes in the future.");
  }
  return { iso: new Date(epoch).toISOString(), epoch };
}

function identityKey(sourceRef: unknown): string {
  return sha256(JSON.stringify(DynaSourceRefSchema.parse(sourceRef)));
}

function normalizedPublishedItem(item: DynaPublishedItem): DynaPublishedItem {
  const parsed = DynaPublishedItemSchema.parse(item);
  return DynaPublishedItemSchema.parse({
    ...parsed,
    sourceUpdatedAt: normalizeTimestamp(parsed.sourceUpdatedAt, true).iso,
    ...(parsed.dueAt ? { dueAt: normalizeTimestamp(parsed.dueAt).iso } : {}),
  });
}

export function defaultDynaDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["FLOWZONE_DATA_DIR"];
  if (configured?.trim()) return resolve(configured, "dyna.sqlite3");
  if (platform() === "win32") {
    return join(environment["LOCALAPPDATA"] ?? homedir(), "Codex", "FlowZone", "dyna.sqlite3");
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Codex", "FlowZone", "dyna.sqlite3");
  }
  return join(
    environment["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
    "codex",
    "flowzone",
    "dyna.sqlite3",
  );
}

export interface DynaStoreOptions {
  readonly databasePath?: string;
  readonly clock?: () => Date;
}

export interface ClaimedDynaAction {
  readonly request: z.infer<typeof DynaActionRequestSchema>;
  readonly claimToken: string;
  readonly context: {
    readonly item?: z.infer<typeof DynaActionItemContextSchema>;
    readonly task?: DynaTaskStatus;
  };
}

export class DynaStore {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;

  constructor(options: DynaStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    const databasePath = options.databasePath ?? defaultDynaDatabasePath();
    if (databasePath !== ":memory:") {
      const dataDirectory = dirname(databasePath);
      mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
      chmodSync(dataDirectory, 0o700);
      if (existsSync(databasePath)) {
        const status = lstatSync(databasePath);
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new Error("The Dyna database path must be a regular file, not a link.");
        }
      }
    }
    this.#database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.#database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publishers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash BLOB NOT NULL,
        schedule_id TEXT, schedule_title TEXT, schedule_state TEXT NOT NULL DEFAULT 'unknown',
        stale_after_minutes INTEGER NOT NULL DEFAULT 1440,
        last_run_status TEXT NOT NULL DEFAULT 'never', last_run_at TEXT, last_run_completed_ms INTEGER,
        last_run_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dashboard_publishers (
        dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        PRIMARY KEY (dashboard_id, publisher_id)
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL, identity_key TEXT, source TEXT NOT NULL, source_ref TEXT NOT NULL,
        source_scope TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        priority TEXT NOT NULL, priority_reason TEXT NOT NULL, source_updated_at TEXT NOT NULL,
        source_updated_ms INTEGER, due_at TEXT, labels TEXT NOT NULL, fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL, UNIQUE (publisher_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS publisher_items (
        publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        active INTEGER NOT NULL DEFAULT 1, last_seen_run_id TEXT NOT NULL,
        PRIMARY KEY (publisher_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS publisher_runs (
        publisher_id TEXT NOT NULL REFERENCES publishers(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, item_count INTEGER NOT NULL,
        failure_message TEXT, source_completed_at TEXT, source_completed_ms INTEGER,
        request_hash TEXT, promoted INTEGER NOT NULL DEFAULT 1, completed_at TEXT NOT NULL,
        PRIMARY KEY (publisher_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS item_enrichments (
        item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        summary TEXT, priority TEXT, priority_reason TEXT, due_at TEXT, due_at_set INTEGER NOT NULL,
        labels TEXT, base_fingerprint TEXT NOT NULL, base_source_updated_at TEXT NOT NULL,
        applied_at TEXT NOT NULL, provenance TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_bindings (
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL, host_id TEXT NOT NULL, project_id TEXT,
        title TEXT NOT NULL, state TEXT NOT NULL, status_updated_at TEXT NOT NULL,
        status_updated_ms INTEGER NOT NULL, observed_at TEXT NOT NULL, observed_ms INTEGER NOT NULL,
        PRIMARY KEY (item_id, task_id, host_id)
      );
      CREATE TABLE IF NOT EXISTS view_sessions (
        token_hash BLOB PRIMARY KEY, dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_requests (
        id TEXT PRIMARY KEY, view_token_hash BLOB NOT NULL, dashboard_id TEXT,
        kind TEXT NOT NULL, item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
        item_fingerprint TEXT, dashboard_revision INTEGER, task_id TEXT, host_id TEXT,
        idempotency_key TEXT, state TEXT NOT NULL, claim_token_hash BLOB, claim_expires_at TEXT,
        result_task_id TEXT, failure_message TEXT, uncertain_effect INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY, event_kind TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    this.#migrateDevelopmentSchema();
    if (databasePath !== ":memory:") {
      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o600);
      }
    }
  }

  close(): void {
    this.#database.close();
  }

  #migrateDevelopmentSchema(): void {
    const additions: Readonly<Record<string, Readonly<Record<string, string>>>> = {
      publishers: {
        schedule_id: "TEXT",
        schedule_title: "TEXT",
        schedule_state: "TEXT NOT NULL DEFAULT 'unknown'",
        stale_after_minutes: "INTEGER NOT NULL DEFAULT 1440",
        last_run_status: "TEXT NOT NULL DEFAULT 'never'",
        last_run_at: "TEXT",
        last_run_completed_ms: "INTEGER",
        last_run_error: "TEXT",
      },
      publisher_runs: {
        source_completed_at: "TEXT",
        source_completed_ms: "INTEGER",
        request_hash: "TEXT",
        promoted: "INTEGER NOT NULL DEFAULT 1",
      },
      items: { identity_key: "TEXT", source_updated_ms: "INTEGER" },
      action_requests: {
        dashboard_id: "TEXT",
        item_fingerprint: "TEXT",
        dashboard_revision: "INTEGER",
        host_id: "TEXT",
        idempotency_key: "TEXT",
        claim_expires_at: "TEXT",
        uncertain_effect: "INTEGER NOT NULL DEFAULT 0",
      },
    };
    for (const [table, columns] of Object.entries(additions)) {
      const existing = new Set(
        (this.#database.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[]).map((row) =>
          requiredString(row, "name"),
        ),
      );
      for (const [column, definition] of Object.entries(columns)) {
        if (!existing.has(column)) {
          this.#database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
      }
    }
    this.#transaction(() => {
      const legacyRuns = this.#database
        .prepare(
          "SELECT publisher_id, run_id, completed_at FROM publisher_runs WHERE source_completed_ms IS NULL",
        )
        .all() as SqlRow[];
      const updateRun = this.#database.prepare(
        "UPDATE publisher_runs SET source_completed_at = ?, source_completed_ms = ? WHERE publisher_id = ? AND run_id = ?",
      );
      for (const row of legacyRuns) {
        const completed = normalizeTimestamp(requiredString(row, "completed_at"));
        updateRun.run(
          completed.iso,
          completed.epoch,
          requiredString(row, "publisher_id"),
          requiredString(row, "run_id"),
        );
      }
      const legacyPublishers = this.#database
        .prepare(
          "SELECT id, last_run_at FROM publishers WHERE last_run_at IS NOT NULL AND last_run_completed_ms IS NULL",
        )
        .all() as SqlRow[];
      const updatePublisher = this.#database.prepare(
        "UPDATE publishers SET last_run_completed_ms = ? WHERE id = ?",
      );
      for (const row of legacyPublishers) {
        updatePublisher.run(
          normalizeTimestamp(requiredString(row, "last_run_at")).epoch,
          requiredString(row, "id"),
        );
      }
      const rows = this.#database
        .prepare("SELECT id, publisher_id, external_id, source_ref, source_updated_at FROM items")
        .all() as SqlRow[];
      const update = this.#database.prepare(
        "UPDATE items SET identity_key = ?, source_updated_ms = ? WHERE id = ?",
      );
      const membership = this.#database.prepare(
        "INSERT OR IGNORE INTO publisher_items (publisher_id, external_id, item_id, active, last_seen_run_id) VALUES (?, ?, ?, 1, 'legacy')",
      );
      for (const row of rows) {
        update.run(
          identityKey(parseJson(requiredString(row, "source_ref"))),
          normalizeTimestamp(requiredString(row, "source_updated_at")).epoch,
          requiredString(row, "id"),
        );
        membership.run(
          requiredString(row, "publisher_id"),
          requiredString(row, "external_id"),
          requiredString(row, "id"),
        );
      }
    });
    this.#database.exec(
      "CREATE INDEX IF NOT EXISTS idx_dyna_items_identity ON items(identity_key); CREATE UNIQUE INDEX IF NOT EXISTS idx_dyna_action_idempotency ON action_requests(dashboard_id, idempotency_key) WHERE idempotency_key IS NOT NULL;",
    );
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #one(statement: StatementSync, ...values: SQLInputValue[]): SqlRow | undefined {
    return statement.get(...values);
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #nowMs(): number {
    return this.#clock().getTime();
  }

  #audit(eventKind: string, entityId: string, instant?: string): void {
    const occurredAt = instant ?? this.#now();
    this.#database
      .prepare(
        "INSERT INTO audit_events (id, event_kind, entity_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(randomUUID(), eventKind, entityId, occurredAt);
  }

  createDashboard(name: string, description: string): DynaDashboard {
    const instant = this.#now();
    const dashboard = DynaDashboardSchema.parse({
      id: randomUUID(),
      name,
      description,
      archived: false,
      createdAt: instant,
      updatedAt: instant,
    });
    this.#database
      .prepare(
        "INSERT INTO dashboards (id, name, description, archived, revision, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?)",
      )
      .run(dashboard.id, dashboard.name, dashboard.description, instant, instant);
    return dashboard;
  }

  updateDashboard(
    id: string,
    values: { readonly name?: string; readonly description?: string; readonly archived?: boolean },
  ): DynaDashboard {
    const current = this.getDashboard(id);
    const updated = DynaDashboardSchema.parse({ ...current, ...values, updatedAt: this.#now() });
    this.#database
      .prepare(
        "UPDATE dashboards SET name = ?, description = ?, archived = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
      )
      .run(updated.name, updated.description, updated.archived ? 1 : 0, updated.updatedAt, id);
    return updated;
  }

  listDashboards(): DynaDashboard[] {
    return (
      this.#database
        .prepare(
          "SELECT id, name, description, archived, created_at, updated_at FROM dashboards ORDER BY archived, updated_at DESC",
        )
        .all() as SqlRow[]
    ).map((row) => this.#dashboardFromRow(row));
  }

  getDashboard(id: string): DynaDashboard {
    const row = this.#one(
      this.#database.prepare(
        "SELECT id, name, description, archived, created_at, updated_at FROM dashboards WHERE id = ?",
      ),
      id,
    );
    if (!row) throw new Error("Dyna dashboard was not found.");
    return this.#dashboardFromRow(row);
  }

  #dashboardFromRow(row: SqlRow): DynaDashboard {
    return DynaDashboardSchema.parse({
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      archived: requiredNumber(row, "archived") === 1,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    });
  }

  createPublisher(
    name: string,
    schedule?: {
      readonly id: string;
      readonly title: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes?: number;
    },
  ): { readonly publisher: DynaPublisher; readonly secret: string } {
    const secret = token();
    const publisher = DynaPublisherSchema.parse({
      id: randomUUID(),
      name,
      ...(schedule ? { scheduleId: schedule.id, scheduleTitle: schedule.title } : {}),
      scheduleState: schedule?.state ?? "unknown",
      staleAfterMinutes: schedule?.staleAfterMinutes ?? 1_440,
      lastRunStatus: "never",
      createdAt: this.#now(),
    });
    this.#database
      .prepare(
        `
        INSERT INTO publishers (
          id, name, token_hash, schedule_id, schedule_title, schedule_state,
          stale_after_minutes, last_run_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'never', ?)
      `,
      )
      .run(
        publisher.id,
        publisher.name,
        tokenHash(secret),
        publisher.scheduleId ?? null,
        publisher.scheduleTitle ?? null,
        publisher.scheduleState,
        publisher.staleAfterMinutes,
        publisher.createdAt,
      );
    return { publisher, secret };
  }

  bindSchedule(
    dashboardId: string,
    publisherId: string,
    schedule: {
      readonly id: string;
      readonly title: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes: number;
    },
  ): void {
    this.getDashboard(dashboardId);
    const instant = this.#now();
    this.#transaction(() => {
      const updated = this.#database
        .prepare(
          `UPDATE publishers SET schedule_id = ?, schedule_title = ?, schedule_state = ?, stale_after_minutes = ?
           WHERE id = ? AND (
             COALESCE(schedule_id, '') != ? OR COALESCE(schedule_title, '') != ? OR
             schedule_state != ? OR stale_after_minutes != ?
           )`,
        )
        .run(
          schedule.id,
          schedule.title,
          schedule.state,
          schedule.staleAfterMinutes,
          publisherId,
          schedule.id,
          schedule.title,
          schedule.state,
          schedule.staleAfterMinutes,
        ).changes;
      const publisher = this.#one(
        this.#database.prepare("SELECT 1 AS present FROM publishers WHERE id = ?"),
        publisherId,
      );
      if (!publisher) throw new Error("Dyna publisher was not found.");
      const bound = this.#database
        .prepare(
          "INSERT OR IGNORE INTO dashboard_publishers (dashboard_id, publisher_id) VALUES (?, ?)",
        )
        .run(dashboardId, publisherId).changes;
      if (updated === 1) this.#touchDashboardsForPublisher(publisherId, instant);
      else if (bound === 1) this.#touchDashboards([dashboardId], instant);
      this.#audit("schedule.bound", publisherId, instant);
    });
  }

  updateScheduleStatus(
    publisherId: string,
    schedule: {
      readonly title?: string;
      readonly state: "active" | "paused" | "unknown";
      readonly staleAfterMinutes?: number;
    },
  ): void {
    this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare(
          "SELECT schedule_title, schedule_state, stale_after_minutes FROM publishers WHERE id = ?",
        ),
        publisherId,
      );
      if (!row) throw new Error("Dyna publisher was not found.");
      const title = schedule.title ?? optionalString(row, "schedule_title");
      const staleAfterMinutes =
        schedule.staleAfterMinutes ?? requiredNumber(row, "stale_after_minutes");
      const changed = this.#database
        .prepare(
          "UPDATE publishers SET schedule_title = ?, schedule_state = ?, stale_after_minutes = ? WHERE id = ? AND (COALESCE(schedule_title, '') != COALESCE(?, '') OR schedule_state != ? OR stale_after_minutes != ?)",
        )
        .run(
          title ?? null,
          schedule.state,
          staleAfterMinutes,
          publisherId,
          title ?? null,
          schedule.state,
          staleAfterMinutes,
        ).changes;
      if (changed === 1) this.#touchDashboardsForPublisher(publisherId);
    });
  }

  listPublishers(dashboardId?: string): DynaPublisher[] {
    const rows = dashboardId
      ? (this.#database
          .prepare(
            `
            SELECT p.* FROM publishers p
            JOIN dashboard_publishers dp ON dp.publisher_id = p.id
            WHERE dp.dashboard_id = ? ORDER BY p.name, p.id
          `,
          )
          .all(dashboardId) as SqlRow[])
      : (this.#database.prepare("SELECT * FROM publishers ORDER BY name, id").all() as SqlRow[]);
    return rows.map((row) => this.#publisherFromRow(row));
  }

  #publisherFromRow(row: SqlRow): DynaPublisher {
    return DynaPublisherSchema.parse({
      id: requiredString(row, "id"),
      name: requiredString(row, "name"),
      ...(optionalString(row, "schedule_id")
        ? { scheduleId: optionalString(row, "schedule_id") }
        : {}),
      ...(optionalString(row, "schedule_title")
        ? { scheduleTitle: optionalString(row, "schedule_title") }
        : {}),
      scheduleState: requiredString(row, "schedule_state"),
      staleAfterMinutes: requiredNumber(row, "stale_after_minutes"),
      lastRunStatus: requiredString(row, "last_run_status"),
      ...(optionalString(row, "last_run_at")
        ? { lastRunAt: optionalString(row, "last_run_at") }
        : {}),
      ...(optionalString(row, "last_run_error")
        ? { lastRunError: optionalString(row, "last_run_error") }
        : {}),
      createdAt: requiredString(row, "created_at"),
    });
  }

  publish(
    publisherId: string,
    secret: string,
    items: readonly DynaPublishedItem[],
    options: DynaPublishOptions,
  ): DynaPublishResult {
    const publisher = this.#one(
      this.#database.prepare("SELECT token_hash FROM publishers WHERE id = ?"),
      publisherId,
    );
    if (!publisher || !hashesMatch(secret, publisher["token_hash"])) {
      throw new Error("Dyna publisher credentials are invalid.");
    }
    if (options.status === "failed" && (items.length > 0 || !options.failureMessage)) {
      throw new Error("A failed Dyna run requires an error and cannot publish a partial snapshot.");
    }
    if (options.status === "succeeded" && options.failureMessage) {
      throw new Error("A successful Dyna run cannot include an error.");
    }
    const parsedItems = items.map(normalizedPublishedItem);
    const sourceCompletion = normalizeTimestamp(options.sourceCompletedAt, true);
    const requestHash = sha256(
      JSON.stringify({
        runId: options.runId,
        sourceCompletedAt: sourceCompletion.iso,
        mode: options.mode,
        status: options.status,
        failureMessage: options.failureMessage ?? null,
        items: parsedItems,
      }),
    );
    const instant = this.#now();
    return this.#transaction(() => {
      const previous = this.#one(
        this.#database.prepare(
          "SELECT status, item_count, promoted, request_hash FROM publisher_runs WHERE publisher_id = ? AND run_id = ?",
        ),
        publisherId,
        options.runId,
      );
      if (previous) {
        if (optionalString(previous, "request_hash") !== requestHash) {
          throw new Error("Dyna rejected a run ID reused with different publication data.");
        }
        return {
          accepted: requiredNumber(previous, "item_count"),
          deduplicated: true,
          superseded: requiredNumber(previous, "promoted") !== 1,
          status: requiredString(previous, "status") as "succeeded" | "failed",
        };
      }

      const currentPublisher = this.#one(
        this.#database.prepare("SELECT last_run_completed_ms FROM publishers WHERE id = ?"),
        publisherId,
      );
      if (!currentPublisher) throw new Error("Dyna publisher was not found.");
      const lastCompletion = currentPublisher["last_run_completed_ms"];
      if (typeof lastCompletion === "number" && sourceCompletion.epoch <= lastCompletion) {
        this.#database
          .prepare(
            `
            INSERT INTO publisher_runs (
              publisher_id, run_id, mode, status, item_count, failure_message,
              source_completed_at, source_completed_ms, request_hash, promoted, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          `,
          )
          .run(
            publisherId,
            options.runId,
            options.mode,
            options.status,
            parsedItems.length,
            options.failureMessage ?? null,
            sourceCompletion.iso,
            sourceCompletion.epoch,
            requestHash,
            instant,
          );
        this.#audit("publisher.run.superseded", publisherId, instant);
        return {
          accepted: parsedItems.length,
          deduplicated: false,
          superseded: true,
          status: options.status,
        };
      }

      const affectedDashboards = new Set(
        (
          this.#database
            .prepare("SELECT dashboard_id FROM dashboard_publishers WHERE publisher_id = ?")
            .all(publisherId) as SqlRow[]
        ).map((row) => requiredString(row, "dashboard_id")),
      );
      if (options.status === "succeeded") {
        if (options.mode === "replace") {
          this.#database
            .prepare("UPDATE publisher_items SET active = 0 WHERE publisher_id = ?")
            .run(publisherId);
        }
        const insertItem = this.#database.prepare(`
          INSERT INTO items (
            id, publisher_id, external_id, identity_key, source, source_ref, source_scope, title,
            summary, priority, priority_reason, source_updated_at, source_updated_ms, due_at,
            labels, fingerprint, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const updateItem = this.#database.prepare(`
          UPDATE items SET source = ?, source_ref = ?, source_scope = ?, title = ?, summary = ?,
            priority = ?, priority_reason = ?, source_updated_at = ?, source_updated_ms = ?,
            due_at = ?, labels = ?, fingerprint = ?, updated_at = ? WHERE id = ?
        `);
        const upsertMembership = this.#database.prepare(`
          INSERT INTO publisher_items (publisher_id, external_id, item_id, active, last_seen_run_id)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(publisher_id, external_id) DO UPDATE SET
            item_id = excluded.item_id, active = 1, last_seen_run_id = excluded.last_seen_run_id
        `);
        for (const item of parsedItems) {
          const canonical = JSON.stringify(item);
          const fingerprint = sha256(canonical);
          const identity = identityKey(item.sourceRef);
          const sourceMs = normalizeTimestamp(item.sourceUpdatedAt).epoch;
          let existing = this.#one(
            this.#database.prepare(
              "SELECT * FROM items WHERE identity_key = ? ORDER BY source_updated_ms DESC LIMIT 1",
            ),
            identity,
          );
          if (!existing) {
            const id = randomUUID();
            insertItem.run(
              id,
              publisherId,
              item.externalId,
              identity,
              item.sourceRef.source,
              JSON.stringify(item.sourceRef),
              item.sourceScope,
              item.title,
              item.summary,
              item.priority,
              item.priorityReason,
              item.sourceUpdatedAt,
              sourceMs,
              item.dueAt ?? null,
              JSON.stringify(item.labels),
              fingerprint,
              instant,
            );
            existing = this.#one(this.#database.prepare("SELECT * FROM items WHERE id = ?"), id);
          } else {
            const existingMs = requiredNumber(existing, "source_updated_ms");
            const existingFingerprint = requiredString(existing, "fingerprint");
            if (sourceMs === existingMs && fingerprint !== existingFingerprint) {
              throw new Error(
                "Dyna rejected conflicting source data with the same update timestamp.",
              );
            }
            if (sourceMs > existingMs) {
              updateItem.run(
                item.sourceRef.source,
                JSON.stringify(item.sourceRef),
                item.sourceScope,
                item.title,
                item.summary,
                item.priority,
                item.priorityReason,
                item.sourceUpdatedAt,
                sourceMs,
                item.dueAt ?? null,
                JSON.stringify(item.labels),
                fingerprint,
                instant,
                requiredString(existing, "id"),
              );
            }
          }
          if (!existing) throw new Error("Dyna could not persist a source item.");
          const itemId = requiredString(existing, "id");
          upsertMembership.run(publisherId, item.externalId, itemId, options.runId);
          for (const row of this.#database
            .prepare(
              `
              SELECT DISTINCT dp.dashboard_id FROM dashboard_publishers dp
              JOIN publisher_items pi ON pi.publisher_id = dp.publisher_id
              WHERE pi.item_id = ? AND pi.active = 1
            `,
            )
            .all(itemId) as SqlRow[]) {
            affectedDashboards.add(requiredString(row, "dashboard_id"));
          }
        }
      }

      this.#database
        .prepare(
          `
          INSERT INTO publisher_runs (
            publisher_id, run_id, mode, status, item_count, failure_message,
            source_completed_at, source_completed_ms, request_hash, promoted, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `,
        )
        .run(
          publisherId,
          options.runId,
          options.mode,
          options.status,
          parsedItems.length,
          options.failureMessage ?? null,
          sourceCompletion.iso,
          sourceCompletion.epoch,
          requestHash,
          instant,
        );
      this.#database
        .prepare(
          "UPDATE publishers SET last_run_status = ?, last_run_at = ?, last_run_completed_ms = ?, last_run_error = ? WHERE id = ?",
        )
        .run(
          options.status,
          sourceCompletion.iso,
          sourceCompletion.epoch,
          options.failureMessage ?? null,
          publisherId,
        );
      this.#touchDashboards(affectedDashboards, instant);
      this.#audit(`publisher.run.${options.status}`, publisherId, instant);
      return {
        accepted: parsedItems.length,
        deduplicated: false,
        superseded: false,
        status: options.status,
      };
    });
  }

  addAnnotation(
    viewToken: string,
    itemId: string,
    body: string,
  ): z.infer<typeof DynaAnnotationSchema> {
    this.authorizeView(viewToken, itemId);
    const annotation = DynaAnnotationSchema.parse({
      id: randomUUID(),
      itemId,
      body,
      createdAt: this.#now(),
    });
    return this.#transaction(() => {
      this.#database
        .prepare("INSERT INTO annotations (id, item_id, body, created_at) VALUES (?, ?, ?, ?)")
        .run(annotation.id, annotation.itemId, annotation.body, annotation.createdAt);
      this.#touchDashboardsForItem(itemId);
      this.#audit("annotation.created", itemId);
      return annotation;
    });
  }

  applyEnrichment(
    itemId: string,
    values: {
      readonly summary?: string;
      readonly priority?: string;
      readonly priorityReason?: string;
      readonly dueAt?: string | null;
      readonly labels?: readonly string[];
      readonly provenance: string;
    },
  ): void {
    const base = this.#itemBaseRow(itemId);
    const current = this.#one(
      this.#database.prepare("SELECT * FROM item_enrichments WHERE item_id = ?"),
      itemId,
    );
    const dueAt =
      values.dueAt === undefined
        ? optionalString(current ?? {}, "due_at")
        : values.dueAt === null
          ? undefined
          : normalizeTimestamp(values.dueAt).iso;
    const dueAtSet =
      values.dueAt !== undefined ? 1 : current ? requiredNumber(current, "due_at_set") : 0;
    const instant = this.#now();
    this.#transaction(() => {
      this.#database
        .prepare(
          `
          INSERT INTO item_enrichments (
            item_id, summary, priority, priority_reason, due_at, due_at_set, labels,
            base_fingerprint, base_source_updated_at, applied_at, provenance
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET summary = excluded.summary,
            priority = excluded.priority, priority_reason = excluded.priority_reason,
            due_at = excluded.due_at, due_at_set = excluded.due_at_set, labels = excluded.labels,
            base_fingerprint = excluded.base_fingerprint,
            base_source_updated_at = excluded.base_source_updated_at,
            applied_at = excluded.applied_at, provenance = excluded.provenance
        `,
        )
        .run(
          itemId,
          values.summary ?? optionalString(current ?? {}, "summary") ?? null,
          values.priority ?? optionalString(current ?? {}, "priority") ?? null,
          values.priorityReason ?? optionalString(current ?? {}, "priority_reason") ?? null,
          dueAt ?? null,
          dueAtSet,
          values.labels !== undefined
            ? JSON.stringify(values.labels)
            : (optionalString(current ?? {}, "labels") ?? null),
          requiredString(base, "fingerprint"),
          requiredString(base, "source_updated_at"),
          instant,
          values.provenance,
        );
      this.#touchDashboardsForItem(itemId, instant);
      this.#audit("item.enriched", itemId, instant);
    });
  }

  createView(dashboardId: string): string {
    this.getDashboard(dashboardId);
    const value = token();
    this.#database.prepare("DELETE FROM view_sessions WHERE expires_at <= ?").run(this.#now());
    this.#database
      .prepare("INSERT INTO view_sessions (token_hash, dashboard_id, expires_at) VALUES (?, ?, ?)")
      .run(tokenHash(value), dashboardId, new Date(this.#nowMs() + VIEW_TTL_MS).toISOString());
    return value;
  }

  authorizeView(viewToken: string, itemId?: string): string {
    const hash = tokenHash(viewToken);
    const row = this.#one(
      this.#database.prepare(
        "SELECT dashboard_id, expires_at FROM view_sessions WHERE token_hash = ?",
      ),
      hash,
    );
    const instant = this.#now();
    if (!row || requiredString(row, "expires_at") <= instant) {
      throw new Error("The Dyna view session has expired; reopen the dashboard.");
    }
    const dashboardId = requiredString(row, "dashboard_id");
    if (itemId) {
      const membership = this.#one(
        this.#database.prepare(`
          SELECT 1 AS present FROM publisher_items pi
          JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
          WHERE dp.dashboard_id = ? AND pi.item_id = ? AND pi.active = 1
        `),
        dashboardId,
        itemId,
      );
      if (!membership) throw new Error("The Dyna item is outside this dashboard view.");
    }
    this.#database
      .prepare("UPDATE view_sessions SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(this.#nowMs() + VIEW_TTL_MS).toISOString(), hash);
    return dashboardId;
  }

  snapshot(dashboardId: string): DynaDashboardSnapshot {
    return this.#readTransaction(() => {
      const dashboard = this.getDashboard(dashboardId);
      const revisionRow = this.#one(
        this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
        dashboardId,
      );
      const eligibleCte = `
        WITH eligible AS (
          SELECT DISTINCT i.*,
            e.summary AS enrichment_summary,
            e.priority AS enrichment_priority,
            e.priority_reason AS enrichment_priority_reason,
            e.due_at AS enrichment_due_at,
            e.due_at_set AS enrichment_due_at_set,
            e.labels AS enrichment_labels,
            e.base_fingerprint AS enrichment_base_fingerprint,
            e.base_source_updated_at AS enrichment_base_source_updated_at,
            e.applied_at AS enrichment_applied_at,
            e.provenance AS enrichment_provenance
          FROM items i
          JOIN publisher_items pi ON pi.item_id = i.id AND pi.active = 1
          JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
          LEFT JOIN item_enrichments e ON e.item_id = i.id
          WHERE dp.dashboard_id = ?
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY identity_key ORDER BY source_updated_ms DESC, updated_at DESC, id
          ) AS identity_rank
          FROM eligible
        )
      `;
      const countRow = this.#one(
        this.#database.prepare(`${eligibleCte}
          SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN COALESCE(enrichment_priority, priority) = 'critical' THEN 1 ELSE 0 END), 0) AS critical,
            COALESCE(SUM(CASE WHEN COALESCE(enrichment_priority, priority) = 'high' THEN 1 ELSE 0 END), 0) AS high,
            MAX(source_updated_at) AS newest
          FROM ranked WHERE identity_rank = 1`),
        dashboardId,
      );
      if (!countRow) throw new Error("Dyna could not count dashboard items.");
      const rows = this.#database
        .prepare(
          `${eligibleCte}
          SELECT * FROM ranked WHERE identity_rank = 1
          ORDER BY
            CASE COALESCE(enrichment_priority, priority)
              WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            CASE WHEN enrichment_due_at_set = 1
              THEN COALESCE(enrichment_due_at, '9999') ELSE COALESCE(due_at, '9999') END,
            source_updated_ms DESC, id
          LIMIT 200`,
        )
        .all(dashboardId) as SqlRow[];
      const cards = this.#cardsFromSnapshotRows(rows);
      const newest = optionalString(countRow, "newest");
      const schedules = this.listPublishers(dashboardId);
      const activeSchedules = schedules.filter((schedule) => schedule.scheduleState === "active");
      const scheduleFreshness = activeSchedules.map((schedule) => {
        if (schedule.lastRunStatus === "failed" || !schedule.lastRunAt) return "stale" as const;
        const age = Math.max(0, this.#nowMs() - Date.parse(schedule.lastRunAt));
        const staleAfter = schedule.staleAfterMinutes * 60_000;
        return age > staleAfter
          ? ("stale" as const)
          : age > staleAfter * 0.75
            ? ("aging" as const)
            : ("fresh" as const);
      });
      const unscheduledAge = newest
        ? Math.max(0, this.#nowMs() - Date.parse(newest))
        : Number.POSITIVE_INFINITY;
      const freshness = scheduleFreshness.includes("stale")
        ? "stale"
        : scheduleFreshness.includes("aging")
          ? "aging"
          : scheduleFreshness.length > 0
            ? "fresh"
            : unscheduledAge <= 15 * 60_000
              ? "fresh"
              : unscheduledAge <= 60 * 60_000
                ? "aging"
                : "stale";
      return DynaDashboardSnapshotSchema.parse({
        schema: "dyna/snapshot-v1",
        dashboard,
        generatedAt: this.#now(),
        revision: revisionRow ? requiredNumber(revisionRow, "revision") : 0,
        freshness,
        counts: {
          critical: requiredNumber(countRow, "critical"),
          high: requiredNumber(countRow, "high"),
          total: requiredNumber(countRow, "total"),
        },
        schedules,
        cards,
      });
    });
  }

  snapshotForView(viewToken: string): DynaDashboardSnapshot {
    return this.snapshot(this.authorizeView(viewToken));
  }

  itemContext(itemId: string): DynaItemContext {
    return DynaItemContextSchema.parse({
      ...this.#item(itemId),
      annotations: this.#annotations(itemId),
    });
  }

  prepareAction(
    viewToken: string,
    kind: DynaActionKind,
    values: {
      readonly itemId: string;
      readonly taskId?: string;
      readonly taskHostId?: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly idempotencyKey: string;
    },
  ): z.infer<typeof DynaActionRequestSchema> {
    DynaActionKindSchema.parse(kind);
    const dashboardId = this.authorizeView(viewToken, values.itemId);
    const revisionRow = this.#one(
      this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
      dashboardId,
    );
    if (!revisionRow || requiredNumber(revisionRow, "revision") !== values.expectedRevision) {
      throw new Error("The Dyna dashboard changed; refresh before taking action.");
    }
    const item = this.#itemBaseRow(values.itemId);
    if (requiredString(item, "fingerprint") !== values.expectedFingerprint) {
      throw new Error("The Dyna item changed; refresh before taking action.");
    }
    if (kind !== "create_codex_task") {
      if (!values.taskId || !values.taskHostId) {
        throw new Error("This Dyna action requires a linked Codex task and host.");
      }
      const linked = this.#one(
        this.#database.prepare(
          "SELECT 1 AS present FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
        ),
        values.itemId,
        values.taskId,
        values.taskHostId,
      );
      if (!linked) throw new Error("The Codex task is not linked to this Dyna item.");
    } else if (values.taskId || values.taskHostId) {
      throw new Error("A new Codex task action cannot target an existing task.");
    }

    if (kind === "create_codex_task") {
      const hasUncertainCreation = this.#transaction(() => {
        const instant = this.#now();
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'needs_reconciliation', uncertain_effect = 1,
               failure_message = ?, claim_token_hash = NULL, claim_expires_at = NULL,
               updated_at = ?
             WHERE item_id = ? AND kind = 'create_codex_task' AND state = 'claimed'
               AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`,
          )
          .run(
            "The controller claim expired after task creation may have started.",
            instant,
            values.itemId,
            instant,
          );
        return Boolean(
          this.#one(
            this.#database.prepare(
              `SELECT 1 AS present FROM action_requests
               WHERE item_id = ? AND kind = 'create_codex_task'
                 AND state = 'needs_reconciliation' AND uncertain_effect = 1
               LIMIT 1`,
            ),
            values.itemId,
          ),
        );
      });
      if (hasUncertainCreation) {
        throw new Error(
          "A prior Codex task creation needs explicit reconciliation before another can start.",
        );
      }
    }

    const existing = this.#one(
      this.#database.prepare(
        "SELECT * FROM action_requests WHERE dashboard_id = ? AND idempotency_key = ?",
      ),
      dashboardId,
      values.idempotencyKey,
    );
    if (existing) {
      if (
        requiredString(existing, "kind") !== kind ||
        requiredString(existing, "item_id") !== values.itemId ||
        optionalString(existing, "task_id") !== values.taskId ||
        optionalString(existing, "host_id") !== values.taskHostId ||
        requiredNumber(existing, "dashboard_revision") !== values.expectedRevision ||
        requiredString(existing, "item_fingerprint") !== values.expectedFingerprint
      ) {
        throw new Error("The Dyna idempotency key was already used for another action.");
      }
      return this.#actionFromRow(existing);
    }

    const unresolved = this.#one(
      this.#database.prepare(
        `
        SELECT * FROM action_requests
        WHERE dashboard_id = ? AND item_id = ? AND kind = ?
          AND dashboard_revision = ? AND item_fingerprint = ?
          AND COALESCE(task_id, '') = COALESCE(?, '')
          AND COALESCE(host_id, '') = COALESCE(?, '')
          AND expires_at > ?
          AND (
            state IN ('prepared', 'delivered') OR
            (state = 'claimed' AND claim_expires_at > ?)
          )
        ORDER BY created_at DESC LIMIT 1
      `,
      ),
      dashboardId,
      values.itemId,
      kind,
      values.expectedRevision,
      values.expectedFingerprint,
      values.taskId ?? null,
      values.taskHostId ?? null,
      this.#now(),
      this.#now(),
    );
    if (unresolved) return this.#actionFromRow(unresolved);

    const instant = this.#now();
    const request = DynaActionRequestSchema.parse({
      id: randomUUID(),
      kind,
      itemId: values.itemId,
      ...(values.taskId ? { taskId: values.taskId } : {}),
      ...(values.taskHostId ? { taskHostId: values.taskHostId } : {}),
      dashboardRevision: values.expectedRevision,
      itemFingerprint: values.expectedFingerprint,
      state: "prepared",
      expiresAt: new Date(this.#nowMs() + ACTION_TTL_MS).toISOString(),
      createdAt: instant,
      updatedAt: instant,
    });
    this.#database
      .prepare(
        `
        INSERT INTO action_requests (
          id, view_token_hash, dashboard_id, kind, item_id, item_fingerprint,
          dashboard_revision, task_id, host_id, idempotency_key, state,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        request.id,
        tokenHash(viewToken),
        dashboardId,
        request.kind,
        request.itemId ?? null,
        request.itemFingerprint,
        request.dashboardRevision,
        request.taskId ?? null,
        request.taskHostId ?? null,
        values.idempotencyKey,
        request.state,
        request.expiresAt,
        request.createdAt,
        request.updatedAt,
      );
    return request;
  }

  markDelivered(viewToken: string, requestId: string): z.infer<typeof DynaActionRequestSchema> {
    this.authorizeView(viewToken);
    const hash = tokenHash(viewToken);
    const instant = this.#now();
    const row = this.#one(
      this.#database.prepare("SELECT * FROM action_requests WHERE id = ? AND view_token_hash = ?"),
      requestId,
      hash,
    );
    if (!row) throw new Error("The Dyna action request cannot be delivered.");
    if (requiredString(row, "expires_at") <= instant) {
      return this.actionStatusForView(viewToken, requestId);
    }
    if (requiredString(row, "state") === "prepared") {
      this.#database
        .prepare("UPDATE action_requests SET state = 'delivered', updated_at = ? WHERE id = ?")
        .run(instant, requestId);
    }
    const request = this.actionStatusForView(viewToken, requestId);
    if (
      !["delivered", "claimed", "succeeded", "failed", "needs_reconciliation"].includes(
        request.state,
      )
    ) {
      throw new Error("The Dyna action request cannot be delivered.");
    }
    return request;
  }

  actionStatusForView(
    viewToken: string,
    requestId: string,
  ): z.infer<typeof DynaActionRequestSchema> {
    this.authorizeView(viewToken);
    let row = this.#one(
      this.#database.prepare("SELECT * FROM action_requests WHERE id = ? AND view_token_hash = ?"),
      requestId,
      tokenHash(viewToken),
    );
    if (!row) throw new Error("Dyna action request was not found in this view.");
    const instant = this.#now();
    const state = requiredString(row, "state");
    const requestExpired = requiredString(row, "expires_at") <= instant;
    const claimExpired =
      state === "claimed" &&
      (!optionalString(row, "claim_expires_at") ||
        requiredString(row, "claim_expires_at") <= instant);
    if ((requestExpired && ["prepared", "delivered"].includes(state)) || claimExpired) {
      const failureMessage = claimExpired
        ? "The controller claim expired before completion."
        : "The action expired before the controller confirmed delivery.";
      this.#database
        .prepare(
          `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
             uncertain_effect = ?,
             claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
           WHERE id = ? AND state = ?`,
        )
        .run(failureMessage, claimExpired ? 1 : 0, instant, requestId, state);
      row = this.#one(
        this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
        requestId,
      );
      if (!row) throw new Error("Dyna action request was not found in this view.");
    }
    return this.#actionFromRow(row);
  }

  claimAction(requestId: string): ClaimedDynaAction {
    const claimToken = token();
    const result = this.#transaction<ClaimedDynaAction | { readonly error: string }>(() => {
      const instant = this.#now();
      const requestRow = this.#one(
        this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
        requestId,
      );
      if (!requestRow) throw new Error("The Dyna action request was not found.");
      const requestExpiry = Date.parse(requiredString(requestRow, "expires_at"));
      const dashboardId = optionalString(requestRow, "dashboard_id");
      const itemId = optionalString(requestRow, "item_id");
      const dashboard = dashboardId
        ? this.#one(
            this.#database.prepare("SELECT revision FROM dashboards WHERE id = ?"),
            dashboardId,
          )
        : undefined;
      const item = itemId
        ? this.#one(this.#database.prepare("SELECT fingerprint FROM items WHERE id = ?"), itemId)
        : undefined;
      const membership =
        dashboardId && itemId
          ? this.#one(
              this.#database.prepare(
                `SELECT 1 AS present FROM publisher_items pi
                 JOIN dashboard_publishers dp ON dp.publisher_id = pi.publisher_id
                 WHERE dp.dashboard_id = ? AND pi.item_id = ? AND pi.active = 1`,
              ),
              dashboardId,
              itemId,
            )
          : undefined;
      if (
        !dashboard ||
        !item ||
        !membership ||
        requiredNumber(dashboard, "revision") !==
          requiredNumber(requestRow, "dashboard_revision") ||
        requiredString(item, "fingerprint") !== requiredString(requestRow, "item_fingerprint")
      ) {
        this.#database
          .prepare(
            `UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
               uncertain_effect = 0,
               claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
             WHERE id = ? AND state = 'delivered'`,
          )
          .run(
            "The dashboard or item changed before the controller claimed the action.",
            instant,
            requestId,
          );
        return { error: "The Dyna action preconditions changed before it could be claimed." };
      }
      const claimExpiresAt = new Date(
        Math.min(this.#nowMs() + CLAIM_LEASE_MS, requestExpiry),
      ).toISOString();
      const changed = this.#database
        .prepare(
          `
          UPDATE action_requests SET state = 'claimed', claim_token_hash = ?,
            claim_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'delivered' AND expires_at > ?
        `,
        )
        .run(tokenHash(claimToken), claimExpiresAt, instant, requestId, instant).changes;
      if (changed !== 1) {
        throw new Error("The Dyna action request is unavailable, expired, or already claimed.");
      }
      const request = this.actionStatus(requestId);
      return {
        request,
        claimToken,
        context: {
          ...(request.itemId ? { item: this.#actionItemContext(request.itemId) } : {}),
          ...(request.taskId && request.taskHostId && request.itemId
            ? { task: this.#task(request.itemId, request.taskId, request.taskHostId) }
            : {}),
        },
      };
    });
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  completeAction(
    requestId: string,
    claimToken: string,
    result:
      | { readonly outcome: "succeeded"; readonly task?: DynaTaskStatus }
      | {
          readonly outcome: "failed" | "needs_reconciliation";
          readonly failureMessage: string;
        },
  ): z.infer<typeof DynaActionRequestSchema> {
    return this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare("SELECT * FROM action_requests WHERE id = ? AND state = 'claimed'"),
        requestId,
      );
      if (!row || !hashesMatch(claimToken, row["claim_token_hash"])) {
        throw new Error("The Dyna action completion capability is invalid.");
      }
      const instant = this.#now();
      const claimExpiry = optionalString(row, "claim_expires_at");
      if (!claimExpiry || claimExpiry <= instant || requiredString(row, "expires_at") <= instant) {
        this.#database
          .prepare(
            `
            UPDATE action_requests SET state = 'needs_reconciliation', failure_message = ?,
              uncertain_effect = 1,
              claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ? WHERE id = ?
          `,
          )
          .run("The controller claim expired before completion.", instant, requestId);
        return this.actionStatus(requestId);
      }

      const kind = requiredString(row, "kind");
      if (result.outcome === "succeeded") {
        if ((kind === "create_codex_task" || kind === "refresh_codex_status") && !result.task) {
          throw new Error("The successful Dyna action requires controller-reported task metadata.");
        }
        if (kind === "open_codex_task" && result.task) {
          throw new Error("Opening a Codex task cannot attach task metadata.");
        }
        if (
          kind === "refresh_codex_status" &&
          result.task &&
          (result.task.taskId !== optionalString(row, "task_id") ||
            result.task.hostId !== optionalString(row, "host_id"))
        ) {
          throw new Error("The refreshed Codex task does not match the claimed request.");
        }
        if (result.task) {
          const itemId = optionalString(row, "item_id");
          if (!itemId) throw new Error("The Dyna action has no item to link.");
          this.#upsertTaskStatus(itemId, result.task);
        }
      }
      this.#database
        .prepare(
          `
          UPDATE action_requests SET state = ?, result_task_id = ?, failure_message = ?,
            uncertain_effect = ?,
            claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'claimed'
        `,
        )
        .run(
          result.outcome,
          result.outcome === "succeeded" ? (result.task?.taskId ?? null) : null,
          result.outcome === "succeeded" ? null : result.failureMessage,
          result.outcome === "needs_reconciliation" ? 1 : 0,
          instant,
          requestId,
        );
      this.#audit(`action.${result.outcome}`, requestId, instant);
      return this.actionStatus(requestId);
    });
  }

  resolveActionReconciliation(
    requestId: string,
    resolution:
      | { readonly outcome: "task_linked"; readonly task: DynaTaskStatus }
      | { readonly outcome: "no_task_created"; readonly explanation: string },
  ): z.infer<typeof DynaActionRequestSchema> {
    return this.#transaction(() => {
      const row = this.#one(
        this.#database.prepare(
          `SELECT * FROM action_requests WHERE id = ? AND kind = 'create_codex_task'
             AND state = 'needs_reconciliation' AND uncertain_effect = 1`,
        ),
        requestId,
      );
      if (!row) throw new Error("The Dyna task creation is not awaiting reconciliation.");
      const itemId = optionalString(row, "item_id");
      if (!itemId) throw new Error("The Dyna action has no item to reconcile.");
      const instant = this.#now();
      if (resolution.outcome === "task_linked") {
        this.#upsertTaskStatus(itemId, resolution.task);
      }
      this.#database
        .prepare(
          `UPDATE action_requests SET state = ?, result_task_id = ?, failure_message = ?,
             uncertain_effect = 0, updated_at = ? WHERE id = ?`,
        )
        .run(
          resolution.outcome === "task_linked" ? "succeeded" : "failed",
          resolution.outcome === "task_linked" ? resolution.task.taskId : null,
          resolution.outcome === "task_linked" ? null : resolution.explanation,
          instant,
          requestId,
        );
      this.#audit(`action.reconciled.${resolution.outcome}`, requestId, instant);
      return this.actionStatus(requestId);
    });
  }

  actionStatus(requestId: string): z.infer<typeof DynaActionRequestSchema> {
    const row = this.#one(
      this.#database.prepare("SELECT * FROM action_requests WHERE id = ?"),
      requestId,
    );
    if (!row) throw new Error("Dyna action request was not found.");
    return this.#actionFromRow(row);
  }

  #actionFromRow(row: SqlRow): z.infer<typeof DynaActionRequestSchema> {
    return DynaActionRequestSchema.parse({
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind"),
      ...(optionalString(row, "item_id") ? { itemId: optionalString(row, "item_id") } : {}),
      ...(optionalString(row, "task_id") ? { taskId: optionalString(row, "task_id") } : {}),
      ...(optionalString(row, "host_id") ? { taskHostId: optionalString(row, "host_id") } : {}),
      dashboardRevision: requiredNumber(row, "dashboard_revision"),
      itemFingerprint: requiredString(row, "item_fingerprint"),
      state: requiredString(row, "state"),
      expiresAt: requiredString(row, "expires_at"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at"),
    });
  }

  upsertTaskStatus(itemId: string, status: DynaTaskStatus): void {
    this.#transaction(() => {
      this.#upsertTaskStatus(itemId, status);
    });
  }

  #upsertTaskStatus(itemId: string, status: DynaTaskStatus): void {
    const parsed = DynaTaskStatusSchema.parse(status);
    this.#itemBaseRow(itemId);
    const statusTime = normalizeTimestamp(parsed.statusUpdatedAt, true);
    const observedTime = normalizeTimestamp(parsed.observedAt, true);
    const existing = this.#one(
      this.#database.prepare(
        "SELECT title, state, status_updated_ms, observed_ms FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
      ),
      itemId,
      parsed.taskId,
      parsed.hostId,
    );
    if (
      existing &&
      observedTime.epoch > requiredNumber(existing, "observed_ms") &&
      statusTime.epoch === requiredNumber(existing, "status_updated_ms") &&
      (parsed.state !== requiredString(existing, "state") ||
        parsed.title !== requiredString(existing, "title"))
    ) {
      throw new Error("Dyna rejected conflicting Codex task data at the same status timestamp.");
    }
    const changed = this.#database
      .prepare(
        `
        INSERT INTO task_bindings (
          item_id, task_id, host_id, project_id, title, state,
          status_updated_at, status_updated_ms, observed_at, observed_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, task_id, host_id) DO UPDATE SET
          project_id = excluded.project_id, title = excluded.title, state = excluded.state,
          status_updated_at = excluded.status_updated_at,
          status_updated_ms = excluded.status_updated_ms,
          observed_at = excluded.observed_at, observed_ms = excluded.observed_ms
        WHERE excluded.observed_ms > task_bindings.observed_ms
          AND excluded.status_updated_ms >= task_bindings.status_updated_ms
      `,
      )
      .run(
        itemId,
        parsed.taskId,
        parsed.hostId,
        parsed.projectId ?? null,
        parsed.title,
        parsed.state,
        statusTime.iso,
        statusTime.epoch,
        observedTime.iso,
        observedTime.epoch,
      ).changes;
    if (changed === 1) this.#touchDashboardsForItem(itemId);
  }

  #task(itemId: string, taskId: string, hostId: string): DynaTaskStatus {
    const row = this.#one(
      this.#database.prepare(
        "SELECT * FROM task_bindings WHERE item_id = ? AND task_id = ? AND host_id = ?",
      ),
      itemId,
      taskId,
      hostId,
    );
    if (!row) throw new Error("The linked Codex task was not found.");
    return this.#taskFromRow(row);
  }

  #itemBaseRow(itemId: string): SqlRow {
    const row = this.#one(this.#database.prepare("SELECT * FROM items WHERE id = ?"), itemId);
    if (!row) throw new Error("Dyna item was not found.");
    return row;
  }

  #baseItem(row: SqlRow): DynaPublishedItem {
    return DynaPublishedItemSchema.parse({
      externalId: requiredString(row, "external_id"),
      sourceRef: DynaSourceRefSchema.parse(parseJson(requiredString(row, "source_ref"))),
      sourceScope: requiredString(row, "source_scope"),
      title: requiredString(row, "title"),
      summary: requiredString(row, "summary"),
      priority: requiredString(row, "priority"),
      priorityReason: requiredString(row, "priority_reason"),
      sourceUpdatedAt: requiredString(row, "source_updated_at"),
      ...(optionalString(row, "due_at") ? { dueAt: optionalString(row, "due_at") } : {}),
      labels: parseJson(requiredString(row, "labels")),
    });
  }

  #item(itemId: string): Omit<DynaItemContext, "annotations"> {
    const row = this.#itemBaseRow(itemId);
    const enrichment = this.#one(
      this.#database.prepare("SELECT * FROM item_enrichments WHERE item_id = ?"),
      itemId,
    );
    return this.#mergeItem(row, enrichment);
  }

  #mergeItem(row: SqlRow, enrichment?: SqlRow): Omit<DynaItemContext, "annotations"> {
    const itemId = requiredString(row, "id");
    const base = this.#baseItem(row);
    if (!enrichment) {
      return { ...base, id: itemId, fingerprint: requiredString(row, "fingerprint") };
    }
    const dueAtSet = requiredNumber(enrichment, "due_at_set") === 1;
    const merged = DynaPublishedItemSchema.parse({
      ...base,
      ...(optionalString(enrichment, "summary")
        ? { summary: optionalString(enrichment, "summary") }
        : {}),
      ...(optionalString(enrichment, "priority")
        ? { priority: optionalString(enrichment, "priority") }
        : {}),
      ...(optionalString(enrichment, "priority_reason")
        ? { priorityReason: optionalString(enrichment, "priority_reason") }
        : {}),
      ...(dueAtSet ? { dueAt: optionalString(enrichment, "due_at") } : {}),
      ...(optionalString(enrichment, "labels")
        ? { labels: parseJson(requiredString(enrichment, "labels")) }
        : {}),
    });
    return {
      ...merged,
      id: itemId,
      fingerprint: requiredString(row, "fingerprint"),
      enrichment: {
        state:
          requiredString(enrichment, "base_fingerprint") === requiredString(row, "fingerprint")
            ? "active"
            : "stale",
        appliedAt: requiredString(enrichment, "applied_at"),
        baseSourceUpdatedAt: requiredString(enrichment, "base_source_updated_at"),
        provenance: requiredString(enrichment, "provenance"),
      },
    };
  }

  #itemFromSnapshotRow(row: SqlRow): Omit<DynaItemContext, "annotations"> {
    const enrichment = optionalString(row, "enrichment_base_fingerprint")
      ? {
          summary: row["enrichment_summary"],
          priority: row["enrichment_priority"],
          priority_reason: row["enrichment_priority_reason"],
          due_at: row["enrichment_due_at"],
          due_at_set: row["enrichment_due_at_set"],
          labels: row["enrichment_labels"],
          base_fingerprint: row["enrichment_base_fingerprint"],
          base_source_updated_at: row["enrichment_base_source_updated_at"],
          applied_at: row["enrichment_applied_at"],
          provenance: row["enrichment_provenance"],
        }
      : undefined;
    return this.#mergeItem(row, enrichment);
  }

  #annotations(itemId: string): z.infer<typeof DynaAnnotationSchema>[] {
    return (
      this.#database
        .prepare("SELECT * FROM annotations WHERE item_id = ? ORDER BY created_at DESC LIMIT 20")
        .all(itemId) as SqlRow[]
    ).map((annotation) =>
      DynaAnnotationSchema.parse({
        id: requiredString(annotation, "id"),
        itemId,
        body: requiredString(annotation, "body"),
        createdAt: requiredString(annotation, "created_at"),
      }),
    );
  }

  #actionItemContext(itemId: string): z.infer<typeof DynaActionItemContextSchema> {
    const item = this.#item(itemId);
    return DynaActionItemContextSchema.parse({
      id: itemId,
      title: item.title,
      sourceRef: item.sourceRef,
      sourceUpdatedAt: item.sourceUpdatedAt,
      annotations: this.#annotations(itemId),
      trustBoundary: "untrusted_reference_data",
    });
  }

  #cardsFromSnapshotRows(rows: readonly SqlRow[]): DynaCard[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => requiredString(row, "id"));
    const placeholders = ids.map(() => "?").join(", ");
    const annotationRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY created_at DESC, id
           ) AS item_rank
           FROM annotations WHERE item_id IN (${placeholders})
         ) WHERE item_rank <= 20 ORDER BY item_id, created_at DESC`,
      )
      .all(...ids) as SqlRow[];
    const taskRows = this.#database
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY item_id ORDER BY observed_ms DESC, task_id, host_id
           ) AS item_rank
           FROM task_bindings WHERE item_id IN (${placeholders})
         ) WHERE item_rank <= 8 ORDER BY item_id, observed_ms DESC`,
      )
      .all(...ids) as SqlRow[];
    const annotations = new Map<string, z.infer<typeof DynaAnnotationSchema>[]>();
    for (const annotation of annotationRows) {
      const itemId = requiredString(annotation, "item_id");
      const values = annotations.get(itemId) ?? [];
      values.push(
        DynaAnnotationSchema.parse({
          id: requiredString(annotation, "id"),
          itemId,
          body: requiredString(annotation, "body"),
          createdAt: requiredString(annotation, "created_at"),
        }),
      );
      annotations.set(itemId, values);
    }
    const tasks = new Map<string, DynaTaskStatus[]>();
    for (const task of taskRows) {
      const itemId = requiredString(task, "item_id");
      const values = tasks.get(itemId) ?? [];
      values.push(this.#taskFromRow(task));
      tasks.set(itemId, values);
    }
    return rows.map((row) => {
      const id = requiredString(row, "id");
      const item = this.#itemFromSnapshotRow(row);
      return {
        id,
        fingerprint: item.fingerprint,
        source: item.sourceRef.source,
        title: item.title,
        summary: item.summary,
        priority: item.priority,
        priorityReason: item.priorityReason,
        sourceUpdatedAt: item.sourceUpdatedAt,
        ...(item.dueAt ? { dueAt: item.dueAt } : {}),
        labels: item.labels,
        ...(item.enrichment ? { enrichmentState: item.enrichment.state } : {}),
        annotations: annotations.get(id) ?? [],
        linkedTasks: tasks.get(id) ?? [],
      };
    });
  }

  #taskFromRow(row: SqlRow): DynaTaskStatus {
    return DynaTaskStatusSchema.parse({
      taskId: requiredString(row, "task_id"),
      hostId: requiredString(row, "host_id"),
      ...(optionalString(row, "project_id")
        ? { projectId: optionalString(row, "project_id") }
        : {}),
      title: requiredString(row, "title"),
      state: requiredString(row, "state"),
      statusUpdatedAt: requiredString(row, "status_updated_at"),
      observedAt: requiredString(row, "observed_at"),
    });
  }

  #touchDashboardsForPublisher(publisherId: string, instant?: string): void {
    const dashboards = (
      this.#database
        .prepare("SELECT dashboard_id FROM dashboard_publishers WHERE publisher_id = ?")
        .all(publisherId) as SqlRow[]
    ).map((row) => requiredString(row, "dashboard_id"));
    this.#touchDashboards(dashboards, instant);
  }

  #touchDashboardsForItem(itemId: string, instant?: string): void {
    const dashboards = (
      this.#database
        .prepare(
          `
        SELECT DISTINCT dp.dashboard_id FROM dashboard_publishers dp
        JOIN publisher_items pi ON pi.publisher_id = dp.publisher_id
        WHERE pi.item_id = ? AND pi.active = 1
      `,
        )
        .all(itemId) as SqlRow[]
    ).map((row) => requiredString(row, "dashboard_id"));
    this.#touchDashboards(dashboards, instant);
  }

  #touchDashboards(dashboardIds: Iterable<string>, instant?: string): void {
    const updatedAt = instant ?? this.#now();
    const update = this.#database.prepare(
      "UPDATE dashboards SET revision = revision + 1, updated_at = ? WHERE id = ?",
    );
    for (const dashboardId of new Set(dashboardIds)) update.run(updatedAt, dashboardId);
  }
}
