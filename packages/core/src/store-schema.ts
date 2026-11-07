import { MEMORY_TABLES_SQL } from "./memory-store.ts";

// herd.db schema text and version. The Store applies it on open.

// Added in schema version 2 so databases created before plan 008 get the table too.
export const STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS state(
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

/** What the owner, the agent and its tools said in each task, for the app's task view. */
export const TRANSCRIPT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS transcript(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  tool_call_id TEXT,
  status TEXT
);
CREATE INDEX IF NOT EXISTS transcript_task ON transcript(task_id, id);`;

/** The Herder's conversation with the owner, searchable (docs/spec/08-herder-interaction.md §2). */
export const HERDER_TURNS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS herder_turns(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  task_id TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS herder_turns_fts USING fts5(
  text, content='herder_turns', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS herder_turns_ai AFTER INSERT ON herder_turns BEGIN
  INSERT INTO herder_turns_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS herder_turns_ad AFTER DELETE ON herder_turns BEGIN
  INSERT INTO herder_turns_fts(herder_turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;`;

/** Tasks the owner started, kept across restarts so they can be seen and continued (ADR 0039). */
export const TASKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project TEXT NOT NULL,
  cwd TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT,
  stage TEXT NOT NULL,
  last_report TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  ended_why TEXT,
  failed INTEGER NOT NULL DEFAULT 0,
  agent_session_id TEXT,
  automatic_decisions_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at);`;

/** Schema 7: where each task's agent works (ADR 0043). */
export const TASK_WORKSPACE_SQL = "ALTER TABLE tasks ADD COLUMN workspace_json TEXT;";

/** Schema 7: the task a message the owner can reply to is about (ADR 0043). */
export const MESSAGE_TASKS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS message_tasks(
  message_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  at TEXT NOT NULL
);`;

/**
 * Schema 8: the Herder's whole conversation as the model saw it, one message per row, oldest
 * first. Nothing is cut: old parts are folded into summaries the model writes (ADR 0045).
 */
export const HERDER_LOG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS herder_log(
  seq INTEGER PRIMARY KEY,
  message_json TEXT NOT NULL
);`;

/** Where the Herder kept the tail of its conversation before schema version 8. */
export const LEGACY_HERDER_STATE_KEY = "herder.messages";

/**
 * Schema 9: messages for the owner that are stored before they are sent and kept until the
 * channel took them (docs/spec/04-herder.md "Delivery").
 */
export const OUTBOX_TABLE_SQL = `CREATE TABLE IF NOT EXISTS outbox(
  id TEXT PRIMARY KEY,
  view_json TEXT NOT NULL,
  task_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  error TEXT
);`;

/** Schema 10: pull requests tasks opened, followed on GitHub (docs/spec/04-herder.md "Pull requests"). */
export const PR_WATCHES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pr_watches(
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

/** Schema 11: mail the owner asked to be told about (docs/spec/04-herder.md "Mail"). */
export const MAIL_WATCHES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mail_watches(
  id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;

export const LATEST_SCHEMA_VERSION = 11;

export const SCHEMA_SQL = `
CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE items(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  tool_call_json TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  risk TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  message_ref_json TEXT
);
CREATE TABLE decisions(
  item_id TEXT NOT NULL,
  action TEXT NOT NULL,
  text TEXT,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  risk TEXT NOT NULL,
  rule_id TEXT,
  owner_id TEXT,
  precedents_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE rules(
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  match_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL
);
${STATE_TABLE_SQL}
${TRANSCRIPT_TABLE_SQL}
${HERDER_TURNS_TABLE_SQL}
${MEMORY_TABLES_SQL}
${TASKS_TABLE_SQL}
${TASK_WORKSPACE_SQL}
${MESSAGE_TASKS_TABLE_SQL}
${HERDER_LOG_TABLE_SQL}
${OUTBOX_TABLE_SQL}
${PR_WATCHES_TABLE_SQL}
${MAIL_WATCHES_TABLE_SQL}
`;
