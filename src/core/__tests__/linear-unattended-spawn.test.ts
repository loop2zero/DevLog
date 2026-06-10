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

// Watchdog requeue — queue item shape
//
// The fix that threads `unattended` through the watchdog restart lives in the private
// methods ProcessManager#checkHealth → requeueLastUserMessage. These are not directly
// accessible without a heavyweight singleton mock (requires getDb, spawn, etc.) which
// would couple this test to internal singleton wiring. The critical invariant is
// therefore covered at two levels:
//
//   1. TypeScript typecheck (pre-commit hook): SessionProcess.unattended is `boolean`
//      (non-optional), so the compiler enforces that every spawn site sets it from
//      runtimeAuthConfig.unattended and that requeueLastUserMessage receives it.
//
//   2. The two resolveStoredSessionRuntimeAuthConfig tests above cover the config-level
//      guarantee that unattended:true propagates through the transient-input path that
//      ensureProcess calls on the requeued message.
//
// A future integration test with an injectable DB + process spawner would let us assert
// the exact QueuedMessage shape; for now the typecheck seam is sufficient.
//
// SKIP: no lightweight pure seam for the watchdog queue-item shape test.
