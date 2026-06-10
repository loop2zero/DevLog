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
  relayGates,
  pollGateReplies,
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

const GATE_G1 = JSON.stringify({ id: "g1", question: "Approve the plan?", options: ["Approve", "Revise"], created_at: "t0", stage: "2/4" });

test("relayGates posts exactly one gate comment per gate id and records it", async () => {
  const db = makeTestDb();
  seedLinked(db, { gate: GATE_G1, stage: "2/4" });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /\[g1\]/);
  assert.match(deps.creates[0], /1\. Approve/);
  assert.equal(deps.updates.length, 1);
  assert.match(deps.updates[0][1], /AWAITING INPUT/);
  const row: any = db.prepare("SELECT linear_gate_comment_id, linear_gate_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_comment_id, "cm-1");
  assert.equal(row.linear_gate_id, "g1");
  const reg: any = db.prepare("SELECT kind FROM linear_relay_comments WHERE comment_id='cm-1'").get();
  assert.equal(reg.kind, "gate");
  await relayGates(deps);
  assert.equal(deps.creates.length, 1);
  assert.equal(deps.updates.length, 1);
});

test("relayGates posts a NEW comment when core overwrote the gate with a new id", async () => {
  const db = makeTestDb();
  seedLinked(db, { gate: GATE_G1 });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  const g2 = JSON.stringify({ id: "g2", question: "Second question?", options: [], created_at: "t1", stage: null });
  db.prepare("UPDATE tasks SET gate_status = ? WHERE id='t1'").run(g2);
  await relayGates(deps);
  // Fix C: a supersede receipt is posted for the old gate before the new gate comment,
  // so there are 3 creates: cm-1 (g1 gate), cm-2 (supersede receipt), cm-3 (g2 gate).
  assert.equal(deps.creates.length, 3);
  assert.match(deps.creates[1], /resolved elsewhere/); // supersede receipt
  assert.match(deps.creates[2], /\[g2\]/);             // new gate
  const row: any = db.prepare("SELECT linear_gate_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_id, "g2");
});

test("relayGates skips rows with unparseable gate_status", async () => {
  const db = makeTestDb();
  seedLinked(db, { gate: "not-json" });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  assert.equal(deps.creates.length, 0);
});

function seedPendingGate(db: any) {
  const ids = seedLinked(db, { gate: GATE_G1, stage: "2/4" });
  db.prepare("UPDATE tasks SET linear_gate_comment_id='cm-gate', linear_gate_id='g1' WHERE id='t1'").run();
  db.prepare("INSERT OR IGNORE INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('cm-gate','iss1','gate')").run();
  return ids;
}

const GATE_COMMENT = { id: "cm-gate", body: "gate body", createdAt: "2026-06-10T01:00:00.000Z" };

test("pollGateReplies resolves once from the first human reply and posts a receipt", async () => {
  const db = makeTestDb();
  const { sid } = seedPendingGate(db);
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  (deps.client as any).fetchComments = async () => [
    GATE_COMMENT,
    { id: "cm-human", body: "2", createdAt: "2026-06-10T02:00:00.000Z" },
  ];
  await pollGateReplies(deps);
  assert.deepEqual(resolved, [[sid, "Revise"]]);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /✅ GATE resolved/);
  const row: any = db.prepare("SELECT linear_gate_comment_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_comment_id, null);
  const receiptRegistered: any = db.prepare("SELECT 1 FROM linear_relay_comments WHERE comment_id='cm-1'").get();
  assert.ok(receiptRegistered);
});

test("pollGateReplies ignores watch-created comments and earlier comments", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('cm-wp','iss1','workpad')").run();
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  (deps.client as any).fetchComments = async () => [
    { id: "cm-earlier", body: "pre-gate human note", createdAt: "2026-06-10T00:30:00.000Z" },
    GATE_COMMENT,
    { id: "cm-wp", body: "workpad refresh", createdAt: "2026-06-10T01:30:00.000Z" },
  ];
  await pollGateReplies(deps);
  assert.equal(resolved.length, 0);
  assert.equal(deps.creates.length, 0);
});

