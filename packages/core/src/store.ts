import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StatementSync } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import type { Decision, Item, MessageRef, Rule, View } from "@agentherd/protocol";
import { redact } from "@agentherd/rules";
import { headTail } from "./cut-text.ts";
import type { HerderTurnRole } from "./herder-port.ts";
import { ftsQuery, MEMORY_TABLES_SQL, MemoryStore } from "./memory-store.ts";
import type { Schedule } from "./schedules.ts";
import {
  type AuditRow,
  type DecisionRow,
  type SessionRow,
  type StoredItem,
  toAuditRow,
  toDecisionRow,
  toRule,
  toSessionRow,
  toStoredItem,
} from "./store-rows.ts";
import {
  HERDER_LOG_TABLE_SQL,
  HERDER_TURNS_TABLE_SQL,
  INTAKE_WATCHES_TABLE_SQL,
  LATEST_SCHEMA_VERSION,
  LEGACY_HERDER_STATE_KEY,
  MAIL_WATCHES_TABLE_SQL,
  MESSAGE_TASKS_TABLE_SQL,
  OUTBOX_TABLE_SQL,
  PR_WATCHES_TABLE_SQL,
  SCHEDULES_TABLE_SQL,
  SCHEMA_SQL,
  STATE_TABLE_SQL,
  TASK_ALLOWED_STEPS_SQL,
  TASK_WORKSPACE_SQL,
  TASKS_TABLE_SQL,
  TRANSCRIPT_TABLE_SQL,
} from "./store-schema.ts";
import type { Task } from "./tasks.ts";
import type { TaskWorkspace } from "./workspace.ts";

export type { AuditRow, DecisionRow, SessionRow, StoredItem } from "./store-rows.ts";

/** One line of a task's conversation. */
export interface TranscriptEntry {
  id: number;
  at: string;
  /** prompt: what AgentHerd sent the agent; agent: its reply; tool: a tool call; note: an event. */
  role: "prompt" | "agent" | "tool" | "note";
  text: string;
  /** Tool calls only: pending, in_progress, completed or failed. */
  status?: string;
}

/** Entries kept per task; older ones are dropped. */
export const TRANSCRIPT_MAX_ENTRIES = 2000;
/** Characters kept per entry. */
export const TRANSCRIPT_MAX_CHARS = 20_000;

export interface StoreOptions {
  secrets?: Record<string, string>;
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly secrets: Record<string, string> | undefined;
  /** The Herder's long-term memory (ADR 0038). */
  readonly memory: MemoryStore;

  private readonly stmtUpsertSession: StatementSync;
  private readonly stmtGetSession: StatementSync;
  private readonly stmtInsertItem: StatementSync;
  private readonly stmtGetItem: StatementSync;
  private readonly stmtOpenItems: StatementSync;
  private readonly stmtInsertDecision: StatementSync;
  private readonly stmtDecisionsFor: StatementSync;
  private readonly stmtInsertRule: StatementSync;
  private readonly stmtListRules: StatementSync;
  private readonly stmtDeleteRule: StatementSync;
  private readonly stmtInsertAudit: StatementSync;
  private readonly stmtAuditRows: StatementSync;
  private readonly stmtAuditRowsByKind: StatementSync;
  private readonly stmtGetState: StatementSync;
  private readonly stmtSetState: StatementSync;
  private readonly stmtDeleteState: StatementSync;

