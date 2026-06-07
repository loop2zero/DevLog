import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateLinearColumns, migrateBreakdownTable } from "../db";
import { makeTestDb } from "./test-helpers";

test("migrateLinearColumns adds linear_breakdown_done_at to a bare tasks table", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
  migrateLinearColumns(db);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("linear_breakdown_done_at"));
});

test("migrateBreakdownTable creates linear_breakdown_subs and is idempotent", () => {
  const db = new Database(":memory:");
  migrateBreakdownTable(db);
  migrateBreakdownTable(db); // second call must not throw
  db.prepare(
    "INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES ('p','c','ARC-2',1)",
  ).run();
  const row: any = db.prepare("SELECT * FROM linear_breakdown_subs WHERE child_issue_id='c'").get();
  assert.equal(row.position, 1);
  assert.equal(row.parent_issue_id, "p");
});

test("fresh SCHEMA db already has the breakdown column and table", () => {
  const db = makeTestDb();
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("linear_breakdown_done_at"));
  assert.doesNotThrow(() =>
    db.prepare("SELECT COUNT(*) FROM linear_breakdown_subs").get(),
  );
});
