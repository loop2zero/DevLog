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
    db, client, watch: w, stateIds: { trigger: "t", inProgress: "ip", review: "rv", done: "d", parked: "b", parkedName: "Backlog" },
    onDispatch: async (iss: any) => { dispatched.push(iss.id); db.prepare("INSERT INTO tasks (id, project_id, title, status, linear_issue_id) VALUES (?,?,?,?,?)").run("t-" + iss.id, "r", "t", "in_progress", iss.id); },
    finalize: async () => { finalizeCalls++; },
    reconcile: async () => {},
    relay: async () => {},
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
  const deps: any = { db, client, watch: w, stateIds: { trigger: "t", inProgress: "ip", review: "rv", done: "d", parked: "b", parkedName: "Backlog" }, onDispatch: async (iss: any) => { dispatched.push(iss.id); }, finalize: async () => {}, reconcile: async () => {}, relay: async () => {} };
  await tick(deps);
  assert.equal(dispatched.length, 0);
});

test("tick calls reconcile each cycle", async () => {
  const db = makeTestDb();
  let reconciled = 0;
  await tick({
    db,
    client: { fetchTriggerIssues: async () => [] },
    watch: normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" }),
    onDispatch: async () => {},
    finalize: async () => {},
    reconcile: async () => { reconciled++; },
    relay: async () => {},
    stateIds: { trigger: "t", inProgress: "ip", review: "rv", done: "d", parked: "b", parkedName: "Backlog", terminalNames: ["Done", "Canceled"] },
  });
  assert.equal(reconciled, 1);
});

test("tick runs finalize → reconcile → relay → dispatch in order", async () => {
  const calls: string[] = [];
  const db = makeTestDb();
  await tick({
    db,
    client: { fetchTriggerIssues: async () => { calls.push("fetch"); return []; } } as any,
    watch: normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" }),
    onDispatch: async () => { calls.push("dispatch"); },
    finalize: async () => { calls.push("finalize"); },
    reconcile: async () => { calls.push("reconcile"); },
    relay: async () => { calls.push("relay"); },
    stateIds: { trigger: "t", inProgress: "p", review: "r", done: "d", parked: "b", parkedName: "Backlog", terminalNames: [] },
  });
  assert.deepEqual(calls, ["finalize", "reconcile", "relay", "fetch"]);
});