test("pollGateReplies handles resolved-elsewhere without calling resolveGate", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  db.prepare("UPDATE tasks SET gate_status = NULL WHERE id='t1'").run();
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  await pollGateReplies(deps);
  assert.equal(resolved.length, 0);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /resolved elsewhere/);
  const row: any = db.prepare("SELECT linear_gate_comment_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_comment_id, null);
  await pollGateReplies(deps);
  assert.equal(deps.creates.length, 1);
});

test("pollGateReplies treats a resolveGate failure as resolved-elsewhere", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  const deps = makeRelayDeps(db, {
    resolveGate: () => ({ ok: false as const, error: "no pending gate" }),
  });
  (deps.client as any).fetchComments = async () => [
    GATE_COMMENT,
    { id: "cm-human", body: "Approve", createdAt: "2026-06-10T02:00:00.000Z" },
  ];
  await pollGateReplies(deps);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /resolved elsewhere/);
});

// Fix A: sorted reply selection — comments returned newest-first, two human replies
// after the gate, should resolve against the EARLIEST one (02:00 "2" = "Revise").
test("pollGateReplies picks the earliest human reply even when API returns newest-first", async () => {
  const db = makeTestDb();
  const { sid } = seedPendingGate(db);
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  // API returns newest-first: 03:00 "free text", then 02:00 "2" (="Revise"), gate comment last
  (deps.client as any).fetchComments = async () => [
    { id: "cm-human-b", body: "free text", createdAt: "2026-06-10T03:00:00.000Z" },
    { id: "cm-human-a", body: "2", createdAt: "2026-06-10T02:00:00.000Z" },
    GATE_COMMENT, // createdAt: 01:00
  ];
  await pollGateReplies(deps);
  // After sorting ascending: gate(01:00) < cm-human-a(02:00) < cm-human-b(03:00)
  // First reply after gate is cm-human-a "2" → "Revise"
  assert.deepEqual(resolved, [[sid, "Revise"]]);
});

// Fix C: supersede stale gate comment when core overwrites gate_status with a new id.
test("relayGates posts a supersede receipt for the old gate before posting the new gate", async () => {
  const db = makeTestDb();
  // Start with g1 already relayed and a pending gate comment
  seedLinked(db, { gate: GATE_G1 });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  // Now core overwrites with g2, old gate comment (cm-1) is still pending
  const g2 = JSON.stringify({ id: "g2", question: "New question?", options: [], created_at: "t1", stage: null });
  db.prepare("UPDATE tasks SET gate_status = ? WHERE id='t1'").run(g2);
  await relayGates(deps);
  // Should have: cm-1 (g1 gate), cm-2 (supersede receipt for g1), cm-3 (g2 gate)
  assert.equal(deps.creates.length, 3);
  assert.match(deps.creates[1], /resolved elsewhere/); // supersede receipt for g1
  assert.match(deps.creates[2], /\[g2\]/);             // new gate for g2
  const row: any = db.prepare("SELECT linear_gate_id, linear_gate_comment_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_id, "g2");
  assert.equal(row.linear_gate_comment_id, "cm-3");
});

// Fix D: self-heal when gate comment is missing from fetchComments result.
test("pollGateReplies reposts the gate comment when it is not found in fetched comments", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });

  // Tick 1: gate comment cm-gate is absent — only an unrelated human comment is returned.
  (deps.client as any).fetchComments = async () => [
    { id: "cm-unrelated", body: "some note", createdAt: "2026-06-10T00:30:00.000Z" },
  ];
  await pollGateReplies(deps);
  // Should repost the gate comment (one create), no resolve call.
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /\[g1\]/);
  assert.equal(resolved.length, 0);
  // DB should now have the new gate comment id.
  const row: any = db.prepare("SELECT linear_gate_comment_id FROM tasks WHERE id='t1'").get();
  const newGateCmId = row.linear_gate_comment_id;
  assert.ok(newGateCmId);
  assert.notEqual(newGateCmId, "cm-gate");

  // Tick 2: fetchComments now returns the newly posted gate comment + a human reply.
  const T1 = "2026-06-10T02:00:00.000Z";
  (deps.client as any).fetchComments = async () => [
    { id: newGateCmId, body: "gate body", createdAt: "2026-06-10T01:30:00.000Z" },
    { id: "cm-reply", body: "Approve", createdAt: T1 },
  ];
  await pollGateReplies(deps);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0][1], "Approve");
  assert.equal(deps.creates.length, 2); // repost + receipt
});
