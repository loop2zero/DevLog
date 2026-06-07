import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import { tick } from "../linear/poller";
import { normalizeWatchConfig } from "../linear/types";

const w = normalizeWatchConfig({ projectSlugId: "slug", devlogProjectId: "r" });
const mkIssue = (id: string) => ({ id, identifier: "ARC-" + id, title: "t", description: null, stateName: "Todo", labels: [] });

test("tick finalizes first, then dispatches each trigger issue exactly once across two ticks", async () => {
  const db = makeTestDb();
  const client: any = { async fetchTriggerIssues() { return [mkIssue("i1")]; } };
  const dispatched: string[] = [];
  let finalizeCalls = 0;
  const deps: any = {
    db, client, watch: w, stateIds: { inProgress: "IP", review: "RV" },
    onDispatch: async (iss: any) => { dispatched.push(iss.id); db.prepare("INSERT INTO tasks (id, project_id, title, status, linear_issue_id) VALUES (?,?,?,?,?)").run("t-" + iss.id, "r", "t", "in_progress", iss.id); },
    finalize: async () => { finalizeCalls++; },
  };
  await tick(deps);
  await tick(deps);
  assert.deepEqual(dispatched, ["i1"]); // dispatched once, not twice
  assert.equal(finalizeCalls, 2);       // finalize runs every tick
});

test("tick skips issues already linked to a task", async () => {
  const db = makeTestDb();
  db.prepare("INSERT INTO tasks (id, project_id, title, status, linear_issue_id) VALUES (?,?,?,?,?)").run("t0", "r", "t", "in_progress", "i1");
  const client: any = { async fetchTriggerIssues() { return [mkIssue("i1")]; } };
  const dispatched: string[] = [];
  const deps: any = { db, client, watch: w, stateIds: { inProgress: "IP", review: "RV" }, onDispatch: async (iss: any) => { dispatched.push(iss.id); }, finalize: async () => {} };
  await tick(deps);
  assert.equal(dispatched.length, 0);
});
