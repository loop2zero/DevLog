import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { SCHEMA } from "./db-schema";
import {
  DEFAULT_AGENT_TEAM_ID,
  DEFAULT_CODING_AGENT_ID,
} from "./agent-presets";
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_SESSION_AUTH_MODE,
} from "./session-runtime-auth";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_API_MAX_TOKENS,
  DEFAULT_API_PROTOCOL,
} from "./agent-settings";
import {
  DEFAULT_LOCAL_CLI_AGENT_ID,
  DEFAULT_LOCAL_CLI_REASONING,
} from "./local-cli-agent-definitions";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "devlog.db");

let _db: Database.Database | null = null;
let _recovered = false;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "logs"), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(SCHEMA);
  migrateTasksV2(_db);
  migrateControlPlaneColumns(_db);

  // Migrate: add claude_session_id column if missing
  try {
    _db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
  } catch {
    // Column already exists
  }

  // Migrate: update CHECK constraint to include 'idle' status
  // SQLite can't alter CHECK constraints, so recreate the table if needed
  try {
    _db.exec("UPDATE sessions SET status = 'idle' WHERE status = 'idle'");
  } catch {
    // CHECK constraint fails — need to recreate table
    _db.exec(`
      CREATE TABLE IF NOT EXISTS sessions_new (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        worktree_name TEXT, worktree_path TEXT, branch_name TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','idle','paused','completed','failed','killed')),
        claude_command TEXT, claude_session_id TEXT,
        coding_agent_id TEXT NOT NULL DEFAULT '${DEFAULT_CODING_AGENT_ID}',
        agent_team_id TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_TEAM_ID}',
        session_auth_mode TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_AUTH_MODE}',
        agent_api_key_env_var TEXT,
        local_cli_agent_id TEXT NOT NULL DEFAULT '${DEFAULT_LOCAL_CLI_AGENT_ID}',
        agent_model TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_MODEL}',
        agent_reasoning TEXT NOT NULL DEFAULT '${DEFAULT_LOCAL_CLI_REASONING}',
        agent_api_protocol TEXT NOT NULL DEFAULT '${DEFAULT_API_PROTOCOL}',
        agent_api_version TEXT NOT NULL DEFAULT '',
        agent_base_url TEXT NOT NULL DEFAULT '${DEFAULT_API_BASE_URL}',
        agent_max_tokens INTEGER NOT NULL DEFAULT ${DEFAULT_API_MAX_TOKENS},
        current_stage TEXT,
        gate_status TEXT,
        prompt TEXT,
        exit_code INTEGER, log_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT
      );
      INSERT OR IGNORE INTO sessions_new (
        id, task_id, worktree_name, worktree_path, branch_name, pid, status,
        claude_command, claude_session_id, prompt, exit_code, log_path,
        started_at, ended_at
      )
      SELECT id, task_id, worktree_name, worktree_path, branch_name, pid, status,
        claude_command, claude_session_id, prompt, exit_code, log_path,
        started_at, ended_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
    `);
  }

  // Migrate: add project_id columns if missing
  for (const table of ["tasks", "sessions", "file_locks"]) {
    try {
      _db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT 'videoclaw'`);
    } catch {
      // Column already exists
    }
  }

  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN coding_agent_id TEXT NOT NULL DEFAULT '${DEFAULT_CODING_AGENT_ID}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN agent_team_id TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_TEAM_ID}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN session_auth_mode TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_AUTH_MODE}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec("ALTER TABLE sessions ADD COLUMN agent_api_key_env_var TEXT");
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN local_cli_agent_id TEXT NOT NULL DEFAULT '${DEFAULT_LOCAL_CLI_AGENT_ID}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN agent_model TEXT NOT NULL DEFAULT '${DEFAULT_AGENT_MODEL}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN agent_reasoning TEXT NOT NULL DEFAULT '${DEFAULT_LOCAL_CLI_REASONING}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN agent_api_protocol TEXT NOT NULL DEFAULT '${DEFAULT_API_PROTOCOL}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec("ALTER TABLE sessions ADD COLUMN agent_api_version TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN agent_base_url TEXT NOT NULL DEFAULT '${DEFAULT_API_BASE_URL}'`,
    );
  } catch {
    // Column already exists
  }
  try {
    _db.exec(
      `ALTER TABLE sessions ADD COLUMN agent_max_tokens INTEGER NOT NULL DEFAULT ${DEFAULT_API_MAX_TOKENS}`,
    );
  } catch {
    // Column already exists
  }
  migrateControlPlaneColumns(_db);

  // Migrate: update tasks CHECK constraint to include 'review' and 'blocked'
  try {
    _db.exec("UPDATE tasks SET status = 'review' WHERE status = 'review'");
  } catch {
    // CHECK constraint fails — recreate table with expanded constraint
    _db.exec(`
      CREATE TABLE IF NOT EXISTS tasks_new (
        id TEXT PRIMARY KEY DEFAULT (hex(randomblob(8))),
        project_id TEXT NOT NULL DEFAULT 'videoclaw',
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'review', 'blocked', 'done')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
        worktree_name TEXT,
        session_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        prompt TEXT,
        current_stage TEXT,
        gate_status TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      INSERT OR IGNORE INTO tasks_new SELECT * FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(status, sort_order);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
    `);
  }

  // Recover orphaned sessions on first access
  if (!_recovered) {
    _recovered = true;
    recoverOrphanedSessions(_db);
  }

  // FIX 5: migrateLinearColumns must run LAST — after all table-recreation migrations
  // (tasks_new, sessions_new) — so the linear columns are never dropped by a later
  // CREATE TABLE … tasks_new / DROP TABLE tasks sequence.
  migrateLinearColumns(_db);
  migrateBreakdownTable(_db);
  migrateRelayCommentsTable(_db);

  return _db;
}

