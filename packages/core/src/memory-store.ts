// The Herder's long-term memory in herd.db (docs/spec/08-herder-interaction.md §2, ADR 0038).
// Rows are never overwritten: a change supersedes or marks a row and is kept as a revision, so
// every change can be undone. Checks on *what* may be written live with the writers (the Herder's
// memory tool and the background jobs); this file enforces only sizes and caps.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { redact } from "@agentherd/rules";

export const MEMORY_KINDS = [
  "profile",
  "owner",
  "decision",
  "person",
  "project",
  "note",
  "case",
  "experience",
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Kinds kept in the Herder's system prompt; the others are found by search. */
export const RESIDENT_KINDS = ["profile", "owner", "decision", "note"] as const;
export type ResidentKind = (typeof RESIDENT_KINDS)[number];

/** Characters of `abstract` all active entries of a resident kind may hold together. */
export const RESIDENT_CAPS: Record<ResidentKind, number> = {
  profile: 600,
  owner: 1375,
  decision: 2200,
  note: 2200,
};

/**
 * What the owner's profile card holds (ADR 0091): one entry per field, written 「称呼：火哥」. A new
 * entry for a field the card already has takes the old one's place.
 */
export const PROFILE_FIELDS = ["称呼", "身份", "在做", "作息", "回答方式", "喜好", "在意"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** The field a profile entry is about, e.g. 「称呼」 for 「称呼：火哥」; undefined when it names none. */
export function profileField(abstract: string): ProfileField | undefined {
  const m = /^\s*([^：:]{1,8})\s*[：:]\s*\S/.exec(abstract);
  const name = m?.[1]?.trim();
  return PROFILE_FIELDS.find((f) => f === name);
}

export const ABSTRACT_MAX_CHARS = 200;
export const BODY_MAX_CHARS = 4000;

export type MemoryStatus = "active" | "superseded" | "expired" | "deleted";
/** `said`: the owner's words; `noticed`: the Herder's own; `task`: a task-end job; `review`: a review job; `owner_edit`: the app. */
export type MemorySource = "said" | "noticed" | "task" | "review" | "owner_edit";

/** Turns text into vectors for memory search (ADR 0038). Supplied by the host; may be missing. */
export interface Embedder {
  /** Name of the model; vectors of another model are not compared. */
  readonly model: string;
  /** One normalized vector per text, or undefined while the model is not ready. */
  embed(texts: readonly string[]): Promise<Float32Array[] | undefined>;
}

/** One request to a cheap model: system and user text in, reply text out. */
export type Completer = (system: string, user: string, signal: AbortSignal) => Promise<string>;

/** Weight of vector similarity in hybrid search; the rest is keyword rank. */
export const VECTOR_WEIGHT = 0.7;
/** A hit found by vectors alone must be at least this similar. */
export const VECTOR_ONLY_MIN = 0.5;

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  /** `global` or `project:<dir>`. */
  scope: string;
  /** L0: one line, ≤200 chars; this is what search and the snapshot show. */
  abstract: string;
  /** L1/L2: details, ≤4000 chars. */
  body: string;
  /** The owner's words this entry rests on, when it has any. */
  evidence?: string;
  source: MemorySource;
  sourceRef?: string;
  /** ISO date after which the entry no longer applies. */
  until?: string;
  status: MemoryStatus;
  supersededBy?: string;
  accessCount: number;
  lastAccessAt?: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryOp =
  | {
      op: "add";
      kind: MemoryKind;
      abstract: string;
      body?: string;
      evidence?: string;
      scope?: string;
      until?: string;
    }
  | {
      op: "replace";
      id: string;
      abstract: string;
      scope?: string;
      body?: string;
      evidence?: string;
      until?: string;
    }
  | { op: "remove"; id: string };

export interface WriteMeta {
  actor: "herder" | "task" | "review" | "dream" | "owner";
  source: MemorySource;
  sourceRef?: string;
}

export interface MemoryRevision {
  id: number;
  batchId: string;
  memoryId: string;
  op: string;
  before?: MemoryRow;
  after?: MemoryRow;
  at: string;
  actor: string;
}

export interface MemoryHit extends MemoryRow {
  /** Higher is better; FTS bm25 turned positive. */
  score: number;
}

export interface MemoryJob {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface MemoryLogRow {
  id: number;
  at: string;
  kind: string;
  text: string;
  ref?: string;
}

/** A write that would make a resident kind larger than its cap. Carries what is there now. */
export class MemoryFullError extends Error {
  readonly kind: ResidentKind;
  readonly used: number;
  readonly cap: number;
  readonly entries: MemoryRow[];

  constructor(kind: ResidentKind, used: number, cap: number, entries: MemoryRow[]) {
    super(`memory "${kind}" would hold ${used} of ${cap} characters`);
    this.kind = kind;
    this.used = used;
    this.cap = cap;
    this.entries = entries;
  }
}

export const MEMORY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  abstract TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  until TEXT,
  status TEXT NOT NULL,
  superseded_by TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_access_at TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, status);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  abstract, body, content='memories', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, abstract, body) VALUES (new.rowid, new.abstract, new.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, abstract, body) VALUES ('delete', old.rowid, old.abstract, old.body);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF abstract, body ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, abstract, body) VALUES ('delete', old.rowid, old.abstract, old.body);
  INSERT INTO memories_fts(rowid, abstract, body) VALUES (new.rowid, new.abstract, new.body);
