import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEnvStamp, resolveStateIds, isBreakdownIssue } from "../linear/wiring";
import { normalizeWatchConfig } from "../linear/types";

test("buildEnvStamp formats host:path@sha", () => {
  assert.equal(buildEnvStamp("host", "/p", "abc1234"), "host:/p@abc1234");
});

test("resolveStateIds maps trigger/inProgress/review/done/parked by name and type", async () => {
  const client = { fetchWorkflowStates: async () => [
    { id: "todo", name: "Todo", type: "unstarted" },
    { id: "prog", name: "In Progress", type: "started" },
    { id: "rev", name: "In Review", type: "started" },
    { id: "back", name: "Backlog", type: "backlog" },
    { id: "done", name: "Done", type: "completed" },
  ] };
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  const ids = await resolveStateIds(client as any, w);
  assert.equal(ids.trigger, "todo");
  assert.equal(ids.inProgress, "prog");
  assert.equal(ids.review, "rev");
  assert.equal(ids.done, "done");
  assert.equal(ids.parked, "back");
  assert.equal(ids.parkedName, "Backlog");
});

test("resolveStateIds throws when a required state is missing", async () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  const client = { async fetchWorkflowStates() { return [{ id: "td", name: "Todo" }]; } };
  await assert.rejects(() => resolveStateIds(client as any, w));
});

test("isBreakdownIssue matches the configured breakdown label case-insensitively", () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  assert.equal(isBreakdownIssue({ labels: ["Design-Breakdown"] } as any, w), true);
  assert.equal(isBreakdownIssue({ labels: ["claude"] } as any, w), false);
});
