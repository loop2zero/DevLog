import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTestDb } from "./test-helpers";
import { migrateLinearColumns } from "../db";

test("migrateLinearColumns adds linear linkage columns to a bare tasks table", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT)");
  migrateLinearColumns(db);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("linear_issue_id"));
  assert.ok(cols.includes("linear_identifier"));
  assert.ok(cols.includes("linear_workpad_comment_id"));
});

test("migrateLinearColumns is idempotent", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT)");
  migrateLinearColumns(db);
  assert.doesNotThrow(() => migrateLinearColumns(db));
});

test("fresh SCHEMA db (makeTestDb) already has the linear columns", () => {
  const db = makeTestDb();
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("linear_issue_id"));
  assert.ok(cols.includes("linear_identifier"));
  assert.ok(cols.includes("linear_workpad_comment_id"));
});
