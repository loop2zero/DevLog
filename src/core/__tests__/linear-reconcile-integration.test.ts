import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import { reconcileBreakdowns } from "../linear/reconcile";
import { normalizeWatchConfig } from "../linear/types";

const stateIds = { trigger: "todo", inProgress: "prog", review: "rev", done: "done", parked: "back", parkedName: "Backlog", terminalNames: ["Done", "Canceled"] };

function seedParent(db: any, parentId: string, subs: Array<{ id: string; pos: number }>) {
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, status, linear_issue_id, linear_breakdown_done_at, created_at, updated_at) VALUES (?, 'repo1', 't', 'in_progress', ?, datetime('now'), datetime('now'), datetime('now'))",
  ).run("task-" + parentId, parentId);
  for (const s of subs) {
    db.prepare(
      "INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES (?, ?, ?, ?)",
    ).run(parentId, s.id, "X", s.pos);
  }
}

test("advances the next sub when its predecessor is Done", async () => {
  const db = makeTestDb();
  seedParent(db, "p1", [{ id: "c1", pos: 0 }, { id: "c2", pos: 1 }]);
  const states: Record<string, string> = { c1: "Done", c2: "Backlog" };
  const moves: any[] = [];
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  await reconcileBreakdowns({
    db, w, stateIds,
    client: {
      fetchStateNameByIssue: async (id: string) => states[id] ?? null,
      updateState: async (id: string, s: string) => { moves.push([id, s]); },
    } as any,
  });
  assert.deepEqual(moves, [["c2", "todo"]]);
});

test("closes the parent and finalizes it when all subs terminal", async () => {
  const db = makeTestDb();
  seedParent(db, "p2", [{ id: "c1", pos: 0 }, { id: "c2", pos: 1 }]);
  const states: Record<string, string> = { c1: "Done", c2: "Done" };
  const moves: any[] = [];
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  await reconcileBreakdowns({
    db, w, stateIds,
    client: {
      fetchStateNameByIssue: async (id: string) => states[id] ?? null,
      updateState: async (id: string, s: string) => { moves.push([id, s]); },
    } as any,
  });
  assert.ok(moves.some(([id, s]) => id === "p2" && s === "done"));
  const row: any = db.prepare("SELECT linear_finalized_at FROM tasks WHERE linear_issue_id='p2'").get();
  assert.ok(row.linear_finalized_at);
});

test("reconcileBreakdowns treats a completed-type state as terminal even if its name isn't in config", async () => {
  const db = makeTestDb();
  db.prepare("INSERT INTO tasks (id, project_id, title, status, linear_issue_id, linear_breakdown_done_at, created_at, updated_at) VALUES ('t','repo1','x','in_progress','P', datetime('now'), datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES ('P','c1','X',0)").run();
  db.prepare("INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES ('P','c2','X',1)").run();
  const states: Record<string, string> = { c1: "Shipped", c2: "Backlog" }; // "Shipped" NOT in default terminalStates config
  const moves: any[] = [];
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  // terminalNames includes "Shipped" (type completed); parkedName "Backlog"; trigger "todo"
  const sids = { trigger: "todo", inProgress: "prog", review: "rev", done: "done", parked: "back", parkedName: "Backlog", terminalNames: ["Shipped", "Done"] };
  await reconcileBreakdowns({ db, w, stateIds: sids, client: { fetchStateNameByIssue: async (id: string) => states[id] ?? null, updateState: async (id: string, s: string) => { moves.push([id, s]); } } as any });
  assert.deepEqual(moves, [["c2", "todo"]]); // c2 advanced because c1's "Shipped" counts as terminal
});

test("skips a parent already finalized", async () => {
  const db = makeTestDb();
  seedParent(db, "p3", [{ id: "c1", pos: 0 }]);
  db.prepare("UPDATE tasks SET linear_finalized_at = datetime('now') WHERE linear_issue_id='p3'").run();
  let called = 0;
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  await reconcileBreakdowns({
    db, w, stateIds,
    client: { fetchStateNameByIssue: async () => { called++; return "Done"; }, updateState: async () => {} } as any,
  });
  assert.equal(called, 0);
});
