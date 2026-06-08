import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "./test-helpers";
import { runBreakdown } from "../linear/batch-create";
import { normalizeWatchConfig } from "../linear/types";

function tmpRepoWith(plan: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "devlog-breakdown-"));
  mkdirSync(join(dir, ".devlog"));
  writeFileSync(join(dir, ".devlog", "breakdown.json"), JSON.stringify(plan));
  return dir;
}

const stateIds = { trigger: "todo", inProgress: "prog", review: "rev", done: "done", parked: "back", parkedName: "Backlog", terminalNames: ["Done", "Canceled"] };
const teamAndLabels = { teamId: "team1", projectId: "proj1", labels: { claude: "lc", codex: "lx" } };
const parent = { id: "p1", identifier: "ARC-1", title: "Big REQ", description: "", stateName: "Todo", labels: ["design-breakdown"] };

function fakeClient(overrides: any = {}) {
  const calls: any = { created: [], relations: [], states: [], bodies: [] };
  let n = 0;
  const client = {
    fetchChildIssues: async () => overrides.existingChildren ?? [],
    createIssue: async (input: any) => { n++; const id = `c${n}`; calls.created.push({ id, input }); return { id, identifier: `ARC-${n + 1}` }; },
    createRelation: async (a: string, b: string) => { calls.relations.push([a, b]); },
    updateIssueBody: async (id: string, body: string) => { calls.bodies.push([id, body]); },
    updateState: async (id: string, s: string) => { calls.states.push([id, s]); },
    ...overrides.client,
  };
  return { client, calls };
}

test("runBreakdown creates subs, wires chain, sets states, stamps parent row", async () => {
  const db = makeTestDb();
  const repo = tmpRepoWith({ parentSummary: "rationale", subIssues: [
    { title: "Ledger", description: "d1", labels: ["claude"] },
    { title: "API", description: "d2", labels: ["codex"] },
  ] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client, calls } = fakeClient();

  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });
  assert.equal(res.ok, true);

  assert.equal(calls.created.length, 2);
  assert.equal(calls.created[0].input.stateId, "todo");
  assert.deepEqual(calls.created[0].input.labelIds, ["lc"]);
  assert.equal(calls.created[1].input.stateId, "back");
  assert.deepEqual(calls.created[1].input.labelIds, ["lx"]);
  assert.equal(calls.created[0].input.projectId, "proj1");
  assert.deepEqual(calls.relations, [["c1", "c2"]]);
  assert.deepEqual(calls.bodies, [["p1", "rationale"]]);
  assert.ok(calls.states.some(([id, s]: any) => id === "p1" && s === "prog"));
  const subs = db.prepare("SELECT child_issue_id, position FROM linear_breakdown_subs WHERE parent_issue_id='p1' ORDER BY position").all();
  assert.deepEqual(subs, [{ child_issue_id: "c1", position: 0 }, { child_issue_id: "c2", position: 1 }]);
  const prow: any = db.prepare("SELECT linear_issue_id, linear_breakdown_done_at FROM tasks WHERE linear_issue_id='p1'").get();
  assert.ok(prow && prow.linear_breakdown_done_at);
});

test("runBreakdown reuses an existing child by title (resumable, no duplicate)", async () => {
  const db = makeTestDb();
  const repo = tmpRepoWith({ parentSummary: "r", subIssues: [
    { title: "Ledger", description: "", labels: ["claude"] },
    { title: "API", description: "", labels: ["claude"] },
  ] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client, calls } = fakeClient({ existingChildren: [{ id: "old1", identifier: "ARC-2", title: "Ledger", stateName: "Backlog" }] });

  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });
  assert.equal(res.ok, true);
  assert.equal(calls.created.length, 1);
  const subs = db.prepare("SELECT child_issue_id FROM linear_breakdown_subs WHERE parent_issue_id='p1' ORDER BY position").all();
  assert.deepEqual(subs, [{ child_issue_id: "old1" }, { child_issue_id: "c1" }]);
});

test("runBreakdown returns error on malformed breakdown.json and stamps nothing", async () => {
  const db = makeTestDb();
  const dir = mkdtempSync(join(tmpdir(), "devlog-breakdown-"));
  mkdirSync(join(dir, ".devlog"));
  writeFileSync(join(dir, ".devlog", "breakdown.json"), "{bad");
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client } = fakeClient();
  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: dir, stateIds, teamAndLabels });
  assert.equal(res.ok, false);
  const prow = db.prepare("SELECT 1 FROM tasks WHERE linear_issue_id='p1'").get();
  assert.equal(prow, undefined);
});

test("runBreakdown is self-idempotent: a second call is a no-op", async () => {
  const db = makeTestDb();
  const repo = tmpRepoWith({ parentSummary: "r", subIssues: [{ title: "A", description: "", labels: ["claude"] }] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const first = fakeClient();
  await runBreakdown({ db, client: first.client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });

  const second = fakeClient();
  const res2 = await runBreakdown({ db, client: second.client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });
  assert.equal(res2.ok, true);
  assert.equal(second.calls.created.length, 0); // no new issues created
  const count: any = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE linear_issue_id='p1'").get();
  assert.equal(count.n, 1); // exactly one parent row, no duplicate
});

test("runBreakdown never applies the breakdown label to a created sub", async () => {
  const db = makeTestDb();
  // teamAndLabels maps the breakdown label too, to prove it's filtered out, not just unmapped
  const tl = { teamId: "team1", projectId: "proj1", labels: { claude: "lc", "design-breakdown": "lbd" } };
  const repo = tmpRepoWith({ parentSummary: "r", subIssues: [
    { title: "A", description: "", labels: ["claude", "design-breakdown"] },
  ] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client, calls } = fakeClient();
  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels: tl });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.created[0].input.labelIds, ["lc"]); // "lbd" (breakdown label id) excluded
});

test("runBreakdown rejects a breakdown.json whose parentIdentifier doesn't match", async () => {
  const db = makeTestDb();
  const repo = tmpRepoWith({ parentIdentifier: "ARC-999", parentSummary: "r", subIssues: [{ title: "A", description: "", labels: [] }] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client } = fakeClient();
  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });
  assert.equal(res.ok, false);
  const prow = db.prepare("SELECT 1 FROM tasks WHERE linear_issue_id='p1'").get();
  assert.equal(prow, undefined);
});
