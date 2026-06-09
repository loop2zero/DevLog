# Session Agent Activity Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Session Detail show real-time coding-agent activity, including replayed running state, Codex/CLI lifecycle, tool calls, and stderr/stdout logs, so users can tell whether a task is actively progressing.

**Architecture:** Keep the existing chat model intact. Add a small replay helper for persisted session state, emit live process logs through the existing `streamManager`, and render a bounded activity feed inside the existing Session Detail chat surface. Do not add a new database table in this slice.

**Tech Stack:** Next.js App Router, React, TypeScript, `better-sqlite3`, Server-Sent Events, Node `node:test`, Bun project scripts.

---

## Context

Current behavior:
- `src/app/api/sessions/[id]/stream/route.ts` replays only `session_messages`, then sends `sync`.
- `src/core/process-manager.ts` writes stderr to `session_logs`, but does not emit those logs to the per-session SSE stream.
- Codex `thread.started`, `turn.started`, and `turn.completed` events are currently swallowed by the parser.
- `src/hooks/use-session-chat.ts` does not handle `system_log` or raw `session_logs`, and starts with `processing=false`, so a running session can appear idle after page load.

Karpathy constraints for this implementation:
- No new persistence model unless tests prove `session_logs` and `session_messages` cannot cover the UX.
- No broad rewrite of Session Detail tabs.
- No reliance on real Codex auth in automated tests.
- Every changed line must serve the visible Session Detail activity stream.

## File Structure

- Modify: `src/core/stream-manager.ts`
  - Add a typed `log` event and allow replayed status metadata.
- Create: `src/core/session-stream-replay.ts`
  - Pure helper that converts persisted session status, messages, and logs into replayable `ChatStreamEvent[]`.
- Test: `src/core/__tests__/session-stream-replay.test.ts`
  - Verifies a newly opened stream receives running status, persisted messages, and persisted logs.
- Modify: `src/app/api/sessions/[id]/stream/route.ts`
  - Use the replay helper before sending `sync`.
- Modify: `src/core/process-manager.ts`
  - Emit per-session `system_log` events for process lifecycle and Codex turn lifecycle.
  - Emit per-session `log` events when stderr is captured.
- Modify: `src/core/__tests__/process-manager-health.test.ts`
  - Add parser coverage for Codex lifecycle events.
- Modify: `src/hooks/use-session-chat.ts`
  - Track activity entries and treat replayed `running` status as active processing.
- Modify: `src/components/sessions/session-chat.tsx`
  - Render a compact activity feed in the chat timeline.
- Test: `src/components/sessions/session-chat.test.ts`
  - Add formatting tests for activity entries and status copy.

## Task 1: Add the Session Stream Replay Contract

**Files:**
- Modify: `src/core/stream-manager.ts`
- Create: `src/core/session-stream-replay.ts`
- Test: `src/core/__tests__/session-stream-replay.test.ts`

- [ ] **Step 1: Write the failing replay helper test**

Add this test file:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import { buildSessionStreamReplayEvents } from "../session-stream-replay";

