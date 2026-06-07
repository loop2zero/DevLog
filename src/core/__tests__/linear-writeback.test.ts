import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeOutcome } from "../linear/writeback";
import { normalizeWatchConfig } from "../linear/types";

const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
const ctx = (over: any = {}) => ({
  client: {
    calls: [] as any[],
    async updateState(id: string, s: string) { this.calls.push(["state", id, s]); },
    async updateComment(id: string, b: string) { this.calls.push(["comment", id, b]); },
  },
  reviewStateId: "REVIEW",
  commentId: "c1",
  issueId: "i1",
  branch: "b",
  engine: "claude" as const,
  stamp: "h:/p@a",
  currentState: "In Progress",
  detectPr: async () => "https://x/pull/9",
  readWorkpad: async () => "### Plan\n[x] ok",
  ...over,
});

// --- return value assertions ---

test("completed + PR -> returns 'review'", async () => {
  const c = ctx();
  const result = await finalizeOutcome("completed", c as any, w);
  assert.equal(result, "review");
});

test("idle + PR -> returns 'review' (idle treated same as completed)", async () => {
  const c = ctx();
  const result = await finalizeOutcome("idle", c as any, w);
  assert.equal(result, "review");
});

test("failed -> returns 'blocked'", async () => {
  const c = ctx({ detectPr: async () => "" });
  const result = await finalizeOutcome("failed", c as any, w);
  assert.equal(result, "blocked");
});

test("killed -> returns 'blocked'", async () => {
  const c = ctx({ detectPr: async () => "" });
  const result = await finalizeOutcome("killed", c as any, w);
  assert.equal(result, "blocked");
});

test("completed but no PR -> returns 'blocked'", async () => {
  const c = ctx({ detectPr: async () => "" });
  const result = await finalizeOutcome("completed", c as any, w);
  assert.equal(result, "blocked");
});

test("idle but no PR -> returns 'blocked'", async () => {
  const c = ctx({ detectPr: async () => "" });
  const result = await finalizeOutcome("idle", c as any, w);
  assert.equal(result, "blocked");
});

// --- terminal-state guard (FIX 2 / skipped path) ---

test("currentState is a terminal state -> returns 'skipped', no client calls", async () => {
  const c = ctx({ currentState: "Done" });
  const result = await finalizeOutcome("completed", c as any, w);
  assert.equal(result, "skipped");
  assert.equal(c.client.calls.length, 0);
});

test("currentState 'Canceled' -> returns 'skipped', no client calls", async () => {
  const c = ctx({ currentState: "Canceled" });
  const result = await finalizeOutcome("failed", c as any, w);
  assert.equal(result, "skipped");
  assert.equal(c.client.calls.length, 0);
});

test("skipped path: detectPr is never called when terminal", async () => {
  let prCalled = false;
  const c = ctx({ currentState: "Done", detectPr: async () => { prCalled = true; return ""; } });
  await finalizeOutcome("completed", c as any, w);
  assert.equal(prCalled, false);
});

// --- side-effect assertions (unchanged behaviour) ---

test("completed + PR -> In Review state set + workpad body relayed", async () => {
  const c = ctx();
  await finalizeOutcome("completed", c as any, w);
  assert.ok(c.client.calls.some((x: any) => x[0] === "state" && x[1] === "i1" && x[2] === "REVIEW"));
  const comment = c.client.calls.find((x: any) => x[0] === "comment");
  assert.ok(comment[2].includes("In Review"));
  assert.ok(comment[2].includes("### Plan"));
  assert.ok(comment[2].includes("https://x/pull/9"));
});

test("failed -> stays In Progress, BLOCKED note, NO state change", async () => {
  const c = ctx({ detectPr: async () => "" });
  await finalizeOutcome("failed", c as any, w);
  assert.equal(c.client.calls.find((x: any) => x[0] === "state"), undefined);
  assert.ok(c.client.calls.find((x: any) => x[0] === "comment")[2].includes("BLOCKED"));
});

test("completed but no PR -> BLOCKED, no In Review", async () => {
  const c = ctx({ detectPr: async () => "" });
  await finalizeOutcome("completed", c as any, w);
  assert.equal(c.client.calls.find((x: any) => x[0] === "state"), undefined);
  assert.ok(c.client.calls.find((x: any) => x[0] === "comment")[2].includes("BLOCKED"));
});

test("readWorkpad throwing is tolerated (still finalizes)", async () => {
  const c = ctx({ readWorkpad: async () => { throw new Error("no file"); } });
  await finalizeOutcome("completed", c as any, w);
  assert.ok(c.client.calls.some((x: any) => x[0] === "state" && x[2] === "REVIEW"));
});