  private constructor(path: string, options?: StoreOptions) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.secrets = options?.secrets;

    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)");
    const versionRow = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get();
    if (versionRow === undefined) {
      this.db.exec(SCHEMA_SQL);
      this.db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(LATEST_SCHEMA_VERSION);
    } else {
      const version = versionRow.version as number;
      if (version < 1 || version > LATEST_SCHEMA_VERSION) {
        this.db.close();
        throw new Error(`unsupported herd.db schema version ${version}`);
      }
      if (version < 2) {
        this.db.exec(STATE_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(2);
      }
      if (version < 3) {
        this.db.exec(TRANSCRIPT_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(3);
      }
      if (version < 4) {
        this.db.exec(HERDER_TURNS_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(4);
      }
      if (version < 5) {
        this.db.exec(MEMORY_TABLES_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(5);
      }
      if (version < 6) {
        this.db.exec(TASKS_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(6);
      }
      if (version < 7) {
        const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
        if (!columns.some((c) => c.name === "workspace_json")) this.db.exec(TASK_WORKSPACE_SQL);
        this.db.exec(MESSAGE_TASKS_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(7);
      }
      if (version < 8) {
        this.transaction(() => {
          this.db.exec(HERDER_LOG_TABLE_SQL);
          this.moveLegacyHerderMessages();
          this.db.prepare("UPDATE schema_version SET version = ?").run(8);
        });
      }
      if (version < 9) {
        this.db.exec(OUTBOX_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(9);
      }
      if (version < 10) {
        this.db.exec(PR_WATCHES_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(10);
      }
      if (version < 11) {
        this.db.exec(MAIL_WATCHES_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(11);
      }
      if (version < 12) {
        this.db.exec(INTAKE_WATCHES_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(12);
      }
      if (version < 13) {
        this.db.exec(SCHEDULES_TABLE_SQL);
        this.db.prepare("UPDATE schema_version SET version = ?").run(13);
      }
      if (version < 14) {
        const columns = this.db.prepare("PRAGMA table_info(tasks)").all();
        if (!columns.some((c) => c.name === "allowed_steps_json")) {
          this.db.exec(TASK_ALLOWED_STEPS_SQL);
        }
        this.db.prepare("UPDATE schema_version SET version = ?").run(14);
      }
    }

    if (path !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.memory = new MemoryStore(this.db, this.secrets);

    this.stmtUpsertSession = this.db.prepare(
      "INSERT OR REPLACE INTO sessions(id, profile_id, cwd, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.stmtGetSession = this.db.prepare(
      "SELECT id, profile_id, cwd, state, created_at, updated_at FROM sessions WHERE id = ?",
    );
    this.stmtInsertItem = this.db.prepare(
      "INSERT INTO items(id, session_id, profile_id, cwd, kind, state, tool_call_json, title, body, risk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtGetItem = this.db.prepare(
      "SELECT id, session_id, profile_id, cwd, kind, state, tool_call_json, title, body, risk, created_at, decided_at, message_ref_json FROM items WHERE id = ?",
    );
    this.stmtOpenItems = this.db.prepare(
      "SELECT id, session_id, profile_id, cwd, kind, state, tool_call_json, title, body, risk, created_at, decided_at, message_ref_json FROM items WHERE state = 'open' ORDER BY created_at, rowid",
    );
    this.stmtInsertDecision = this.db.prepare(
      "INSERT INTO decisions(item_id, action, text, source, reason, confidence, risk, rule_id, owner_id, precedents_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.stmtDecisionsFor = this.db.prepare(
      "SELECT item_id, action, text, source, reason, confidence, risk, rule_id, owner_id, precedents_json, created_at FROM decisions WHERE item_id = ? ORDER BY rowid",
    );
    this.stmtInsertRule = this.db.prepare(
      "INSERT INTO rules(id, action, match_json, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.stmtListRules = this.db.prepare(
      "SELECT id, action, match_json, created_by, created_at FROM rules ORDER BY rowid",
    );
    this.stmtDeleteRule = this.db.prepare("DELETE FROM rules WHERE id = ?");
    this.stmtInsertAudit = this.db.prepare(
      "INSERT INTO audit(at, kind, data_json) VALUES (?, ?, ?)",
    );
    this.stmtAuditRows = this.db.prepare("SELECT id, at, kind, data_json FROM audit ORDER BY id");
    this.stmtAuditRowsByKind = this.db.prepare(
      "SELECT id, at, kind, data_json FROM audit WHERE kind = ? ORDER BY id",
    );
    this.stmtGetState = this.db.prepare("SELECT value_json FROM state WHERE key = ?");
    this.stmtSetState = this.db.prepare(
      "INSERT OR REPLACE INTO state(key, value_json, updated_at) VALUES (?, ?, ?)",
    );
    this.stmtDeleteState = this.db.prepare("DELETE FROM state WHERE key = ?");
  }

  static open(path: string, options?: StoreOptions): Store {
    return new Store(path, options);
  }

  close(): void {
    if (this.db.isOpen) {
      this.db.close();
    }
  }

  upsertSession(row: SessionRow): void {
    this.stmtUpsertSession.run(
      row.id,
      row.profileId,
      row.cwd,
      row.state,
      row.createdAt,
      row.updatedAt,
    );
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.stmtGetSession.get(id);
    return row === undefined ? undefined : toSessionRow(row);
  }

  insertItem(item: Item): void {
    this.stmtInsertItem.run(
      item.id,
      item.sessionId,
      item.profileId,
      item.cwd,
      item.kind,
      item.state,
      item.toolCall === undefined ? null : redact(JSON.stringify(item.toolCall), this.secrets),
      redact(item.title, this.secrets),
      redact(item.body, this.secrets),
      item.risk,
      item.createdAt,
    );
  }

  updateItem(
    id: string,
    patch: {
      state?: Item["state"];
      decidedAt?: string;
      messageRef?: MessageRef;
      risk?: Item["risk"];
    },
  ): void {
    const sets: string[] = [];
    const args: string[] = [];
    if (patch.state !== undefined) {
      sets.push("state = ?");
      args.push(patch.state);
    }
    if (patch.decidedAt !== undefined) {
      sets.push("decided_at = ?");
      args.push(patch.decidedAt);
    }
    if (patch.messageRef !== undefined) {
      sets.push("message_ref_json = ?");
      args.push(JSON.stringify(patch.messageRef));
    }
    if (patch.risk !== undefined) {
      sets.push("risk = ?");
      args.push(patch.risk);
    }
    if (sets.length === 0) {
      return;
    }
    args.push(id);
    this.db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  getItem(id: string): StoredItem | undefined {
    const row = this.stmtGetItem.get(id);
    return row === undefined ? undefined : toStoredItem(row);
  }

  openItems(): StoredItem[] {
    return this.stmtOpenItems.all().map(toStoredItem);
  }

  insertDecision(
    decision: Decision,
    extra: { ruleId?: string; ownerId?: string; createdAt: string },
  ): void {
    this.stmtInsertDecision.run(
      decision.itemId,
      decision.action,
      decision.text === undefined ? null : redact(decision.text, this.secrets),
      decision.source,
      redact(decision.reason, this.secrets),
      decision.confidence,
      decision.risk,
      extra.ruleId ?? null,
      extra.ownerId ?? null,
      JSON.stringify(decision.precedents),
      extra.createdAt,
    );
  }

  decisionsFor(itemId: string): DecisionRow[] {
    return this.stmtDecisionsFor.all(itemId).map(toDecisionRow);
  }

  /** Newest first. */
  recentSessions(limit = 20): SessionRow[] {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map(toSessionRow);
  }

  /** Newest first. */
  recentDecisions(limit = 20): DecisionRow[] {
    return this.db
      .prepare("SELECT * FROM decisions ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map(toDecisionRow);
  }

  insertRule(rule: Rule): void {
    this.stmtInsertRule.run(
      rule.id,
      rule.action,
      JSON.stringify(rule.match),
      rule.createdBy,
      rule.createdAt,
    );
  }

  listRules(): Rule[] {
    return this.stmtListRules.all().map(toRule);
  }

  deleteRule(id: string): boolean {
    const result = this.stmtDeleteRule.run(id);
    return Number(result.changes) > 0;
  }

  audit(kind: string, data: Record<string, unknown>, at?: string): void {
    this.stmtInsertAudit.run(
      at ?? new Date().toISOString(),
      kind,
      redact(JSON.stringify(data), this.secrets),
    );
  }

  auditRows(kind?: string): AuditRow[] {
    const rows = kind === undefined ? this.stmtAuditRows.all() : this.stmtAuditRowsByKind.all(kind);
    return rows.map(toAuditRow);
  }

  /** Adds a line to a task's conversation (secrets redacted). */
  addTranscript(
    taskId: string,
    role: TranscriptEntry["role"],
    text: string,
    tool?: { id: string; status?: string },
  ): void {
    const cut = headTail(text, TRANSCRIPT_MAX_CHARS, "the rest was not kept");
    this.db
      .prepare(
        "INSERT INTO transcript(task_id, at, role, text, tool_call_id, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        taskId,
        new Date().toISOString(),
        role,
        redact(cut, this.secrets),
        tool?.id ?? null,
        tool?.status ?? null,
      );
  }

  /** Sets the status of a tool call already in the conversation. */
  setToolStatus(taskId: string, toolCallId: string, status: string): void {
    this.db
      .prepare("UPDATE transcript SET status = ? WHERE task_id = ? AND tool_call_id = ?")
      .run(status, taskId, toolCallId);
  }

  /** The last {@link TRANSCRIPT_MAX_ENTRIES} lines of a task's conversation, oldest first. */
  transcript(taskId: string): TranscriptEntry[] {
    const rows = this.db
      .prepare(
        "SELECT id, at, role, text, status FROM transcript WHERE task_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(taskId, TRANSCRIPT_MAX_ENTRIES);
    return rows.reverse().map((r) => {
      const e: TranscriptEntry = {
        id: Number(r.id),
        at: String(r.at),
        role: r.role as TranscriptEntry["role"],
        text: String(r.text),
      };
      if (typeof r.status === "string") e.status = r.status;
      return e;
    });
  }

  /** Adds a line of the Herder's conversation with the owner (secrets redacted). */
  addHerderTurn(role: HerderTurnRole, text: string, taskId?: string): void {
    const cut = headTail(text, TRANSCRIPT_MAX_CHARS, "the rest was not kept");
    this.db
      .prepare("INSERT INTO herder_turns(at, role, text, task_id) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), role, redact(cut, this.secrets), taskId ?? null);
  }

  /** The last `limit` lines of the Herder's conversation, oldest first. */
  herderTurns(limit = 100): HerderTurn[] {
    const rows = this.db
      .prepare("SELECT id, at, role, text, task_id FROM herder_turns ORDER BY id DESC LIMIT ?")
      .all(limit);
    return rows.reverse().map(toHerderTurn);
  }

  /** Lines of the Herder's conversation that contain the words of `query`, newest first. */
  searchHerderTurns(query: string, limit = 10): HerderTurn[] {
    const match = ftsQuery(query);
    if (match === "") return [];
    const rows = this.db
      .prepare(
        "SELECT t.id, t.at, t.role, t.text, t.task_id FROM herder_turns_fts f JOIN herder_turns t ON t.id = f.rowid WHERE herder_turns_fts MATCH ? ORDER BY bm25(herder_turns_fts) LIMIT ?",
      )
      .all(match, limit);
    return rows.map(toHerderTurn);
  }

  /** Saves a task as it is now (secrets redacted). */
  saveTask(t: StoredTask): void {
    const r = (v: string) => redact(v, this.secrets);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tasks(id, title, project, cwd, profile_id, agent, model, stage, last_report,
          started_at, updated_at, ended_at, ended_why, failed, agent_session_id, automatic_decisions_json,
          workspace_json, allowed_steps_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.task.id,
        r(t.task.title),
        t.task.project,
        t.cwd,
        t.profileId,
        t.task.agent,
        t.task.model ?? null,
        t.task.stage,
        r(t.task.lastReport),
        t.task.startedAt,
        t.task.updatedAt,
        t.endedAt ?? null,
        t.endedWhy === undefined ? null : r(t.endedWhy),
        t.failed ? 1 : 0,
        t.agentSessionId ?? null,
        r(JSON.stringify(t.task.automaticDecisions)),
        t.workspace === undefined ? null : JSON.stringify(t.workspace),
        t.task.allowedSteps === undefined ? null : JSON.stringify(t.task.allowedSteps),
      );
  }

  /** Remembers that a message the owner can reply to is about a task (ADR 0043). */
  linkMessage(messageId: string, taskId: string, at = new Date()): void {
    this.db
      .prepare("INSERT OR REPLACE INTO message_tasks(message_id, task_id, at) VALUES (?, ?, ?)")
      .run(messageId, taskId, at.toISOString());
  }

  /** Keeps a message for the owner until the channel took it. */
  addOutbox(row: OutboxRow): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO outbox(id, view_json, task_id, attempts, next_at, created_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        row.id,
        JSON.stringify(row.view),
        row.taskId ?? null,
        row.attempts,
        row.nextAt,
        row.createdAt,
        row.error ?? null,
      );
  }

  /** Messages the channel has not taken yet, oldest first. */
  outbox(): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM outbox ORDER BY created_at, rowid")
      .all()
      .map((r) => ({
        id: String(r.id),
        view: JSON.parse(String(r.view_json)) as View,
        ...(r.task_id === null ? {} : { taskId: String(r.task_id) }),
        attempts: Number(r.attempts),
        nextAt: String(r.next_at),
        createdAt: String(r.created_at),
        ...(r.error === null ? {} : { error: String(r.error) }),
      }));
  }

  /** Saves how far AgentHerd has read a pull request a task opened. */
  savePrWatch(watch: PrWatch): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO pr_watches(key, task_id, data_json, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(prKey(watch), watch.taskId, JSON.stringify(watch), new Date().toISOString());
  }

  /** Pull requests followed, oldest first. */
  prWatches(): PrWatch[] {
    return this.db
      .prepare("SELECT data_json FROM pr_watches ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.data_json)) as PrWatch);
  }

  deletePrWatch(watch: Pick<PrWatch, "repo" | "number">): void {
    this.db.prepare("DELETE FROM pr_watches WHERE key = ?").run(prKey(watch));
  }

  saveMailWatch(watch: MailWatch): void {
    this.db
      .prepare("INSERT OR REPLACE INTO mail_watches(id, data_json, created_at) VALUES (?, ?, ?)")
      .run(watch.id, JSON.stringify(watch), watch.createdAt);
  }

  /** Mail watches the owner asked for, oldest first. */
  mailWatches(): MailWatch[] {
    return this.db
      .prepare("SELECT data_json FROM mail_watches ORDER BY created_at, id")
      .all()
      .map((r) => JSON.parse(String(r.data_json)) as MailWatch);
  }

  deleteMailWatch(id: string): void {
    this.db.prepare("DELETE FROM mail_watches WHERE id = ?").run(id);
  }

  saveIntakeWatch(watch: IntakeWatch): void {
    this.db
      .prepare("INSERT OR REPLACE INTO intake_watches(id, data_json, created_at) VALUES (?, ?, ?)")
      .run(watch.id, JSON.stringify(watch), watch.createdAt);
  }

  /** New-work watches the owner asked for, oldest first (ADR 0052). */
  intakeWatches(): IntakeWatch[] {
    return this.db
      .prepare("SELECT data_json FROM intake_watches ORDER BY created_at, id")
      .all()
      .map((r) => JSON.parse(String(r.data_json)) as IntakeWatch);
  }

  deleteIntakeWatch(id: string): void {
    this.db.prepare("DELETE FROM intake_watches WHERE id = ?").run(id);
  }

  saveSchedule(schedule: Schedule): void {
    this.db
      .prepare("INSERT OR REPLACE INTO schedules(id, data_json, created_at) VALUES (?, ?, ?)")
      .run(schedule.id, JSON.stringify(schedule), schedule.createdAt);
  }

  /** What the Herder does at set times (ADR 0055), oldest first. */
  schedules(): Schedule[] {
    return this.db
      .prepare("SELECT data_json FROM schedules ORDER BY created_at, id")
      .all()
      .map((r) => JSON.parse(String(r.data_json)) as Schedule);
  }

  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  /** The channel took the message, or it was given up. */
  deleteOutbox(id: string): void {
    this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
  }

  /** The task a message is about, if AgentHerd sent it for one. */
  taskOfMessage(messageId: string): string | undefined {
    const row = this.db
      .prepare("SELECT task_id FROM message_tasks WHERE message_id = ?")
      .get(messageId);
    return row === undefined ? undefined : String(row.task_id);
  }

  /** The `limit` most recently updated tasks, newest first. */
  tasks(limit = 50): StoredTask[] {
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(limit)
      .map(toStoredTask);
  }

  /** One saved task. */
  task(id: string): StoredTask | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row === undefined ? undefined : toStoredTask(row);
  }

  getState<T>(key: string): T | undefined {
    const row = this.stmtGetState.get(key);
    return row === undefined ? undefined : (JSON.parse(row.value_json as string) as T);
  }

  setState(key: string, value: unknown, at?: Date): void {
    this.stmtSetState.run(key, JSON.stringify(value), (at ?? new Date()).toISOString());
  }

  deleteState(key: string): void {
    this.stmtDeleteState.run(key);
  }

  /** The Herder's whole conversation, oldest first (ADR 0045). */
  herderLog(): unknown[] {
    return this.db
      .prepare("SELECT message_json FROM herder_log ORDER BY seq")
      .all()
      .map((row) => JSON.parse(row.message_json as string) as unknown);
  }

  /**
   * Replaces the Herder's conversation from position `from` on: new messages are appended, and a
   * turn that was rolled back or rewritten replaces what was saved of it.
   */
  writeHerderLog(from: number, messages: unknown[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM herder_log WHERE seq >= ?").run(from);
      const insert = this.db.prepare("INSERT INTO herder_log(seq, message_json) VALUES (?, ?)");
      for (const [i, message] of messages.entries()) insert.run(from + i, JSON.stringify(message));
    });
  }

  /** Before schema version 8 the Herder kept the tail of its conversation in `state`. */
  private moveLegacyHerderMessages(): void {
    const row = this.db
      .prepare("SELECT value_json FROM state WHERE key = ?")
      .get(LEGACY_HERDER_STATE_KEY);
    if (row === undefined) return;
    const messages = JSON.parse(row.value_json as string) as unknown;
    if (Array.isArray(messages)) {
      const insert = this.db.prepare("INSERT INTO herder_log(seq, message_json) VALUES (?, ?)");
      for (const [i, message] of messages.entries()) insert.run(i, JSON.stringify(message));
    }
    this.db.prepare("DELETE FROM state WHERE key = ?").run(LEGACY_HERDER_STATE_KEY);
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A pull request a task opened, as far as AgentHerd has read it. */
export interface PrWatch {
  /** `owner/name` */
  repo: string;
  number: number;
  url: string;
  taskId: string;
  /** Ids of comments and reviews already handled. */
  seen: string[];
  /** Head commit whose failed checks were already handed to the task. */
  ciFailedSha?: string;
  /** Times the task was woken for this pull request. */
  wakes: number;
  createdAt: string;
  /** Last comment, review or failed check; a watch quiet for long ends. */
  activeAt: string;
  /** Set once it merged or closed; the watch then keeps going for 14 quiet days (ADR 0051). */
  closed?: "merged" | "closed";
  /** The owner handed this pull request to the task; it need not be the task's own. */
  handed?: boolean;
  /** The owner paused it in the app: kept, but not looked at (ADR 0058). */
  paused?: boolean;
  /** Automatic wake-ups since the owner last wrote to the task; at three it waits (ADR 0062). */
  wakesInRow?: number;
  /** News that waits for the owner; it goes to the task with their next message (ADR 0062). */
  held?: string[];
}

export function prKey(w: Pick<PrWatch, "repo" | "number">): string {
  return `${w.repo.toLowerCase()}#${w.number}`;
}

/** A message for the owner waiting in the outbox. */
export interface OutboxRow {
  id: string;
  view: View;
  /** The task it is about: the owner's reply to it goes there. */
  taskId?: string;
  attempts: number;
  /** When to try again (ISO). */
  nextAt: string;
  createdAt: string;
  /** The last send error. */
  error?: string;
}

/** Mail the owner asked to be told about (docs/spec/04-herder.md "Mail"). */
/** New work on GitHub the owner asked to be offered (ADR 0052). */
export interface IntakeWatch {
  id: string;
  /** Issues assigned to the owner, or pull requests waiting for their review. */
  kind: "issues" | "reviews";
  /** `owner/name`; every repository when missing. */
  repo?: string;
  label?: string;
  /** What the owner wants to hear about, in their words. */
  about: string;
  /** New items start a task without asking: the owner said so. */
  auto: boolean;
  createdAt: string;
  /** Urls of items already seen, newest last. */
  seen: string[];
  /** Items offered with 「开任务 / 忽略」 the owner has not answered yet. */
  offers: IntakeOffer[];
  /** The owner paused it in the app: kept, but not looked at (ADR 0058). */
  paused?: boolean;
}

export interface IntakeOffer {
  id: string;
  item: { kind: "issues" | "reviews"; repo: string; number: number; title: string; url: string };
  /** The offer's message, to take its buttons away once answered. */
  ref?: MessageRef;
}

export interface MailWatch {
  id: string;
  /** What the owner wants to hear about, in their words, e.g. "导师的邮件". */
  about: string;
  /** A Gmail search, e.g. `from:prof@uni.edu`. */
  query: string;
  createdAt: string;
  /** Ids of messages already told, newest last. */
  seen: string[];
  /** The owner paused it in the app: kept, but not looked at (ADR 0058). */
  paused?: boolean;
}

/** A task as saved in herd.db (ADR 0039). */
export interface StoredTask {
  task: Task;
  cwd: string;
  profileId: string;
  failed: boolean;
  endedAt?: string;
  endedWhy?: string;
  /** The agent's own session id, used to load the session again when the agent supports it. */
  agentSessionId?: string;
  /** Where the task's agent works (ADR 0043). Tasks saved before schema 7 have none. */
  workspace?: TaskWorkspace;
}

function toStoredTask(r: Record<string, unknown>): StoredTask {
  const task: Task = {
    id: String(r.id),
    title: String(r.title),
    project: String(r.project),
    agent: String(r.agent),
    stage: r.stage as Task["stage"],
    lastReport: String(r.last_report),
    startedAt: String(r.started_at),
    updatedAt: String(r.updated_at),
    automaticDecisions: JSON.parse(String(r.automatic_decisions_json)) as string[],
  };
  if (typeof r.model === "string") task.model = r.model;
  if (typeof r.allowed_steps_json === "string") {
    task.allowedSteps = JSON.parse(r.allowed_steps_json) as Task["allowedSteps"] & object;
  }
  const t: StoredTask = {
    task,
    cwd: String(r.cwd),
    profileId: String(r.profile_id),
    failed: r.failed === 1 || r.failed === 1n,
  };
  if (typeof r.ended_at === "string") t.endedAt = r.ended_at;
  if (typeof r.ended_why === "string") t.endedWhy = r.ended_why;
  if (typeof r.agent_session_id === "string") t.agentSessionId = r.agent_session_id;
  if (typeof r.workspace_json === "string") {
    t.workspace = JSON.parse(r.workspace_json) as TaskWorkspace;
  }
  return t;
}

/** A line of the Herder's conversation with the owner. */
export interface HerderTurn {
  id: number;
  at: string;
  role: HerderTurnRole;
  text: string;
  taskId?: string;
}

function toHerderTurn(r: Record<string, unknown>): HerderTurn {
  const t: HerderTurn = {
    id: Number(r.id),
    at: String(r.at),
    role: r.role as HerderTurnRole,
    text: String(r.text),
  };
  if (typeof r.task_id === "string") t.taskId = r.task_id;
  return t;
}

export { ftsQuery };
