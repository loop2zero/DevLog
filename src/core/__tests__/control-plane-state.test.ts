import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGateStatus } from "../control-plane-state";

test("parseGateStatus returns null for missing or malformed gate state", () => {
  assert.equal(parseGateStatus(null), null);
  assert.equal(parseGateStatus(""), null);
  assert.equal(parseGateStatus("not-json"), null);
  assert.equal(parseGateStatus(JSON.stringify({ id: "gate-1" })), null);
});

test("parseGateStatus normalizes a persisted gate status", () => {
  const gate = parseGateStatus(
    JSON.stringify({
      id: "gate-1",
      question: "Approve?",
      options: [" Yes ", "", 42, "No"],
      created_at: "2026-06-08T08:00:00.000Z",
      stage: "2/4 · review",
    }),
  );

  assert.deepEqual(gate, {
    id: "gate-1",
    question: "Approve?",
    options: ["Yes", "No"],
    created_at: "2026-06-08T08:00:00.000Z",
    stage: "2/4 · review",
  });
});
