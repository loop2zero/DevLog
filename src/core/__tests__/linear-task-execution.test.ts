import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEngineExecuteInput } from "../task-execution";

test("buildEngineExecuteInput maps engine -> local_cli_agent_id", () => {
  assert.equal(buildEngineExecuteInput("codex").runtimeAuthInput.local_cli_agent_id, "codex");
  assert.equal(buildEngineExecuteInput("claude").runtimeAuthInput.local_cli_agent_id, "claude");
});
