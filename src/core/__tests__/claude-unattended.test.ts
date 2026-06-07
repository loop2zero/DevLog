import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeProcessArgs } from "../process-manager";
import { resolveSessionRuntimeAuthConfig } from "../session-runtime-auth";

test("buildClaudeProcessArgs includes --dangerously-skip-permissions when unattended:true", () => {
  const config = resolveSessionRuntimeAuthConfig({
    local_cli_agent_id: "claude",
    unattended: true,
  });

  assert.equal(config.unattended, true);

  const args = buildClaudeProcessArgs(config, null, ["Read"]);
  assert.ok(
    args.includes("--dangerously-skip-permissions"),
    `Expected args to include --dangerously-skip-permissions, got: ${JSON.stringify(args)}`,
  );
});

test("buildClaudeProcessArgs omits --dangerously-skip-permissions when unattended:false", () => {
  const config = resolveSessionRuntimeAuthConfig({
    local_cli_agent_id: "claude",
    unattended: false,
  });

  assert.equal(config.unattended, false);

  const args = buildClaudeProcessArgs(config, null, ["Read"]);
  assert.ok(
    !args.includes("--dangerously-skip-permissions"),
    `Expected args to NOT include --dangerously-skip-permissions, got: ${JSON.stringify(args)}`,
  );
});

test("buildClaudeProcessArgs omits --dangerously-skip-permissions when unattended is absent", () => {
  const config = resolveSessionRuntimeAuthConfig({
    local_cli_agent_id: "claude",
  });

  assert.equal(config.unattended, false);

  const args = buildClaudeProcessArgs(config, null, ["Read"]);
  assert.ok(
    !args.includes("--dangerously-skip-permissions"),
    `Expected args to NOT include --dangerously-skip-permissions, got: ${JSON.stringify(args)}`,
  );
});

test("--dangerously-skip-permissions coexists with --input-format stream-json and --allowedTools", () => {
  const config = resolveSessionRuntimeAuthConfig({
    local_cli_agent_id: "claude",
    unattended: true,
  });

  const allowedTools = ["Read", "Glob", "Grep", "Bash", "Write", "Edit"];
  const args = buildClaudeProcessArgs(config, null, allowedTools);

  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--input-format"));
  assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  assert.ok(args.includes("--allowedTools"));
  for (const tool of allowedTools) {
    assert.ok(
      args.includes(tool),
      `Expected args to include tool "${tool}"`,
    );
  }
});

test("resolveSessionRuntimeAuthConfig carries unattended from input", () => {
  const configTrue = resolveSessionRuntimeAuthConfig({ unattended: true });
  const configFalse = resolveSessionRuntimeAuthConfig({ unattended: false });
  const configAbsent = resolveSessionRuntimeAuthConfig({});

  assert.equal(configTrue.unattended, true);
  assert.equal(configFalse.unattended, false);
  assert.equal(configAbsent.unattended, false);
});