export function migrateLinearColumns(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("linear_issue_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_issue_id TEXT");
  if (!cols.includes("linear_identifier")) db.exec("ALTER TABLE tasks ADD COLUMN linear_identifier TEXT");
  if (!cols.includes("linear_workpad_comment_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_workpad_comment_id TEXT");
  if (!cols.includes("linear_finalized_at")) db.exec("ALTER TABLE tasks ADD COLUMN linear_finalized_at TEXT");
  if (!cols.includes("linear_breakdown_done_at")) db.exec("ALTER TABLE tasks ADD COLUMN linear_breakdown_done_at TEXT");
  if (!cols.includes("linear_relayed_stage")) db.exec("ALTER TABLE tasks ADD COLUMN linear_relayed_stage TEXT");
  if (!cols.includes("linear_gate_comment_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_gate_comment_id TEXT");
  if (!cols.includes("linear_gate_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_gate_id TEXT");
}

export function migrateRelayCommentsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS linear_relay_comments (
    comment_id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

export function migrateBreakdownTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS linear_breakdown_subs (
    parent_issue_id TEXT NOT NULL,
    child_issue_id TEXT NOT NULL,
    child_identifier TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_issue_id, position),
    UNIQUE(parent_issue_id, child_issue_id)
  )`);
}

export function migrateTasksV2(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const has = (n: string) => cols.some(c => c.name === n);

  if (!has("blocked_by")) {
    db.exec("ALTER TABLE tasks ADD COLUMN blocked_by TEXT");
  }
  if (!has("sandbox_iterations")) {
    db.exec("ALTER TABLE tasks ADD COLUMN sandbox_iterations INTEGER NOT NULL DEFAULT 0");
  }
  if (!has("fail_reason")) {
    db.exec("ALTER TABLE tasks ADD COLUMN fail_reason TEXT");
  }
  if (!has("current_stage")) {
    db.exec("ALTER TABLE tasks ADD COLUMN current_stage TEXT");
  }
  if (!has("gate_status")) {
    db.exec("ALTER TABLE tasks ADD COLUMN gate_status TEXT");
  }

  // Status CHECK widening: SQLite cannot ALTER CHECK; recreate the table only if old CHECK is detected.
  const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string } | undefined;
  if (stmt && (!stmt.sql.includes("'in_queue'") || !stmt.sql.includes("'fail'"))) {
    db.exec(`
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY DEFAULT (hex(randomblob(8))),
        project_id TEXT NOT NULL DEFAULT 'videoclaw',
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_queue', 'in_progress', 'review', 'blocked', 'fail', 'done')),
        priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
        worktree_name TEXT,
        session_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        prompt TEXT,
        blocked_by TEXT,
        sandbox_iterations INTEGER NOT NULL DEFAULT 0,
        fail_reason TEXT,
        current_stage TEXT,
        gate_status TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
      INSERT INTO tasks_new (id, project_id, title, description, status, priority, worktree_name, session_id, sort_order, prompt, blocked_by, sandbox_iterations, fail_reason, current_stage, gate_status, created_at, updated_at, completed_at)
      SELECT id, project_id, title, description, status, priority, worktree_name, session_id, sort_order, prompt, blocked_by, sandbox_iterations, fail_reason, current_stage, gate_status, created_at, updated_at, completed_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(status, sort_order);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
    `);
  }
}

export function migrateControlPlaneColumns(db: Database.Database): void {
  for (const table of ["tasks", "sessions"]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const has = (name: string) => cols.some((col) => col.name === name);

    if (!has("current_stage")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN current_stage TEXT`);
    }
    if (!has("gate_status")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN gate_status TEXT`);
    }
  }
}

export function recoverOrphanedSessions(db: Database.Database): void {
  const orphaned = db
    .prepare(
      "SELECT id, pid, status, gate_status FROM sessions WHERE status IN ('running', 'idle', 'paused', 'pending')",
    )
    .all() as {
      id: string;
      pid: number | null;
      status: string;
      gate_status: string | null;
    }[];

  for (const session of orphaned) {
    let alive = false;
    if (session.pid) {
      try {
        process.kill(session.pid, 0); // Check if process exists
        alive = true;
      } catch {
        alive = false;
      }
    }

    if (!alive) {
      if (session.status === "paused" && session.gate_status) {
        continue;
      }
      db.prepare(
        "UPDATE sessions SET status = 'failed', ended_at = datetime('now') WHERE id = ?"
      ).run(session.id);
    }
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Graceful shutdown
function shutdown() {
  try {
    // Import processManager dynamically to avoid circular deps
    const { processManager } = require("./process-manager");
    processManager.killAll();
  } catch {
    // process-manager might not be loaded
  }
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
