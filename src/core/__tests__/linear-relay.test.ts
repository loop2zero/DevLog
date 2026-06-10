import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import {
  normalizeGateReply,
  buildGateCommentBody,
  buildGateReceiptBody,
  registerRelayComment,
  isRelayComment,
  relayStages,
  type RelayDeps,
} from "../linear/relay";
import { normalizeWatchConfig } from "../linear/types";

const OPTS = ["Approve", "Revise plan"];

test("normalizeGateReply maps an option number to the option text", () => {
  assert.equal(normalizeGateReply("2", OPTS), "Revise plan");
  assert.equal(normalizeGateReply(" 1 ", OPTS), "Approve");
});

test("normalizeGateReply matches options case-insensitively", () => {
  assert.equal(normalizeGateReply("approve", OPTS), "Approve");
  assert.equal(normalizeGateReply("REVISE PLAN", OPTS), "Revise plan");
});

test("normalizeGateReply passes free text through verbatim (trimmed)", () => {
  assert.equal(normalizeGateReply("  Approve, but verify on staging first  ", OPTS), "Approve, but verify on staging first");
  assert.equal(normalizeGateReply("9", OPTS), "9");
  assert.equal(normalizeGateReply("2", []), "2");
});

test("buildGateCommentBody contains gate id, question, numbered options, stage", () => {
  const body = buildGateCommentBody({ id: "gate_1", question: "Approve the migration plan?", options: OPTS, created_at: "t", stage: "2/4 · plan review" });
  assert.match(body, /⚠️ GATE/);
  assert.match(body, /\[gate_1\]/);
  assert.match(body, /Approve the migration plan\?/);
  assert.match(body, /1\. Approve/);
  assert.match(body, /2\. Revise plan/);
  assert.match(body, /2\/4 · plan review/);
});

test("buildGateReceiptBody distinguishes linear-delivered vs resolved-elsewhere", () => {
  const a = buildGateReceiptBody("gate_1", "Approve", "linear");
  assert.match(a, /✅ GATE resolved/);
  assert.match(a, /Approve/);
  const b = buildGateReceiptBody("gate_1", "", "elsewhere");
  assert.match(b, /resolved elsewhere/);
});

test("registry: registerRelayComment is idempotent and isRelayComment discriminates", () => {
  const db = makeTestDb();
  registerRelayComment(db, "cm1", "i1", "gate");
  registerRelayComment(db, "cm1", "i1", "gate");
  assert.equal(isRelayComment(db, "cm1"), true);
  assert.equal(isRelayComment(db, "cm-human"), false);
});

function seedLinked(db: any, opts: { taskId?: string; issue?: string; stage?: string | null; relayed?: string | null; gate?: string | null } = {}) {
  const taskId = opts.taskId ?? "t1";
  const sid = `s-${taskId}`;
  db.prepare(
    `INSERT INTO sessions (id, project_id, status, branch_name, worktree_path, local_cli_agent_id)
     VALUES (?, 'repo1', 'running', 'feat/x', '/tmp/wt', 'claude')`,
  ).run(sid);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, session_id, linear_issue_id, linear_workpad_comment_id, current_stage, linear_relayed_stage, gate_status, created_at, updated_at)
     VALUES (?, 'repo1', 'x', 'in_progress', ?, ?, 'wp-comment', ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(taskId, sid, opts.issue ?? "iss1", opts.stage ?? null, opts.relayed ?? null, opts.gate ?? null);
  return { taskId, sid };
}

function makeRelayDeps(db: any, over: Partial<RelayDeps> = {}): RelayDeps & { updates: any[]; creates: any[] } {
  const updates: any[] = [];
  const creates: any[] = [];
  return {
    db,
    w: normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" }),
    client: {
      updateComment: async (id: string, body: string) => { updates.push([id, body]); },
      createComment: async (_issueId: string, body: string) => { creates.push(body); return `cm-${creates.length}`; },
      fetchComments: async () => [],
    },
    resolveGate: () => ({ ok: true as const }),
    readWorkpadFile: async () => "narrative from file",
    updates,
    creates,
    ...over,
  } as any;
}

test("relayStages refreshes the workpad once when stage changed, then stamps", async () => {
  const db = makeTestDb();
  seedLinked(db, { stage: "3/7 · tests", relayed: null });
  const deps = makeRelayDeps(db);
  await relayStages(deps);
  assert.equal(deps.updates.length, 1);
  assert.equal(deps.updates[0][0], "wp-comment");
  assert.match(deps.updates[0][1], /- stage: 3\/7 · tests/);
  assert.match(deps.updates[0][1], /narrative from file/);
  const row: any = db.prepare("SELECT linear_relayed_stage FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_relayed_stage, "3/7 · tests");
  await relayStages(deps);
  assert.equal(deps.updates.length, 1);
});

test("relayStages shows AWAITING INPUT while a gate is pending", async () => {
  const db = makeTestDb();
  const gate = JSON.stringify({ id: "g1", question: "ok?", options: [], created_at: "t", stage: null });
  seedLinked(db, { stage: "2/4", gate });
  const deps = makeRelayDeps(db);
  await relayStages(deps);
  assert.match(deps.updates[0][1], /AWAITING INPUT/);
});

test("relayStages tolerates a failing workpad file read", async () => {
  const db = makeTestDb();
  seedLinked(db, { stage: "1/2" });
  const deps = makeRelayDeps(db, { readWorkpadFile: async () => { throw new Error("no file"); } });
  await relayStages(deps);
  assert.equal((deps as any).updates.length, 1);
});

test("relayStages skips finalized and stage-null rows", async () => {
  const db = makeTestDb();
  seedLinked(db, { taskId: "t-null", stage: null });
  const { taskId } = seedLinked(db, { taskId: "t-fin", issue: "iss2", stage: "9/9" });
  db.prepare("UPDATE tasks SET linear_finalized_at = datetime('now') WHERE id = ?").run(taskId);
  const deps = makeRelayDeps(db);
  await relayStages(deps);
  assert.equal((deps as any).updates.length, 0);
});
