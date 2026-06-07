import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWatchConfig } from "../linear/types";
import { resolveEngine } from "../linear/state-map";

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

test("normalizeWatchConfig normalizes labelEngineMap keys (trim + lowercase)", () => {
  const w = normalizeWatchConfig({
    projectSlugId: "abc",
    devlogProjectId: "r",
    labelEngineMap: { "CODEX ": "codex", " Claude": "claude" },
  });
  // Keys should be lowercased and trimmed
  assert.equal(w.labelEngineMap["codex"], "codex");
  assert.equal(w.labelEngineMap["claude"], "claude");
  // Original cased keys should NOT be present
  assert.equal(w.labelEngineMap["CODEX "], undefined);
  assert.equal(w.labelEngineMap[" Claude"], undefined);
});

test("normalizeWatchConfig labelEngineMap normalization: resolveEngine matches lowercased label", () => {
  const w = normalizeWatchConfig({
    projectSlugId: "abc",
    devlogProjectId: "r",
    labelEngineMap: { "CODEX ": "codex" },
  });
  // resolveEngine already lowercases+trims labels, so after key normalization it should match
  assert.equal(resolveEngine(["codex"], w), "codex");
  assert.equal(resolveEngine(["CODEX"], w), "codex");
  assert.equal(resolveEngine(["Codex"], w), "codex");
});
