import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import { reconcileBreakdowns } from "../linear/reconcile";
import { normalizeWatchConfig } from "../linear/types";

const stateIds = { trigger: "todo", inProgress: "prog", review: "rev", done: "done", parked: "back", parkedName: "Backlog" };

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
