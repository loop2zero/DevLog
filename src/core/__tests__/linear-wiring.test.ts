import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnvStamp, resolveStateIds } from "../linear/wiring";
import { normalizeWatchConfig } from "../linear/types";

test("buildEnvStamp formats host:path@sha", () => {
  assert.equal(buildEnvStamp("host", "/p", "abc1234"), "host:/p@abc1234");
});

test("resolveStateIds maps In Progress + reviewState names to ids (case-insensitive)", async () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  const client = { async fetchWorkflowStates() { return [{ id: "ip", name: "In Progress" }, { id: "rv", name: "In Review" }, { id: "td", name: "Todo" }]; } };
  const ids = await resolveStateIds(client as any, w);
  assert.deepEqual(ids, { inProgress: "ip", review: "rv" });
});

test("resolveStateIds throws when a required state is missing", async () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  const client = { async fetchWorkflowStates() { return [{ id: "td", name: "Todo" }]; } };
  await assert.rejects(() => resolveStateIds(client as any, w));
});
