import Database from "better-sqlite3";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb, insertTask } from "./test-helpers";
import { migrateControlPlaneColumns, migrateTasksV2, recoverOrphanedSessions } from "../db";

test("tasks.status accepts new in_queue and fail values", () => {
  const db = makeTestDb();
  const a = insertTask(db, { status: "in_queue" });
  const b = insertTask(db, { status: "fail" });
  const rows = db.prepare("SELECT id, status FROM tasks WHERE id IN (?, ?)").all(a, b) as Array<{ status: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.status).sort(), ["fail", "in_queue"]);
});

test("tasks.status rejects unknown values", () => {
  const db = makeTestDb();
  assert.throws(() => insertTask(db, { status: "bogus" }), /CHECK/);
});

test("tasks new columns exist with sensible defaults", () => {
  const db = makeTestDb();
  const id = insertTask(db, {});
  const row = db.prepare("SELECT blocked_by, sandbox_iterations, fail_reason FROM tasks WHERE id = ?").get(id) as {
    blocked_by: string | null;
    sandbox_iterations: number;
    fail_reason: string | null;
  };
  assert.equal(row.blocked_by, null);
  assert.equal(row.sandbox_iterations, 0);
  assert.equal(row.fail_reason, null);
});

test("tasks store control-plane stage and gate defaults", () => {
  const db = makeTestDb();
  const id = insertTask(db, {});
  const row = db.prepare("SELECT current_stage, gate_status FROM tasks WHERE id = ?").get(id) as {
    current_stage: string | null;
    gate_status: string | null;
  };

  assert.equal(row.current_stage, null);
  assert.equal(row.gate_status, null);
});

test("sessions store agent execution and runtime auth defaults", () => {
  const db = makeTestDb();
  const sessionId = "session-agent-defaults";

  db.prepare("INSERT INTO sessions (id, project_id, status) VALUES (?, ?, ?)").run(
    sessionId,
    "test",
    "running",
  );

  const row = db
    .prepare(
      "SELECT coding_agent_id, agent_team_id, session_auth_mode, agent_api_key_env_var, local_cli_agent_id, agent_model, agent_reasoning, agent_api_protocol, agent_api_version, agent_base_url, agent_max_tokens FROM sessions WHERE id = ?",
    )
    .get(sessionId) as {
    coding_agent_id: string;
    agent_team_id: string;
    session_auth_mode: string;
    agent_api_key_env_var: string | null;
    local_cli_agent_id: string;
    agent_model: string;
    agent_reasoning: string;
    agent_api_protocol: string;
    agent_api_version: string;
    agent_base_url: string;
    agent_max_tokens: number;
  };

  assert.equal(row.coding_agent_id, "general-coding-agent");
  assert.equal(row.agent_team_id, "implementation-review-team");
  assert.equal(row.session_auth_mode, "local-cli");
  assert.equal(row.agent_api_key_env_var, null);
  assert.equal(row.local_cli_agent_id, "claude");
  assert.equal(row.agent_model, "default");
  assert.equal(row.agent_reasoning, "medium");
  assert.equal(row.agent_api_protocol, "anthropic");
  assert.equal(row.agent_api_version, "");
  assert.equal(row.agent_base_url, "https://api.anthropic.com");
  assert.equal(row.agent_max_tokens, 8192);
});

test("sessions store control-plane stage and gate defaults", () => {
  const db = makeTestDb();
  const sessionId = "session-control-plane-defaults";

  db.prepare("INSERT INTO sessions (id, project_id, status) VALUES (?, ?, ?)").run(
    sessionId,
    "test",
    "running",
  );

  const row = db
    .prepare("SELECT current_stage, gate_status FROM sessions WHERE id = ?")
    .get(sessionId) as {
    current_stage: string | null;
    gate_status: string | null;
  };

  assert.equal(row.current_stage, null);
  assert.equal(row.gate_status, null);
});

test("migrateTasksV2 preserves data and adds new columns on legacy DB", () => {
  const db = new Database(":memory:");
  // Simulate the OLD schema (pre-1.1)
  db.exec(`
    CREATE TABLE tasks (
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    INSERT INTO tasks (id, title, status) VALUES ('legacy-1', 'pre-existing', 'in_progress');
  `);

  migrateTasksV2(db);

  // Data preserved
  const row = db.prepare("SELECT id, title, status, blocked_by, sandbox_iterations, fail_reason, current_stage, gate_status FROM tasks WHERE id = 'legacy-1'").get() as any;
  assert.equal(row.title, "pre-existing");
  assert.equal(row.status, "in_progress");
  assert.equal(row.blocked_by, null);
  assert.equal(row.sandbox_iterations, 0);
  assert.equal(row.fail_reason, null);
  assert.equal(row.current_stage, null);
  assert.equal(row.gate_status, null);

  // New status values now allowed
  db.prepare("INSERT INTO tasks (id, title, status) VALUES ('new-1', 't', 'in_queue')").run();
  const r2 = db.prepare("SELECT status FROM tasks WHERE id = 'new-1'").get() as any;
  assert.equal(r2.status, "in_queue");
});

test("migrateTasksV2 is idempotent", () => {
  const db = makeTestDb();          // already migrated schema
  migrateTasksV2(db);                // should be no-op
  migrateTasksV2(db);                // still no-op
  const id = insertTask(db, { status: "fail" });
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as any;
  assert.equal(row.status, "fail");
});

test("migrateControlPlaneColumns adds task and session gate columns on legacy DB", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo'
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'running'
    );
    INSERT INTO tasks (id, title, status) VALUES ('legacy-task', 'legacy task', 'todo');
    INSERT INTO sessions (id, status) VALUES ('legacy-session', 'running');
  `);

  migrateControlPlaneColumns(db);
  migrateControlPlaneColumns(db);

  const task = db
    .prepare("SELECT current_stage, gate_status FROM tasks WHERE id = 'legacy-task'")
    .get() as { current_stage: string | null; gate_status: string | null };
  const session = db
    .prepare("SELECT current_stage, gate_status FROM sessions WHERE id = 'legacy-session'")
    .get() as { current_stage: string | null; gate_status: string | null };

  assert.equal(task.current_stage, null);
  assert.equal(task.gate_status, null);
  assert.equal(session.current_stage, null);
  assert.equal(session.gate_status, null);
});

test("recoverOrphanedSessions preserves paused gated sessions", () => {
  const db = makeTestDb();
  const gateStatus = JSON.stringify({
    id: "gate-1",
    question: "Continue?",
    options: ["Continue"],
    created_at: "2026-06-08T08:00:00.000Z",
    stage: "2/3 approval",
  });
  db.prepare(
    "INSERT INTO sessions (id, project_id, status, pid, gate_status) VALUES ('gated', 'test', 'paused', 99999999, ?)",
  ).run(gateStatus);
  db.prepare(
    "INSERT INTO sessions (id, project_id, status, pid) VALUES ('orphaned', 'test', 'running', 99999999)",
  ).run();

  recoverOrphanedSessions(db);

  const gated = db
    .prepare("SELECT status, gate_status FROM sessions WHERE id = 'gated'")
    .get() as { status: string; gate_status: string | null };
  const orphaned = db
    .prepare("SELECT status FROM sessions WHERE id = 'orphaned'")
    .get() as { status: string };

  assert.equal(gated.status, "paused");
  assert.equal(gated.gate_status, gateStatus);
  assert.equal(orphaned.status, "failed");
});
