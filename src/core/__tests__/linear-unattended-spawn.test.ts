import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStoredSessionRuntimeAuthConfig } from "../session-runtime-auth";

// Regression: the spawn path uses resolveStoredSessionRuntimeAuthConfig (stored DB
// row + transient input). `unattended` is never persisted on the row, so it must
// be carried from the transient input here — otherwise autonomous Claude sessions
// fall back to interactive permission prompts and hang (produce nothing).
test("resolveStoredSessionRuntimeAuthConfig carries unattended from transient input", () => {
  const cfg = resolveStoredSessionRuntimeAuthConfig(
    { local_cli_agent_id: "claude" },
    { unattended: true },
  );
  assert.equal(cfg.unattended, true);
});

test("resolveStoredSessionRuntimeAuthConfig defaults unattended to false", () => {
  const cfg = resolveStoredSessionRuntimeAuthConfig(
    { local_cli_agent_id: "claude" },
    {},
  );
  assert.equal(cfg.unattended, false);
});
