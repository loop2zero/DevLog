import Database from "better-sqlite3";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA } from "../db-schema";
import {
  applyControlPlaneEvent,
  parseControlPlaneProtocolText,
  resolveControlPlaneGate,
} from "../control-plane-protocol";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

test("parseControlPlaneProtocolText extracts stage markers and hides protocol text", () => {
  const parsed = parseControlPlaneProtocolText(
    'before\n[DEVLOG_STAGE] {"stage":"3/7","desc":"running tests"}\nafter',
  );

  assert.equal(parsed.text, "before\nafter");
  assert.deepEqual(parsed.events, [
    {
      type: "stage",
      current_stage: "3/7 · running tests",
    },
  ]);
});

test("parseControlPlaneProtocolText extracts gate markers with normalized options", () => {
  const parsed = parseControlPlaneProtocolText(
    '[DEVLOG_GATE] {"question":"Approve plan?","options":["Approve","Revise"],"stage":"2/4 · review"}',
  );

  assert.equal(parsed.text, "");
  assert.deepEqual(parsed.events, [
    {
      type: "gate",
      question: "Approve plan?",
      options: ["Approve", "Revise"],
      stage: "2/4 · review",
    },
  ]);
});

test("parseControlPlaneProtocolText keeps malformed markers as visible output", () => {
  const text = "[DEVLOG_STAGE] not-json";
  const parsed = parseControlPlaneProtocolText(text);

  assert.equal(parsed.text, text);
  assert.deepEqual(parsed.events, []);
});

test("applyControlPlaneEvent updates session and linked task state", () => {
  const db = makeDb();
  db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('task-1', 'test', 'Task')").run();
  db.prepare(
    "INSERT INTO sessions (id, project_id, task_id, status) VALUES ('session-1', 'test', 'task-1', 'running')",
  ).run();

  applyControlPlaneEvent(db, "session-1", {
    type: "stage",
    current_stage: "1/3 · plan",
  });
  const stageSession = db
    .prepare("SELECT current_stage, gate_status FROM sessions WHERE id = 'session-1'")
    .get() as { current_stage: string | null; gate_status: string | null };
  const stageTask = db
    .prepare("SELECT current_stage, gate_status FROM tasks WHERE id = 'task-1'")
    .get() as { current_stage: string | null; gate_status: string | null };

  assert.equal(stageSession.current_stage, "1/3 · plan");
  assert.equal(stageTask.current_stage, "1/3 · plan");
  assert.equal(stageSession.gate_status, null);
  assert.equal(stageTask.gate_status, null);

  const applied = applyControlPlaneEvent(
    db,
    "session-1",
    {
      type: "gate",
      question: "Ship it?",
      options: ["Yes", "No"],
    },
    {
      now: () => new Date("2026-06-08T08:00:00.000Z"),
      createId: () => "gate-test",
    },
  );

  assert.equal(applied?.taskId, "task-1");
  assert.deepEqual(applied?.gateStatus, {
    id: "gate-test",
    question: "Ship it?",
    options: ["Yes", "No"],
    created_at: "2026-06-08T08:00:00.000Z",
    stage: "1/3 · plan",
  });

  const gateSession = db
    .prepare("SELECT current_stage, gate_status FROM sessions WHERE id = 'session-1'")
    .get() as { current_stage: string | null; gate_status: string | null };
  const gateTask = db
    .prepare("SELECT current_stage, gate_status FROM tasks WHERE id = 'task-1'")
    .get() as { current_stage: string | null; gate_status: string | null };

  assert.equal(gateSession.current_stage, "1/3 · plan");
  assert.equal(gateTask.current_stage, "1/3 · plan");
  assert.equal(gateSession.gate_status, JSON.stringify(applied?.gateStatus));
  assert.equal(gateTask.gate_status, JSON.stringify(applied?.gateStatus));
});

test("resolveControlPlaneGate clears gate state without clearing current stage", () => {
  const db = makeDb();
  db.prepare("INSERT INTO tasks (id, project_id, title) VALUES ('task-1', 'test', 'Task')").run();
  db.prepare(
    "INSERT INTO sessions (id, project_id, task_id, status) VALUES ('session-1', 'test', 'task-1', 'paused')",
  ).run();
  const applied = applyControlPlaneEvent(
    db,
    "session-1",
    {
      type: "gate",
      question: "Continue?",
      options: ["Continue"],
      stage: "2/3 · approval",
    },
    {
      now: () => new Date("2026-06-08T08:00:00.000Z"),
      createId: () => "gate-test",
    },
  );
  assert.ok(applied?.gateStatus);

  const resolved = resolveControlPlaneGate(db, "session-1");

  assert.deepEqual(resolved?.gateStatus, applied.gateStatus);
  const session = db
    .prepare("SELECT current_stage, gate_status FROM sessions WHERE id = 'session-1'")
    .get() as { current_stage: string | null; gate_status: string | null };
  const task = db
    .prepare("SELECT current_stage, gate_status FROM tasks WHERE id = 'task-1'")
    .get() as { current_stage: string | null; gate_status: string | null };

  assert.equal(session.current_stage, "2/3 · approval");
  assert.equal(task.current_stage, "2/3 · approval");
  assert.equal(session.gate_status, null);
  assert.equal(task.gate_status, null);
});
