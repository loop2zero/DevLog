import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWatchConfig } from "../linear/types";

test("normalizeWatchConfig fills defaults", () => {
  const w = normalizeWatchConfig({ projectSlugId: "abc", devlogProjectId: "repo1" });
  assert.equal(w.triggerState, "Todo");
  assert.equal(w.reviewState, "In Review");
  assert.ok(w.terminalStates.includes("Done"));
  assert.equal(w.defaultEngine, "claude");
  assert.deepEqual(w.labelEngineMap, { claude: "claude", codex: "codex" });
});

test("normalizeWatchConfig keeps explicit values", () => {
  const w = normalizeWatchConfig({ projectSlugId: "abc", devlogProjectId: "r", triggerState: "Ready", defaultEngine: "codex" });
  assert.equal(w.triggerState, "Ready");
  assert.equal(w.defaultEngine, "codex");
});
