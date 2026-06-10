import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveEngine, assembleWorkpad, isTerminal } from "../linear/state-map";
import { normalizeWatchConfig } from "../linear/types";

const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });

test("resolveEngine: label beats default", () => {
  assert.equal(resolveEngine(["codex"], w), "codex");
  assert.equal(resolveEngine(["urgent"], w), "claude");
  assert.equal(resolveEngine([], w), "claude");
});
test("resolveEngine: conflicting engine labels -> default", () => {
  assert.equal(resolveEngine(["claude", "codex"], w), "claude");
});
test("resolveEngine: case-insensitive label match", () => {
  assert.equal(resolveEngine(["CODEX"], w), "codex");
});
test("assembleWorkpad: header + agent body", () => {
  const body = assembleWorkpad({ engine: "claude", branch: "b", state: "In Review", stamp: "h:/p@abc", pr: "https://x/pull/1", agentBody: "### Plan\n[x] done" });
  assert.ok(body.includes("In Review"));
  assert.ok(body.includes("engine: claude"));
  assert.ok(body.includes("https://x/pull/1"));
  assert.ok(body.includes("### Plan"));
});
test("assembleWorkpad: no agent body -> pending placeholder", () => {
  const body = assembleWorkpad({ engine: "codex", branch: "b", state: "In Progress", stamp: "s" });
  assert.ok(body.includes("pending"));
});
test("isTerminal", () => {
  assert.equal(isTerminal("Done", w), true);
  assert.equal(isTerminal("In Progress", w), false);
});

test("assembleWorkpad renders a stage line when provided", () => {
  const out = assembleWorkpad({ engine: "claude", branch: "b", state: "In Progress", stamp: "h:p@s", stage: "3/7 · running tests" });
  assert.match(out, /- stage: 3\/7 · running tests/);
  assert.ok(out.indexOf("- state:") < out.indexOf("- stage:"));
});

test("assembleWorkpad omits the stage line when absent", () => {
  const out = assembleWorkpad({ engine: "claude", branch: "b", state: "In Progress", stamp: "h:p@s" });
  assert.ok(!out.includes("- stage:"));
});
