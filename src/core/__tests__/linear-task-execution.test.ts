import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngineExecuteInput } from "../task-execution";
import {
  getSessionRuntimeAuthInputFromPayload,
  resolveSessionRuntimeAuthConfig,
} from "../session-runtime-auth";

test("buildEngineExecuteInput maps engine -> local_cli_agent_id", () => {
  assert.equal(buildEngineExecuteInput("codex").local_cli_agent_id, "codex");
  assert.equal(buildEngineExecuteInput("claude").local_cli_agent_id, "claude");
});

test("buildEngineExecuteInput payload resolves to the chosen engine end-to-end", () => {
  for (const engine of ["claude", "codex"] as const) {
    const input = getSessionRuntimeAuthInputFromPayload(
      buildEngineExecuteInput(engine),
    );
    const cfg = resolveSessionRuntimeAuthConfig(input);
    assert.equal(
      cfg.localCliAgentId,
      engine,
      `engine "${engine}" did not propagate through payload → resolveSessionRuntimeAuthConfig`,
    );
  }
  // Explicitly verify codex !== claude so the test is not vacuously true
  const claudeCfg = resolveSessionRuntimeAuthConfig(
    getSessionRuntimeAuthInputFromPayload(buildEngineExecuteInput("claude")),
  );
  const codexCfg = resolveSessionRuntimeAuthConfig(
    getSessionRuntimeAuthInputFromPayload(buildEngineExecuteInput("codex")),
  );
  assert.notEqual(claudeCfg.localCliAgentId, codexCfg.localCliAgentId);
});
