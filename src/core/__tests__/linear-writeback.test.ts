import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeOutcome } from "../linear/writeback";
import { normalizeWatchConfig } from "../linear/types";

const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
const ctx = (over: any = {}) => ({
  client: { calls: [] as any[], async updateState(id: string, s: string) { this.calls.push(["state", id, s]); }, async updateComment(id: string, b: string) { this.calls.push(["comment", id, b]); } },
  reviewStateId: "REVIEW", commentId: "c1", issueId: "i1", branch: "b", engine: "claude" as const, stamp: "h:/p@a",
  detectPr: async () => "https://x/pull/9", readWorkpad: async () => "### Plan\n[x] ok", ...over,
});

test("completed + PR -> In Review + workpad body relayed", async () => {
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