test("buildSessionStreamReplayEvents replays running state, messages, and logs", () => {
  const db = makeTestDb();

  db.prepare(
    `INSERT INTO sessions (
      id, project_id, task_id, worktree_path, status, pid,
      session_auth_mode, local_cli_agent_id, agent_model, agent_reasoning
    ) VALUES (
      'session-running', 'videoclaw', NULL, '/repo', 'running', 6560,
      'local-cli', 'codex', 'gpt-5.5', 'high'
    )`,
  ).run();
  db.prepare(
    "INSERT INTO session_messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)",
  ).run("session-running", "Initial prompt", "2026-06-03 00:41:14");
  db.prepare(
    "INSERT INTO session_logs (session_id, chunk, stream, timestamp) VALUES (?, ?, 'stderr', ?)",
  ).run("session-running", "warning: sandbox note", "2026-06-03 00:41:15");
  db.prepare(
    "INSERT INTO session_logs (session_id, chunk, stream, timestamp) VALUES (?, ?, 'stderr', ?)",
  ).run("session-running", "apply_patch verification failed", "2026-06-03 00:46:58");

  const events = buildSessionStreamReplayEvents(db, "session-running", {
    logLimit: 10,
  });

  assert.deepEqual(
    events.map((event) => event.type),
    ["status", "message", "log", "log"],
  );
  assert.deepEqual(events[0], {
    type: "status",
    status: "running",
    pid: 6560,
    started_at: "2026-06-03 00:41:14",
    ended_at: null,
  });
  assert.deepEqual(events[1], {
    type: "message",
    role: "user",
    content: "Initial prompt",
  });
  assert.deepEqual(events[2], {
    type: "log",
    stream: "stderr",
    chunk: "warning: sandbox note",
    timestamp: "2026-06-03 00:41:15",
  });
  assert.deepEqual(events[3], {
    type: "log",
    stream: "stderr",
    chunk: "apply_patch verification failed",
    timestamp: "2026-06-03 00:46:58",
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
TZ=Asia/Shanghai bun run test
```

Expected: FAIL because `../session-stream-replay` does not exist and `ChatStreamEvent` does not yet include `log` status metadata.

- [ ] **Step 3: Extend the stream event type**

In `src/core/stream-manager.ts`, replace the `status` event line and add `log`:

```ts
  | {
      type: "status";
      status: string;
      content?: string;
      pid?: number | null;
      started_at?: string | null;
      ended_at?: string | null;
    }
  | {
      type: "log";
      stream: "stdout" | "stderr";
      chunk: string;
      timestamp: string;
    }
```

- [ ] **Step 4: Implement the replay helper**

Create `src/core/session-stream-replay.ts`:

```ts
import type Database from "better-sqlite3";
import type { ChatStreamEvent } from "./stream-manager";
import type { ChatMessage, LogChunk, Session } from "./types-dashboard";

export interface SessionStreamReplayOptions {
  logLimit?: number;
}

type ReplaySessionRow = Pick<
  Session,
  "id" | "status" | "pid" | "started_at" | "ended_at"
>;

interface OrderedReplayEvent {
  order: string;
  event: ChatStreamEvent;
}

export function buildSessionStreamReplayEvents(
  db: Database.Database,
  sessionId: string,
  options: SessionStreamReplayOptions = {},
): ChatStreamEvent[] {
  const logLimit = options.logLimit ?? 100;
  const events: ChatStreamEvent[] = [];

  const session = db
    .prepare(
      "SELECT id, status, pid, started_at, ended_at FROM sessions WHERE id = ?",
    )
    .get(sessionId) as ReplaySessionRow | undefined;

  if (session) {
    events.push({
      type: "status",
      status: session.status,
      pid: session.pid,
      started_at: session.started_at,
      ended_at: session.ended_at,
    });
  }

  const messages = db
    .prepare(
      "SELECT * FROM session_messages WHERE session_id = ? ORDER BY id ASC",
    )
    .all(sessionId) as ChatMessage[];

  const logs = db
    .prepare(
      `SELECT * FROM (
        SELECT * FROM session_logs
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT ?
      ) ORDER BY id ASC`,
    )
    .all(sessionId, logLimit) as LogChunk[];

  const replayItems: OrderedReplayEvent[] = [
    ...messages.map((message) => ({
      order: `${message.timestamp}:message:${message.id}`,
      event: {
        type: "message" as const,
        role: message.role,
        content: message.content,
      },
    })),
    ...logs.map((log) => ({
      order: `${log.timestamp}:log:${log.id}`,
      event: {
        type: "log" as const,
        stream: log.stream,
        chunk: log.chunk,
        timestamp: log.timestamp,
      },
    })),
  ];

  replayItems.sort((a, b) => a.order.localeCompare(b.order));
  events.push(...replayItems.map((item) => item.event));

  return events;
}
```

- [ ] **Step 5: Run focused verification**

Run:

```bash
TZ=Asia/Shanghai bun run test
```

Expected: PASS for the new replay test and no regressions in existing stream tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/stream-manager.ts src/core/session-stream-replay.ts src/core/__tests__/session-stream-replay.test.ts
git commit -m "feat: replay session activity stream state"
```

## Task 2: Wire Replay Events Into the Session SSE Route

**Files:**
- Modify: `src/app/api/sessions/[id]/stream/route.ts`

- [ ] **Step 1: Replace manual message replay with helper replay**

Modify the imports:

```ts
import { buildSessionStreamReplayEvents } from "@/core/session-stream-replay";
```

Remove the `ChatMessage` import if it becomes unused.

Replace the current message replay block with:

```ts
      try {
        const db = getDb();
        const replayEvents = buildSessionStreamReplayEvents(db, id);

        for (const event of replayEvents) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        }
      } catch {
        // DB might not be ready
      }
```

- [ ] **Step 2: Run verification**

Run:

```bash
TZ=Asia/Shanghai bun run test
bun run typecheck
```

Expected: tests and typecheck pass.

- [ ] **Step 3: Manual API smoke check**

With the local app running on port 3000 and an active session id available, run:

```bash
SESSION_ID=$(sqlite3 data/devlog.db "SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1")
curl -sS --max-time 3 "http://localhost:3000/api/sessions/${SESSION_ID}/stream"
```

Expected: output includes at least one `status` event before `sync`, and includes persisted `log` events when `session_logs` has rows.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/sessions/[id]/stream/route.ts
git commit -m "feat: replay persisted session stream activity"
```

## Task 3: Emit Live Process Logs and Codex Lifecycle Events

**Files:**
- Modify: `src/core/process-manager.ts`
- Modify: `src/core/__tests__/process-manager-health.test.ts`

- [ ] **Step 1: Add Codex lifecycle parser coverage**

In `src/core/__tests__/process-manager-health.test.ts`, add a test near the existing generic parser tests:

```ts
test("generic JSON parser maps Codex lifecycle events to session system logs", () => {
  const sessionId = "test-codex-lifecycle";
  const events: ChatStreamEvent[] = [];
  const unsubscribe = streamManager.subscribe(sessionId, (event) => {
    events.push(event);
  });
  const sp: Record<string, unknown> = {
    eventParser: "codex",
    genericStreamState: {
      buffer: "",
      codexToolUses: new Set<string>(),
      openCodeToolUses: new Set<string>(),
      copilotToolNames: new Map<string, string>(),
      cursorTextSoFar: "",
    },
    textBuffer: "",
  };

  try {
    genericJsonLineProcess.handleGenericJsonLine(
      sessionId,
      sp,
      JSON.stringify({ type: "thread.started" }),
    );
    genericJsonLineProcess.handleGenericJsonLine(
      sessionId,
      sp,
      JSON.stringify({ type: "turn.started" }),
    );
    genericJsonLineProcess.handleGenericJsonLine(
      sessionId,
      sp,
      JSON.stringify({ type: "turn.completed" }),
    );
  } finally {
    unsubscribe();
  }

  assert.deepEqual(
    events.map((event) =>
      event.type === "system_log" ? [event.level, event.message] : event.type,
    ),
    [
      ["info", "Codex thread started"],
      ["info", "Codex turn started"],
      ["success", "Codex turn completed"],
    ],
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
TZ=Asia/Shanghai bun run test
```

Expected: FAIL because Codex lifecycle events are currently swallowed.

- [ ] **Step 3: Add a per-session system log helper**

In `src/core/process-manager.ts`, replace `emitGlobalSystemLog` with:

```ts
  private emitSystemLog(
    level: SystemLogLevel,
    sessionId: string,
    message: string,
    prefix?: string,
  ): void {
    const event = createSystemLogEvent({ level, prefix, sessionId, message });
    streamManager.emit("global", event);
    streamManager.emit(sessionId, event);
  }
```

Then replace calls to `this.emitGlobalSystemLog(...)` with `this.emitSystemLog(...)`.

- [ ] **Step 4: Emit live stderr logs**

In the stderr handler in `src/core/process-manager.ts`, after the successful `session_logs` insert block, emit:

```ts
          streamManager.emit(sessionId, {
            type: "log",
            stream: "stderr",
            chunk: text,
            timestamp: new Date().toISOString(),
          });
```

- [ ] **Step 5: Emit Codex lifecycle events**

In `handleCodexEvent`, replace the current final return block:

```ts
    if (type === "thread.started") {
      streamManager.emit(sessionId, createSystemLogEvent({
        level: "info",
        sessionId,
        message: "Codex thread started",
      }));
      return true;
    }

    if (type === "turn.started") {
      streamManager.emit(sessionId, createSystemLogEvent({
        level: "info",
        sessionId,
        message: "Codex turn started",
      }));
      return true;
    }

    if (type === "turn.completed") {
      streamManager.emit(sessionId, createSystemLogEvent({
        level: "success",
        sessionId,
        message: "Codex turn completed",
      }));
      return true;
    }

    return false;
```

- [ ] **Step 6: Run verification**

Run:

```bash
TZ=Asia/Shanghai bun run test
bun run typecheck
```

Expected: the new Codex lifecycle test passes, and existing parser tests remain green.

- [ ] **Step 7: Commit**

```bash
git add src/core/process-manager.ts src/core/__tests__/process-manager-health.test.ts
git commit -m "feat: stream live coding-agent activity logs"
```

## Task 4: Render Activity in Session Detail

**Files:**
- Modify: `src/hooks/use-session-chat.ts`
- Modify: `src/components/sessions/session-chat.tsx`
- Modify: `src/components/sessions/session-chat.test.ts`

- [ ] **Step 1: Add activity formatting tests**

In `src/components/sessions/session-chat.test.ts`, extend imports:

```ts
  formatActivityEntryForDisplay,
```

Add tests:

```ts
test("formatActivityEntryForDisplay labels stderr activity", () => {
  assert.equal(
    formatActivityEntryForDisplay({
      id: 1,
      kind: "log",
      stream: "stderr",
      text: "apply_patch verification failed",
      timestamp: "2026-06-03T00:46:58.000Z",
    }),
    "[stderr] apply_patch verification failed",
  );
});

test("formatActivityEntryForDisplay labels system activity", () => {
  assert.equal(
    formatActivityEntryForDisplay({
      id: 2,
      kind: "system",
      level: "success",
      text: "Codex turn completed",
      timestamp: "2026-06-03T00:49:30.000Z",
    }),
    "[success] Codex turn completed",
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
TZ=Asia/Shanghai bun run test
```

Expected: FAIL because the formatter does not exist.

- [ ] **Step 3: Extend the hook event state**

In `src/hooks/use-session-chat.ts`, add:

```ts
export interface SessionActivityEntry {
  id: number;
  kind: "log" | "system";
  text: string;
  timestamp: string;
  stream?: "stdout" | "stderr";
  level?: "info" | "success" | "warning" | "error";
}
```

Extend `StreamEvent`:

```ts
  stream?: "stdout" | "stderr";
  chunk?: string;
  timestamp?: string;
  level?: "info" | "success" | "warning" | "error";
  pid?: number | null;
  started_at?: string | null;
  ended_at?: string | null;
```

Add state:

```ts
  const [activityEntries, setActivityEntries] = useState<SessionActivityEntry[]>([]);
```

Add a bounded append helper inside `useSessionChat`:

```ts
  const appendActivity = useCallback((entry: Omit<SessionActivityEntry, "id">) => {
    setActivityEntries((current) => [
      ...current,
      { ...entry, id: nextId() },
    ].slice(-100));
  }, []);
```

Handle live and replayed events in the switch:

```ts
          case "log":
            if (data.stream && data.chunk) {
              appendActivity({
                kind: "log",
                stream: data.stream,
                text: data.chunk,
                timestamp: data.timestamp ?? new Date().toISOString(),
              });
            }
            break;

          case "system_log":
            if (data.message) {
              appendActivity({
                kind: "system",
                level: data.level ?? "info",
                text: data.message,
                timestamp: data.timestamp ?? new Date().toISOString(),
              });
            }
            break;
```

In the status handler, make replayed running state visible:

```ts
            if (data.status === "running") {
              setProcessing(true);
              if (data.pid) {
                appendActivity({
                  kind: "system",
                  level: "info",
                  text: `Agent process running as PID ${data.pid}`,
                  timestamp: data.started_at ?? new Date().toISOString(),
                });
              }
            }
```

Reset activity on session changes:

```ts
    setActivityEntries([]);
```

Return it:

```ts
    activityEntries,
```

- [ ] **Step 4: Render activity entries**

In `src/components/sessions/session-chat.tsx`, extend imports:

```ts
  type SessionActivityEntry,
```

Add formatter:

```ts
export function formatActivityEntryForDisplay(entry: SessionActivityEntry): string {
  if (entry.kind === "log") {
    return `[${entry.stream ?? "log"}] ${entry.text}`;
  }
  return `[${entry.level ?? "info"}] ${entry.text}`;
}
```

Add component:

```tsx
function ActivityTimeline({ entries }: { entries: SessionActivityEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="px-4 py-2">
      <div className="rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <TerminalIcon className="h-3.5 w-3.5" />
          <span>Agent activity</span>
        </div>
        <div className="max-h-40 space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
          {entries.slice(-20).map((entry) => (
            <div key={entry.id} className="whitespace-pre-wrap break-words">
              {formatActivityEntryForDisplay(entry)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

Destructure `activityEntries` from `useSessionChat`, and render it before the streaming bubble:

```tsx
        <ActivityTimeline entries={activityEntries} />
```

- [ ] **Step 5: Run verification**

Run:

```bash
TZ=Asia/Shanghai bun run test
bun run typecheck
```

Expected: activity formatting tests pass, hook/component typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-session-chat.ts src/components/sessions/session-chat.tsx src/components/sessions/session-chat.test.ts
git commit -m "feat: show coding-agent activity in session detail"
```

## Task 5: End-to-End Verification

**Files:**
- No required code files.
- Optional modify if gaps are found: `scripts/task-launch-e2e.mjs`

- [ ] **Step 1: Run the standard quality gates**

Run:

```bash
TZ=Asia/Shanghai bun run test
bun run typecheck
bun run build
git diff --check
```

Expected:
- Tests pass.
- Typecheck passes.
- Build passes.
- Whitespace check passes.

- [ ] **Step 2: Run deterministic local CLI E2E**

Use the existing fake local CLI path rather than real Codex auth:

```bash
DEVLOG_E2E_AUTH_MODE=local-cli \
DEVLOG_E2E_LOCAL_CLI_AGENT_ID=qwen \
TZ=Asia/Shanghai \
bun run test:e2e:task-launch
```

Expected:
- The session reaches the ready marker.
- The session receives the follow-up ack marker.
- The browser-visible session transcript still contains assistant messages.

- [ ] **Step 3: Manual real-session smoke check**

Start the app if needed:

```bash
bun run dev -- --port 3000
```

Open a real running Session Detail and confirm:
- A running session opened mid-run immediately shows a running status.
- `Agent activity` shows recent stderr/log activity if `session_logs` has rows.
- Codex tool calls still render as `Bash` tool blocks.
- The final assistant message still appears after the process exits.

- [ ] **Step 4: Final commit if verification required small fixes**

If Task 5 required changes to the E2E script:

```bash
git add scripts/task-launch-e2e.mjs
git commit -m "test: verify session activity stream visibility"
```

If Task 5 required no code changes, do not create an empty commit.

## Checkpoints

After Task 1:
- Replay helper can reconstruct a useful session stream from SQLite alone.

After Task 3:
- Live backend process activity reaches per-session SSE subscribers.

After Task 4:
- Session Detail exposes activity without breaking the existing chat/instruction flow.

After Task 5:
- The implementation is verified by unit tests, typecheck, build, deterministic task-launch E2E, and one manual real-session smoke check.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Activity feed duplicates events after reconnect | Medium | Bound replay to persisted logs/messages and live state to in-memory events; keep IDs client-local and cap entries at 100. |
| Raw stderr becomes too noisy | Medium | Show last 20 entries in UI and keep full replay cap at 100. Do not mark every stderr as fatal. |
| Real Codex auth errors make E2E flaky | High | Automated verification uses fake local CLI; real Codex remains a manual smoke check. |
| New UI crowds the instruction chat | Medium | Render compact monospaced activity in one collapsible-looking block, not separate cards per event. |

## Self-Review

Spec coverage:
- Shows running state when opening an already-running Session Detail: Task 1 and Task 2.
- Shows coding-agent information flow while the agent is consuming work: Task 3 and Task 4.
- Preserves existing multi-turn text conversation: Task 4 explicitly keeps `SessionChat` and `useSessionChat`.
- Avoids architecture creep: no new DB table, no broad tab redesign.
- Includes verification path: Task 5.

Placeholder scan:
- No unresolved placeholders or unspecified "handle edge cases" steps.
- Every code-bearing task includes exact target files, code snippets, and commands.

Type consistency:
- `ChatStreamEvent` owns the `log` event.
- `SessionActivityEntry` is frontend-only state.
- `session-stream-replay.ts` is the only new backend helper.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-03-session-agent-activity-stream.md`.

Two execution options:

1. Subagent-Driven (recommended) - dispatch a fresh subagent per task, review between tasks, fastest feedback loop.

2. Inline Execution - execute tasks in this session using `superpowers:executing-plans`, with checkpoints after Tasks 1, 3, and 5.
