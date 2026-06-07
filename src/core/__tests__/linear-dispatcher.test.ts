import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import { dispatchIssue, alreadyLinked } from "../linear/dispatcher";
import { normalizeWatchConfig } from "../linear/types";

const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
const issue = { id: "i1", identifier: "ARC-1", title: "do x", description: "body", stateName: "Todo", labels: ["codex"] };

test("dispatchIssue creates a mirror task with linkage + chosen engine, calls execute once", async () => {
  const db = makeTestDb();
  const calls: any[] = [];
  const fakeExecute = async (taskId: string, projectId: string, payload: any) => { calls.push({ taskId, projectId, payload }); return { ok: true } as any; };
  await dispatchIssue(db, issue, w, fakeExecute);
  const row: any = db.prepare("SELECT * FROM tasks WHERE linear_issue_id = ?").get("i1");
  assert.equal(row.title, "do x");
  assert.equal(row.linear_identifier, "ARC-1");
  assert.equal(row.project_id, "repo1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.local_cli_agent_id, "codex"); // flat payload -> engine
  assert.equal(calls[0].projectId, "repo1");
});

test("dispatch is idempotent: alreadyLinked true, no double execute", async () => {
  const db = makeTestDb();
  const calls: any[] = [];
  const fakeExecute = async () => { calls.push(1); return { ok: true } as any; };
  await dispatchIssue(db, issue, w, fakeExecute);
  assert.equal(alreadyLinked(db, "i1"), true);
  await dispatchIssue(db, issue, w, fakeExecute);
  assert.equal(calls.length, 1);
});

test("engine defaults to watch.defaultEngine when no engine label", async () => {
  const db = makeTestDb();
  const calls: any[] = [];
  const fakeExecute = async (_t: string, _p: string, payload: any) => { calls.push(payload); return { ok: true } as any; };
  await dispatchIssue(db, { ...issue, id: "i2", labels: ["urgent"] }, w, fakeExecute);
  assert.equal(calls[0].local_cli_agent_id, "claude");
});
