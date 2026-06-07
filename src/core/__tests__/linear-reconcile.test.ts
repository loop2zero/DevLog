import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReconcile } from "../linear/reconcile";

const opts = { terminalStates: ["Done", "Canceled"], parkedState: "Backlog" };

test("advances the sub whose predecessor just went Done", () => {
  const r = computeReconcile(["Done", "Backlog", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, [1]);
  assert.equal(r.closeParent, false);
});

test("does not advance a sub whose predecessor is not terminal", () => {
  const r = computeReconcile(["In Review", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, []);
});

test("does not re-advance a sub already moved off parked", () => {
  const r = computeReconcile(["Done", "Todo", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, []);
});

test("never advances index 0", () => {
  const r = computeReconcile(["Backlog", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, []);
});

test("closes parent when all subs terminal", () => {
  const r = computeReconcile(["Done", "Done", "Canceled"], opts);
  assert.equal(r.closeParent, true);
  assert.deepEqual(r.advanceIndexes, []);
});

test("empty list does not close parent", () => {
  const r = computeReconcile([], opts);
  assert.equal(r.closeParent, false);
});

test("tolerates null states (unreadable) as non-terminal, non-parked", () => {
  const r = computeReconcile(["Done", null], opts);
  assert.deepEqual(r.advanceIndexes, []);
  assert.equal(r.closeParent, false);
});