END;
CREATE TABLE IF NOT EXISTS memory_vectors(
  memory_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  op TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_revisions_batch ON memory_revisions(batch_id);
CREATE TABLE IF NOT EXISTS memory_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ref TEXT
);
CREATE TABLE IF NOT EXISTS memory_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
`;

/** Job kinds: a case from an ended task; a review of the Herder's recent conversation. */
/** Jobs queued before ADR 0054 wrote a case for every task; they now run as lesson jobs. */
export const CASE_JOB = "case";
/** A task that went wrong or needed the owner again, looked at for a lesson (ADR 0054). */
export const LESSON_JOB = "lesson";
export const REVIEW_JOB = "review";
export const DREAM_JOB = "dream";

/** Waits before a failed job runs again: 1 min, 10 min, 1 h; then it stays failed. */
export const JOB_RETRY_MS = [60_000, 600_000, 3_600_000];

const COLUMNS =
  "id, kind, scope, abstract, body, evidence, source, source_ref, until, status, superseded_by, access_count, last_access_at, rev, created_at, updated_at";

function toRow(r: Record<string, unknown>): MemoryRow {
  const row: MemoryRow = {
    id: String(r.id),
    kind: r.kind as MemoryKind,
    scope: String(r.scope),
    abstract: String(r.abstract),
    body: String(r.body),
    source: r.source as MemorySource,
    status: r.status as MemoryStatus,
    accessCount: Number(r.access_count),
    rev: Number(r.rev),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
  if (typeof r.evidence === "string") row.evidence = r.evidence;
  if (typeof r.source_ref === "string") row.sourceRef = r.source_ref;
  if (typeof r.until === "string") row.until = r.until;
  if (typeof r.superseded_by === "string") row.supersededBy = r.superseded_by;
  if (typeof r.last_access_at === "string") row.lastAccessAt = r.last_access_at;
  return row;
}

/**
 * FTS5 trigram query: each word of 3+ characters quoted, joined by OR; runs of Chinese are cut into
 * overlapping 3-character pieces. Empty when nothing is long enough.
 */
export function ftsQuery(text: string): string {
  const pieces = new Set<string>();
  for (const word of text.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    const chars = [...word];
    if (chars.length < 3) continue;
    if (/\p{Script=Han}/u.test(word)) {
      for (let i = 0; i + 3 <= chars.length; i++) pieces.add(chars.slice(i, i + 3).join(""));
    } else {
      pieces.add(word);
    }
  }
  return [...pieces].map((p) => `"${p.replaceAll('"', '""')}"`).join(" OR ");
}

