import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTestDb } from "./test-helpers";
import { migrateLinearColumns, migrateRelayCommentsTable } from "../db";

function taskCols(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
}

test("fresh SCHEMA db has the relay columns and registry table", () => {
  const db = makeTestDb();
  const cols = taskCols(db);
  for (const c of ["linear_relayed_stage", "linear_gate_comment_id", "linear_gate_id"]) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
  db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('c1','i1','gate')").run();
  const row: any = db.prepare("SELECT * FROM linear_relay_comments WHERE comment_id='c1'").get();
  assert.equal(row.issue_id, "i1");
  assert.ok(row.created_at);
});

test("migrateLinearColumns adds relay columns to a bare legacy tasks table", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT,
    created_at TEXT, updated_at TEXT)`);
  migrateLinearColumns(db);
  const cols = taskCols(db);
  for (const c of ["linear_issue_id", "linear_relayed_stage", "linear_gate_comment_id", "linear_gate_id"]) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
  migrateLinearColumns(db); // idempotent
});

test("migrateRelayCommentsTable is idempotent and PK-deduped", () => {
  const db = new Database(":memory:");
  migrateRelayCommentsTable(db);
  migrateRelayCommentsTable(db);
  db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('c1','i1','gate')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('c1','i2','receipt')").run(),
  );
});
