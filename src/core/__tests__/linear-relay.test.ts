import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import {
  normalizeGateReply,
  buildGateCommentBody,
  buildGateReceiptBody,
  registerRelayComment,
  isRelayComment,
} from "../linear/relay";

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
