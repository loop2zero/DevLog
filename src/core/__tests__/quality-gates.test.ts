import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const repoRoot = new URL("../../../", import.meta.url);

function readRepoFile(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

test("package scripts define the shared DevLog quality gates", () => {
  const pkg = JSON.parse(readRepoFile("package.json"));

  assert.equal(pkg.scripts.prepare, "husky");
  assert.equal(
    pkg.scripts["quality:precommit"],
    "git diff --cached --check && bun run typecheck && TZ=Asia/Shanghai bun run test",
  );
  assert.equal(
    pkg.scripts["quality:build"],
    "bun run build:web && bun run build:cli",
  );
  assert.equal(
    pkg.scripts["quality:ci"],
    "bun run typecheck && TZ=Asia/Shanghai bun run test && bun run quality:build",
  );
  assert.equal(pkg.scripts.quality, "bun run quality:ci");
});

test("Husky pre-commit hook runs the shared pre-commit gate", () => {
  const hookPath = new URL(".husky/pre-commit", repoRoot);
  const hook = readFileSync(hookPath, "utf8");
  const mode = statSync(hookPath).mode;

  assert.match(hook, /bun run quality:precommit/);
  assert.equal(mode & 0o111, 0o111);
});

test("session insert route SQL has one value expression per column", () => {
  const routes = [
    "src/app/api/sessions/route.ts",
    // execute logic moved to src/core/task-execution.ts (shared with Linear dispatcher)
    "src/core/task-execution.ts",
    "src/app/api/tasks/[id]/retry/route.ts",
  ];

  for (const route of routes) {
    const source = readRepoFile(route);
    const match = source.match(
      /INSERT INTO sessions \(([\s\S]*?)\)\s+VALUES \(([\s\S]*?)\)\s+RETURNING \*/m,
    );
    assert.ok(match, `${route} should contain a sessions insert`);

    const columns = match[1]
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    const valueExpressions = match[2]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    assert.equal(
      valueExpressions.length,
      columns.length,
      `${route} session insert must keep columns and VALUES in sync`,
    );
  }
});

test("generic task and session launch copy is not hard-coded to Claude Code", () => {
  const genericLaunchSurfaces = [
    "src/components/sessions/launch-dialog.tsx",
    "src/components/kanban/task-detail-dialog.tsx",
  ];

  for (const route of genericLaunchSurfaces) {
    const source = readRepoFile(route);
    assert.doesNotMatch(
      source,
      /Claude Code|What should Claude|Claude will/,
      `${route} should describe the selected coding agent generically`,
    );
  }
});

test("task and session runtime dispatch waits for browser settings to load", () => {
  const runtimeDispatchSurfaces = [
    "src/components/kanban/board.tsx",
    "src/components/kanban/task-detail-dialog.tsx",
    "src/components/kanban/task-review-panel.tsx",
    "src/components/sessions/launch-dialog.tsx",
    "src/hooks/use-session-chat.ts",
  ];

  for (const route of runtimeDispatchSurfaces) {
    const source = readRepoFile(route);
    assert.match(
      source,
      /useAgentSettings\(\)[\s\S]*loaded|loaded[\s\S]*useAgentSettings\(\)/,
      `${route} must read the agent settings loaded flag before dispatching runtime payload`,
    );
    assert.match(
      source,
      /settingsReady|runtimeReady/,
      `${route} must gate runtime dispatch on loaded settings plus runtime readiness`,
    );
  }
});

test("dashboard task quick view forwards runtime payload from the detail dialog", () => {
  const source = readRepoFile("src/components/dashboard/task-quick-view.tsx");

  assert.match(
    source,
    /agentConfig\?: \{[\s\S]*SessionRuntimeAuthInput/,
    "dashboard quick task launcher must accept the runtime payload supplied by TaskDetailDialog",
  );
  assert.match(
    source,
    /promptOverride\?: string/,
    "dashboard quick task launcher must accept the edited prompt supplied by TaskDetailDialog",
  );
  assert.match(
    source,
    /\.\.\.agentConfig/,
    "dashboard quick task launcher must forward runtime payload fields to /api/sessions",
  );
});

test("session stream route scopes subscriptions to the current project", () => {
  const source = readRepoFile("src/app/api/sessions/[id]/stream/route.ts");

  assert.match(
    source,
    /resolveProjectId/,
    "session stream route must resolve the current project before opening SSE",
  );
  assert.match(
    source,
    /sessions\s+WHERE\s+id\s*=\s*\?\s+AND\s+project_id\s*=\s*\?/,
    "session stream route must verify the session belongs to the current project",
  );
});

test("sessions POST narrows arbitrary JSON before destructuring", () => {
  const source = readRepoFile("src/app/api/sessions/route.ts");

  assert.match(
    source,
    /bodyRecord/,
    "sessions POST should keep a narrowed record for request body fields",
  );
  assert.doesNotMatch(
    source,
    /}\s*=\s*body\s+as\s+Record<string,\s*unknown>/,
    "sessions POST should not destructure arbitrary JSON via a blind type cast",
  );
});

test("sessions PATCH resolves gates through a dedicated action", () => {
  const source = readRepoFile("src/app/api/sessions/[id]/route.ts");

  assert.match(
    source,
    /action\?:[\s\S]*"resolve_gate"/,
    "sessions PATCH action type should include resolve_gate",
  );
  assert.match(
    source,
    /case "resolve_gate":[\s\S]*processManager\.resolveGate/,
    "resolve_gate should call processManager.resolveGate instead of sendMessage",
  );
  assert.doesNotMatch(
    source,
    /case "resolve_gate":[\s\S]*processManager\.sendMessage[\s\S]*break;/,
    "resolve_gate must stay isolated from normal queued send messages",
  );
});

test("process manager resolves persisted gates without the normal send queue", () => {
  const source = readRepoFile("src/core/process-manager.ts");

  assert.match(
    source,
    /resolveGate[\s\S]*resolveControlPlaneGate/,
    "resolveGate should clear persisted gate state through the control-plane helper",
  );
  assert.match(
    source,
    /resolveGate[\s\S]*ensureProcess/,
    "resolveGate should recreate a process when memory was lost after restart",
  );
  assert.doesNotMatch(
    source,
    /resolveGate[\s\S]*messageQueues\.set/,
    "resolveGate should not enqueue approval replies behind normal messages",
  );
});

test("kanban task surfaces render control-plane state", () => {
  const card = readRepoFile("src/components/kanban/task-card.tsx");
  const dialog = readRepoFile("src/components/kanban/task-detail-dialog.tsx");

  assert.match(card, /parseGateStatus/, "task cards should parse persisted gate state");
  assert.match(card, /needs-input/, "task cards should show a needs-input badge");
  assert.match(card, /current_stage/, "task cards should render the current stage");

  assert.match(dialog, /parseGateStatus/, "task detail should parse persisted gate state");
  assert.match(dialog, /action:\s*"resolve_gate"/, "task detail replies should call resolve_gate");
  assert.match(dialog, /gateStatus\.options\.map/, "task detail should render gate option buttons");
});

test("session surfaces render control-plane state", () => {
  const indicator = readRepoFile("src/components/sessions/process-indicator.tsx");
  const card = readRepoFile("src/components/sessions/session-card.tsx");
  const detail = readRepoFile("src/app/sessions/[id]/page.tsx");

  assert.match(indicator, /currentStage/, "process indicator should accept current stage text");
  assert.match(indicator, /needs-input/, "process indicator should render needs-input");
  assert.match(card, /parseGateStatus/, "session cards should parse gate status");
  assert.match(card, /current_stage/, "session cards should pass current stage");
  assert.match(detail, /gate_status/, "session detail should pass gate state to the header indicator");
});

test("task and session lists refresh on control-plane stream events", () => {
  const tasks = readRepoFile("src/hooks/use-tasks.ts");
  const sessions = readRepoFile("src/hooks/use-sessions.ts");

  for (const [name, source] of [
    ["use-tasks", tasks],
    ["use-sessions", sessions],
  ] as const) {
    assert.match(
      source,
      /new EventSource\("\/api\/devlog\/stream"\)/,
      `${name} should subscribe to the global DevLog stream`,
    );
    assert.match(
      source,
      /control_plane_stage[\s\S]*control_plane_gate[\s\S]*control_plane_gate_resolved/,
      `${name} should react to all control-plane event types`,
    );
  }
});