/** Words of 2 characters (e.g. "主管", "pi"), which trigram FTS cannot match; searched with LIKE. */
function shortWords(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[\s\p{P}\p{S}]+/u)) {
    const chars = [...word];
    if (chars.length === 2) out.add(word);
    if (/\p{Script=Han}/u.test(word) && chars.length > 2) {
      for (let i = 0; i + 2 <= chars.length; i++) out.add(chars.slice(i, i + 2).join(""));
    }
  }
  return [...out];
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly secrets: Record<string, string> | undefined;
  private readonly now: () => Date;

  constructor(
    db: DatabaseSync,
    secrets?: Record<string, string>,
    now: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.secrets = secrets;
    this.now = now;
  }

  get(id: string): MemoryRow | undefined {
    const r = this.db.prepare(`SELECT ${COLUMNS} FROM memories WHERE id = ?`).get(id);
    return r === undefined ? undefined : toRow(r);
  }

  redact(text: string): string {
    return redact(text, this.secrets);
  }

  /** Entries by kind and status, newest first. Expired entries are marked first. */
  list(opts: { kinds?: readonly MemoryKind[]; status?: MemoryStatus | "all" } = {}): MemoryRow[] {
    this.sweep();
    const where: string[] = [];
    const args: string[] = [];
    if (opts.kinds !== undefined && opts.kinds.length > 0) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      args.push(...opts.kinds);
    }
    const status = opts.status ?? "active";
    if (status !== "all") {
      where.push("status = ?");
      args.push(status);
    }
    const sql = `SELECT ${COLUMNS} FROM memories ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC`;
    return this.db
      .prepare(sql)
      .all(...args)
      .map(toRow);
  }

  /** Characters of `abstract` the active entries of a resident kind hold. */
  used(kind: ResidentKind): number {
    return this.list({ kinds: [kind] }).reduce((n, r) => n + r.abstract.length, 0);
  }

  /**
   * Applies every op or none. `replace` supersedes the old row with a new one; `remove` marks it
   * deleted. Throws {@link MemoryFullError} when a resident kind would pass its cap.
   * @returns the batch id (for undo) and the id each op wrote.
   */
  write(ops: readonly MemoryOp[], meta: WriteMeta): { batchId: string; ids: string[] } {
    const batchId = randomUUID();
    const ids: string[] = [];
    const at = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const op of ops) ids.push(this.apply(op, meta, batchId, at));
      for (const kind of RESIDENT_KINDS) {
        const used = this.used(kind);
        if (used > RESIDENT_CAPS[kind] && ops.some((o) => this.touches(o, kind))) {
          throw new MemoryFullError(kind, used, RESIDENT_CAPS[kind], []);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof MemoryFullError) {
        throw new MemoryFullError(
          error.kind,
          error.used,
          error.cap,
          this.list({ kinds: [error.kind] }),
        );
      }
      throw error;
    }
    return { batchId, ids };
  }

  private touches(op: MemoryOp, kind: MemoryKind): boolean {
    if (op.op === "add") return op.kind === kind;
    if (op.op === "replace") return this.get(op.id)?.kind === kind;
    return false;
  }

  private apply(op: MemoryOp, meta: WriteMeta, batchId: string, at: string): string {
    if (op.op === "add" && op.kind === "profile") {
      // One entry per field: 「称呼：火哥」 replaces the card's old 称呼 (ADR 0091).
      const field = profileField(op.abstract);
      const old = this.list({ kinds: ["profile"] }).find((r) => profileField(r.abstract) === field);
      if (field !== undefined && old !== undefined) {
        return this.apply(
          {
            op: "replace",
            id: old.id,
            abstract: op.abstract,
            ...(op.body === undefined ? {} : { body: op.body }),
            ...(op.evidence === undefined ? {} : { evidence: op.evidence }),
            ...(op.until === undefined ? {} : { until: op.until }),
          },
          meta,
          batchId,
          at,
        );
      }
    }
    if (op.op === "add") {
      const id = randomUUID();
      this.insert(
        {
          id,
          kind: op.kind,
          scope: op.scope ?? "global",
          abstract: op.abstract,
          body: op.body ?? "",
          ...(op.evidence === undefined ? {} : { evidence: op.evidence }),
          ...(op.until === undefined ? {} : { until: op.until }),
        },
        meta,
        at,
      );
      this.revision(batchId, id, "add", undefined, this.get(id), at, meta.actor);
      return id;
    }
    const old = this.get(op.id);
    if (old === undefined || old.status !== "active") {
      throw new Error(`no active memory ${op.id}`);
    }
    if (op.op === "remove") {
      this.db
        .prepare("UPDATE memories SET status = 'deleted', updated_at = ? WHERE id = ?")
        .run(at, op.id);
      this.revision(batchId, op.id, "remove", old, this.get(op.id), at, meta.actor);
      return op.id;
    }
    const id = randomUUID();
    const evidence = op.evidence ?? old.evidence;
    const until = op.until ?? old.until;
    this.insert(
      {
        id,
        kind: old.kind,
        scope: op.scope ?? old.scope,
        abstract: op.abstract,
        body: op.body ?? old.body,
        ...(evidence === undefined ? {} : { evidence }),
        ...(until === undefined ? {} : { until }),
      },
      meta,
      at,
      old.rev + 1,
    );
    this.db
      .prepare(
        "UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
      )
      .run(id, at, op.id);
    this.revision(batchId, op.id, "supersede", old, this.get(op.id), at, meta.actor);
    this.revision(batchId, id, "add", undefined, this.get(id), at, meta.actor);
    return id;
  }

  private insert(
    r: {
      id: string;
      kind: MemoryKind;
      scope: string;
      abstract: string;
      body: string;
      evidence?: string;
      until?: string;
    },
    meta: WriteMeta,
    at: string,
    rev = 1,
  ): void {
    if (!MEMORY_KINDS.includes(r.kind)) throw new Error(`unknown memory kind "${r.kind}"`);
    const abstract = clip(redact(r.abstract, this.secrets), ABSTRACT_MAX_CHARS);
    if (abstract === "") throw new Error("a memory needs an abstract");
    this.db
      .prepare(
        "INSERT INTO memories(id, kind, scope, abstract, body, evidence, source, source_ref, until, status, rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
      )
      .run(
        r.id,
        r.kind,
        r.scope,
        abstract,
        clip(redact(r.body, this.secrets), BODY_MAX_CHARS),
        r.evidence === undefined ? null : redact(r.evidence, this.secrets),
        meta.source,
        meta.sourceRef ?? null,
        r.until ?? null,
        rev,
        at,
        at,
      );
  }

  private revision(
    batchId: string,
    memoryId: string,
    op: string,
    before: MemoryRow | undefined,
    after: MemoryRow | undefined,
    at: string,
    actor: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO memory_revisions(batch_id, memory_id, op, before_json, after_json, at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        batchId,
        memoryId,
        op,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
        at,
        actor,
      );
  }

  /** The owner deletes or brings back one entry from the app or Feishu. */
  setStatus(id: string, status: "active" | "deleted", actor = "owner"): string {
    const old = this.get(id);
    if (old === undefined) throw new Error(`no memory ${id}`);
    const batchId = randomUUID();
    const at = this.now().toISOString();
    this.db
      .prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, at, id);
    this.revision(
      batchId,
      id,
      status === "active" ? "restore" : "remove",
      old,
      this.get(id),
      at,
      actor,
    );
    return batchId;
  }

  /** Widens where an entry applies, e.g. a lesson seen in a second project becomes global. */
  setScope(id: string, scope: string): void {
    this.db
      .prepare("UPDATE memories SET scope = ?, updated_at = ? WHERE id = ?")
      .run(scope, this.now().toISOString(), id);
  }

  /** Puts every row a batch changed back the way it was. */
  undo(batchId: string): number {
    const revs = this.revisions({ batchId });
    if (revs.length === 0) throw new Error(`no memory change ${batchId}`);
    this.db.exec("BEGIN");
    try {
      for (const rev of [...revs].reverse()) {
        if (rev.before === undefined) {
          this.db.prepare("DELETE FROM memories WHERE id = ?").run(rev.memoryId);
          this.db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(rev.memoryId);
        } else {
          const b = rev.before;
          this.db
            .prepare(
              "UPDATE memories SET status = ?, superseded_by = ?, abstract = ?, body = ?, updated_at = ? WHERE id = ?",
            )
            .run(b.status, b.supersededBy ?? null, b.abstract, b.body, b.updatedAt, b.id);
        }
      }
      this.db.prepare("DELETE FROM memory_revisions WHERE batch_id = ?").run(batchId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return revs.length;
  }

  /** Changes, newest first: one entry's, one batch's, or the latest `limit`. */
  revisions(opts: { memoryId?: string; batchId?: string; limit?: number } = {}): MemoryRevision[] {
    const where =
      opts.memoryId !== undefined
        ? "WHERE memory_id = ?"
        : opts.batchId !== undefined
          ? "WHERE batch_id = ?"
          : "";
    const args = opts.memoryId ?? opts.batchId;
    const rows = this.db
      .prepare(
        `SELECT id, batch_id, memory_id, op, before_json, after_json, at, actor FROM memory_revisions ${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...(args === undefined ? [] : [args]), opts.limit ?? 200);
    return rows.map((r) => {
      const rev: MemoryRevision = {
        id: Number(r.id),
        batchId: String(r.batch_id),
        memoryId: String(r.memory_id),
        op: String(r.op),
        at: String(r.at),
        actor: String(r.actor),
      };
      if (typeof r.before_json === "string") rev.before = JSON.parse(r.before_json) as MemoryRow;
      if (typeof r.after_json === "string") rev.after = JSON.parse(r.after_json) as MemoryRow;
      return rev;
    });
  }

  /** Marks entries whose `until` has passed. */
  sweep(): number {
    const today = this.now().toISOString().slice(0, 10);
    const r = this.db
      .prepare(
        "UPDATE memories SET status = 'expired' WHERE status = 'active' AND until IS NOT NULL AND until < ?",
      )
      .run(today);
    return Number(r.changes);
  }

  /**
   * Active entries matching `query`, best first. Trigram FTS for words of 3+ characters, LIKE for
   * 2-character words, which trigrams cannot match.
   */
  search(query: string, opts: { kinds?: readonly MemoryKind[]; limit?: number } = {}): MemoryHit[] {
    this.sweep();
    const limit = opts.limit ?? 10;
    const kinds = opts.kinds ?? MEMORY_KINDS;
    const kindSql = `m.kind IN (${kinds.map(() => "?").join(", ")})`;
    const hits = new Map<string, MemoryHit>();
    const match = ftsQuery(query);
    if (match !== "") {
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS.split(", ")
            .map((c) => `m.${c}`)
            .join(
              ", ",
            )}, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid WHERE memories_fts MATCH ? AND m.status = 'active' AND ${kindSql} ORDER BY rank LIMIT ?`,
        )
        .all(match, ...kinds, limit * 2);
      for (const r of rows) hits.set(String(r.id), { ...toRow(r), score: -Number(r.rank) });
    }
    const words = shortWords(query);
    if (words.length > 0) {
      const like = words.map(() => "(m.abstract LIKE ? OR m.body LIKE ?)").join(" OR ");
      const rows = this.db
        .prepare(
          `SELECT ${COLUMNS.split(", ")
            .map((c) => `m.${c}`)
            .join(
              ", ",
            )} FROM memories m WHERE m.status = 'active' AND ${kindSql} AND (${like}) LIMIT ?`,
        )
        .all(...kinds, ...words.flatMap((w) => [`%${w}%`, `%${w}%`]), limit * 2);
      for (const r of rows) {
        const row = toRow(r);
        const text = `${row.abstract} ${row.body}`.toLowerCase();
        const n = words.filter((w) => text.includes(w)).length;
        const prev = hits.get(row.id);
        const score = (prev?.score ?? 0) + n * 0.5;
        hits.set(row.id, { ...row, score });
      }
    }
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Keyword search blended with vector similarity when `embedder` is ready: 0.7 cosine + 0.3
   * keyword rank scaled to the best keyword hit. Falls back to keywords alone. `minScore` drops
   * blended hits below it; keyword-only scores have no common scale, so it does not apply to them.
   */
  async searchHybrid(
    query: string,
    embedder: Embedder | undefined,
    opts: { kinds?: readonly MemoryKind[]; limit?: number; minScore?: number } = {},
  ): Promise<MemoryHit[]> {
    const limit = opts.limit ?? 10;
    const words = this.search(query, {
      ...(opts.kinds === undefined ? {} : { kinds: opts.kinds }),
      limit: limit * 3,
    });
    if (embedder === undefined || query.trim() === "") return words.slice(0, limit);
    let qv: Float32Array | undefined;
    try {
      qv = (await embedder.embed([query]))?.[0];
    } catch {
      qv = undefined;
    }
    if (qv === undefined) return words.slice(0, limit);
    const top = Math.max(...words.map((h) => h.score), 0);
    const scores = new Map<string, number>();
    for (const h of words) scores.set(h.id, (1 - VECTOR_WEIGHT) * (top > 0 ? h.score / top : 0));
    const sims = new Map<string, number>();
    for (const v of this.vectors(embedder.model, opts.kinds)) {
      sims.set(v.id, cosine(qv, v.vec));
    }
    for (const [id, sim] of sims) {
      if (!scores.has(id) && sim < VECTOR_ONLY_MIN) continue;
      scores.set(id, (scores.get(id) ?? 0) + VECTOR_WEIGHT * sim);
    }
    const byId = new Map(words.map((h) => [h.id, h] as const));
    const hits: MemoryHit[] = [];
    for (const [id, score] of [...scores].sort((a, b) => b[1] - a[1])) {
      if (opts.minScore !== undefined && score < opts.minScore) break;
      const row = byId.get(id) ?? this.get(id);
      if (row === undefined || row.status !== "active") continue;
      hits.push({ ...row, score });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Counts a use of entries the Herder was shown. */
  touch(ids: readonly string[]): void {
    const at = this.now().toISOString();
    const stmt = this.db.prepare(
      "UPDATE memories SET access_count = access_count + 1, last_access_at = ? WHERE id = ?",
    );
    for (const id of ids) stmt.run(at, id);
  }

  // --- vectors (filled by the host's embedder) ---

  setVector(id: string, model: string, vec: Float32Array): void {
    this.db
      .prepare("INSERT OR REPLACE INTO memory_vectors(memory_id, model, vec) VALUES (?, ?, ?)")
      .run(id, model, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  /** Vectors of active entries of `kinds` made with `model`. */
  vectors(
    model: string,
    kinds: readonly MemoryKind[] = MEMORY_KINDS,
  ): { id: string; vec: Float32Array }[] {
    const rows = this.db
      .prepare(
        `SELECT v.memory_id, v.vec FROM memory_vectors v JOIN memories m ON m.id = v.memory_id WHERE v.model = ? AND m.status = 'active' AND m.kind IN (${kinds.map(() => "?").join(", ")})`,
      )
      .all(model, ...kinds);
    return rows.map((r) => {
      const bytes = r.vec as Uint8Array;
      const copy = bytes.slice();
      return {
        id: String(r.memory_id),
        vec: new Float32Array(copy.buffer, 0, copy.byteLength / 4),
      };
    });
  }

  /** Active entries without a vector from `model`. */
  missingVectors(model: string): MemoryRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS.split(", ")
          .map((c) => `m.${c}`)
          .join(
            ", ",
          )} FROM memories m LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ? WHERE m.status = 'active' AND v.memory_id IS NULL`,
      )
      .all(model)
      .map(toRow);
  }

  // --- event log: what happened, never shown to the Herder by itself ---

  log(kind: string, text: string, ref?: string): void {
    this.db
      .prepare("INSERT INTO memory_log(at, kind, text, ref) VALUES (?, ?, ?, ?)")
      .run(this.now().toISOString(), kind, redact(clip(text, 4000), this.secrets), ref ?? null);
  }

  /** The newest log line of a kind. */
  lastLog(kind: string): MemoryLogRow | undefined {
    return this.logs(1, kind)[0];
  }

  logs(limit = 100, kind?: string): MemoryLogRow[] {
    return this.db
      .prepare(
        `SELECT id, at, kind, text, ref FROM memory_log ${kind === undefined ? "" : "WHERE kind = ?"} ORDER BY id DESC LIMIT ?`,
      )
      .all(...(kind === undefined ? [] : [kind]), limit)
      .map((r) => {
        const row: MemoryLogRow = {
          id: Number(r.id),
          at: String(r.at),
          kind: String(r.kind),
          text: String(r.text),
        };
        if (typeof r.ref === "string") row.ref = r.ref;
        return row;
      });
  }

  // --- background jobs (task-end cases, reviews) ---

  enqueueJob(kind: string, payload: Record<string, unknown>): number {
    const at = this.now().toISOString();
    const r = this.db
      .prepare(
        "INSERT INTO memory_jobs(kind, payload_json, state, next_at, created_at) VALUES (?, ?, 'pending', ?, ?)",
      )
      .run(kind, JSON.stringify(payload), at, at);
    return Number(r.lastInsertRowid);
  }

  /** The oldest pending job that is due, marked running. */
  claimJob(kind?: string): MemoryJob | undefined {
    const at = this.now().toISOString();
    const r = this.db
      .prepare(
        `SELECT id, kind, payload_json, attempts FROM memory_jobs WHERE state = 'pending' AND next_at <= ? ${kind === undefined ? "" : "AND kind = ?"} ORDER BY id LIMIT 1`,
      )
      .get(at, ...(kind === undefined ? [] : [kind]));
    if (r === undefined) return undefined;
    this.db.prepare("UPDATE memory_jobs SET state = 'running' WHERE id = ?").run(r.id as number);
    return {
      id: Number(r.id),
      kind: String(r.kind),
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
      attempts: Number(r.attempts),
    };
  }

  finishJob(id: number): void {
    this.db.prepare("UPDATE memory_jobs SET state = 'done', error = NULL WHERE id = ?").run(id);
  }

  /** Schedules the next try, or marks the job failed after the last. */
  failJob(id: number, error: string): void {
    const row = this.db.prepare("SELECT attempts FROM memory_jobs WHERE id = ?").get(id);
    const attempts = Number(row?.attempts ?? 0) + 1;
    const wait = JOB_RETRY_MS[attempts - 1];
    if (wait === undefined) {
      this.db
        .prepare("UPDATE memory_jobs SET state = 'failed', attempts = ?, error = ? WHERE id = ?")
        .run(attempts, error, id);
      return;
    }
    const next = new Date(this.now().getTime() + wait).toISOString();
    this.db
      .prepare(
        "UPDATE memory_jobs SET state = 'pending', attempts = ?, error = ?, next_at = ? WHERE id = ?",
      )
      .run(attempts, error, next, id);
  }

  /** Jobs left running by a stopped process go back to pending. */
  resetRunningJobs(): void {
    this.db.prepare("UPDATE memory_jobs SET state = 'pending' WHERE state = 'running'").run();
  }

  /** Puts a failed job back in the queue now. */
  retryJob(id: number): void {
    this.db
      .prepare(
        "UPDATE memory_jobs SET state = 'pending', attempts = 0, next_at = ? WHERE id = ? AND state = 'failed'",
      )
      .run(this.now().toISOString(), id);
  }

  jobs(
    limit = 50,
    kind?: string,
  ): (MemoryJob & { state: string; error?: string; createdAt: string })[] {
    return this.db
      .prepare(
        `SELECT id, kind, payload_json, attempts, state, error, created_at FROM memory_jobs ${kind === undefined ? "" : "WHERE kind = ?"} ORDER BY id DESC LIMIT ?`,
      )
      .all(...(kind === undefined ? [] : [kind]), limit)
      .map((r) => ({
        id: Number(r.id),
        kind: String(r.kind),
        payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
        attempts: Number(r.attempts),
        state: String(r.state),
        ...(typeof r.error === "string" ? { error: r.error } : {}),
        createdAt: String(r.created_at),
      }));
  }
}
