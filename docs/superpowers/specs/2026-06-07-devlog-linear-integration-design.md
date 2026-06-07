# DevLog ↔ Linear Integration — v1 Design

**Date:** 2026-06-07
**Status:** Design approved, pending spec review → writing-plans
**Code home:** fork `loop2zero/DevLog`, branch `feat/linear-bridge`
**Tracker:** Linear (betakairos / Arc team), one tracking issue
**Reference implementation:** `openai/symphony` (Elixir). We borrow its loop discipline as a *reference*, not its code.

---

## 1. Why

DevLog is already a near-complete agent execution platform: multi-engine (Claude + Codex + API
providers), persistent cost/history/analytics, git-worktree isolation, a local Kanban with task
dependencies, PR creation. What it lacks is the two things Symphony has:

1. **Linear as the board / source of truth** — so the operator drives work from the Linear app,
   including **mobile**.
2. **An auto-dispatch loop** — move an issue to a trigger state and the system picks it up and runs
   it to a PR without a desktop click.

The decisive constraint: the operator wants to drive from their **phone** (Linear has a mobile app;
DevLog's localhost dashboard does not) **and** wants to use **Claude**, not only Codex. That rules
out adopting Symphony directly (Codex-only) and rules out keeping DevLog's board local-only.

This integration makes Linear the cockpit and DevLog the local engine + recorder.

## 2. Writeback model — the central decision (backed by an experiment)

The core architectural fork is **who writes to Linear** (issue state transitions + the workpad
comment). Note: in all models the agent writes the *code, commits, and PR*; the only question is who
keeps the Linear board in sync.

We ran a 3-cell experiment on real Linear issues (repo `loop2zero/ai-native-intel`), same task,
varying only the writeback model:

| Run | Writeback | Engine | Result |
|---|---|---|---|
| A (ARC-90) | **agent writes** (Symphony, injected `linear_graphql`) | Codex | rich agent-authored workpad (plan/AC/evidence); ~7 min |
| B (ARC-91) | **harness writes** (deterministic) | Codex | mechanical workpad; agent 159 s |
| C (ARC-92) | **harness writes** | **Claude** | identical mechanical workpad; agent 116 s — **ran Claude with zero changes** |

Findings:

- **Agent-writes** gives a rich, first-person, mobile-readable record — but locks the engine (each
  engine needs its own Linear tool), hands board write-access to an autonomous AI, and the agent
  spends turns on bookkeeping.
- **Harness-writes** is engine-agnostic (Claude/Codex/anything), deterministic, safe (the AI never
  touches Linear), but the comment is terse.
- **The decisive insight:** "knowing the agent's state" splits into **lifecycle status** (running /
  done / **dead** / blocked) and **narrative** (plan, validation, surprises). A *dead or hung agent
  cannot report its own death* — only an external observer can. Even Symphony, the canonical
  agent-writes system, keeps an **external watchdog** (orchestrator monitors the worker process via
  `{:DOWN}`, a `blocked` map, and re-polls Linear) because it cannot trust the agent for liveness.

**Decision — hybrid:**

- **Harness (DevLog) owns the state machine** + the workpad comment's structural header + cost +
  **liveness/failure truth**. Deterministic, engine-agnostic, safe.
- **Agent owns the narrative**, written to a repo file `.devlog/workpad.md` (no Linear access needed
  → any engine). DevLog relays that file into the Linear comment body.

This yields all three requirements at once: **any engine** + **mobile-readable full delivery** +
**accurate state even when the agent dies**. The hybrid is the terminal design, not a compromise:
the dead-process-can't-report-its-death problem is structural and permanent.

## 3. Architecture & components

New code lives in `src/core/linear/`. Everything else is reused.

```
Linear (phone-driven, master)
   │  poll: project slugId + trigger state + engine label
   ▼
core/linear/poller.ts      — interval loop; finds trigger issues; dedups; hands to dispatcher
core/linear/client.ts      — Linear GraphQL: query issues; mutate state; create/update comment
core/linear/dispatcher.ts  — issue → mirror DevLog task; resolve engine; call EXISTING execute path
core/linear/writeback.ts   — harness-owned: state transitions + workpad header + relay agent file
   │  reuse, do not rewrite ▼
existing: createWorktree → spawn session (claude|codex) → cost/history (free)
```

**Reuse anchor:** the dispatcher invokes the existing `tasks/[id]/execute` logic
(`createWorktree` + `processManager` session spawn, already multi-engine). The Linear layer is just
"a new task source + a writeback owner."

**Linear ↔ repo mapping (scope unit):** each watched **Linear project = one local repo** in
`devlog.config.json`. This is the isolation boundary — the poller never scans the whole team.

**Config (added to `devlog.config.json`):**

```jsonc
"linear": {
  "watch": [
    { "projectSlugId": "<slugId>",        // scope unit
      "devlogProjectId": "<local repo id>",
      "triggerState": "Todo",
      "reviewState": "In Review",
      "terminalStates": ["Done", "Canceled", "Duplicate"],
      "defaultEngine": "claude",
      "labelEngineMap": { "claude": "claude", "codex": "codex" } }
  ],
  "pollIntervalMs": 10000
}
```

**New DB columns** on `tasks` (and/or `sessions`): `linear_issue_id`, `linear_identifier`,
`linear_workpad_comment_id` — linkage + idempotency.

**Entry point:** a `devlog watch` CLI command starts the poller (separate from `bun run dev`).
`LINEAR_API_KEY` from env.

## 4. Data flow & state mapping

```
1. poll    every pollIntervalMs: issues in watched project where state == triggerState
2. dedup   skip issues already linked to a live/finished local session (tasks.linear_issue_id)
3. dispatch
   · harness: mirror task; resolve engine (issue label > project default); create worktree
   · [harness writes] Linear → In Progress; create workpad comment (header: env stamp/engine/branch/state)
   · spawn agent (prompt: implement + commit + push + open PR + maintain .devlog/workpad.md; NEVER touch Linear)
4. running
   · [harness owns liveness] DevLog already tracks the session (running/idle/failed) + monitors the pid
   · milestone refresh: read .devlog/workpad.md → update Linear comment body (v1: at dispatch + at completion)
5. done
   · [harness writes] detect outcome:
     ├ PR opened → Linear → In Review; comment = header (state/PR/tokens+cost/files) + agent workpad.md body
     └ no PR / process died / failed → leave In Progress + write BLOCKED + reason (harness knows the death) + partial body
6. terminal  human merges + moves Linear → Done; poller sees terminal → cleanup worktree + session record
```

**State mapping (Arc real statuses):**

| Linear | Trigger | Writer |
|---|---|---|
| `Todo` (trigger) | operator / phone | — |
| `In Progress` | dispatch start | **harness** |
| `In Review` | PR detected | **harness** |
| stays `In Progress` + BLOCKED note | process died / no PR | **harness** (dead agent can't report) |
| `Done` / `Canceled` / `Duplicate` (terminal) | operator | operator → poller cleans up |

**Comment body = harness header + agent body**, e.g.:

```
[harness header] state In Review · engine claude · branch … · tokens/cost … · PR #N
─────────
[agent .devlog/workpad.md] ### Plan [x]… ### Evidence bun test 5 pass …
```

## 5. Error handling / idempotency / safety (with Symphony reference)

1. **Idempotency / claim / restart** — ours: unique `tasks.linear_issue_id`, checked before
   dispatch; **persisted in SQLite** so restart re-polls and skips finished issues; an `In Progress`
   issue with no live local session (restart leftover) is left alone + logged, requires human to
   re-trigger (no auto re-dispatch). *Symphony: in-memory `claimed`/`completed`/`running`, lost on
   restart — a known weakness we fix with persistence.*
2. **Concurrency cap** — reuse DevLog session limit. *Symphony: `max_concurrent_agents` in
   `maybe_dispatch`.*
3. **Retry & backoff** — reuse DevLog `task-retry` + exponential backoff; stop after N. *Symphony:
   `@failure_retry_base_ms` + `retry_attempts` + scheduled `{:retry_issue}` (the "Backoff queue").*
4. **Failure & liveness** — DevLog process-manager monitors the session pid
   (`markSessionFailedAndReleaseLinkedTask`); harness deterministically writes BLOCKED + cause to
   Linear. *Symphony: `{:DOWN}` → `handle_agent_down`; but it does NOT write failure to Linear (only
   in-memory/dashboard) — we are stronger here.*
5. **Blocked / needs-human** — harness writes a BLOCKED comment (what's missing / what to do) +
   leaves In Progress; persistent. *Symphony: `blocked` map + `reconcile_blocked_issues` (finer, but
   in-memory, cleared on restart).*
6. **Auth failure** — `LINEAR_API_KEY` missing / 401 → halt poller + log, no spin. *Symphony:
   `tracker.api_key` from env; failures logged, issues preserved.*
7. **Scope isolation** — poll only the watched project `slugId`; never the whole team. *Symphony:
   `project_slug` filter + `required_labels` + assignee filter.*
8. **Workspace cleanup** — poller sees terminal → remove worktree + session record. *Symphony:
   `run_terminal_workspace_cleanup` (startup + terminal/release) + `before_remove` hook.*
9. **Safety surface** — only the harness (vetted code) writes Linear; the agent has zero Linear
   access → minimal attack/mistake surface. *Symphony: injects a raw `linear_graphql` tool into the
   agent → broader surface (autonomous AI with board write access).*

Net: items 1/4/5/9 are stronger for us (harness-writes + SQLite persistence); 2/6/7/8 are at parity;
3 is borrowed.

## 6. Testing & v1 scope

**Testing** (Bun + `bun test`, TDD per DevLog patterns):

- **Unit:** Linear client (mock fetch) — query/state-mutation/comment-upsert; engine resolution
  (label > default); state-mapping pure functions; idempotency dedup; workpad assembly (header +
  agent file). *Symphony parallel: ExUnit with injected fakes —
  `continue_with_issue_for_test`, `fetch_issue_states_by_ids_for_test`.*
- **Integration:** poller→dispatcher with a fake Linear client + in-memory SQLite — asserts
  task/session created once (not twice), ordered state transitions, workpad assembled, failure →
  BLOCKED. Reuse DevLog test-helpers (ProcessManager stub). *Symphony parallel: `live_e2e_test.exs`.*
- **Live smoke (manual, behind env flag, not in CI):** one real Linear issue end-to-end — the A/B/C
  experiment is the template. This is the ship Live-Demo / substitute-evidence gate. *Symphony
  parallel: `make e2e` / `SYMPHONY_RUN_LIVE_E2E=1`.*

**v1 includes:** Linear adapter (poll + state/comment mutations); poller + dispatcher reusing
execute; hybrid writeback (harness state machine + relay `.devlog/workpad.md`); engine via label >
project default (Claude + Codex); failure → BLOCKED + retry/backoff; scope = watched project only;
concurrency cap; terminal cleanup; `devlog watch` CLI + config.

**v1 defers (YAGNI for a solo operator):**

| Deferred | Symphony has | Why defer |
|---|---|---|
| grind-by-turns re-kick | `do_run_codex_turns` max_turns loop | bet DevLog's long session suffices; add in v2 |
| PR feedback sweep / Rework loop | WORKFLOW PR sweep + Rework state | v1 stops at In Review; human drives rework |
| SSH distributed workers | `worker.ssh_hosts` | solo / local |
| proof-of-work gates | Mix `Specs.Check` / `PrBody.Check` | later as a verify hook |
| continuous live workpad streaming | agent updates continuously | v1 refreshes at dispatch + completion |
| two-way sync / create-in-DevLog → Linear | n/a (Linear is sole board) | operator only creates in Linear |

**v1 Done-when (delivery acceptance):**

- [ ] Unit + integration green (fake Linear client).
- [ ] Live: one real Linear issue runs to In Review with Codex (workpad contains agent body).
- [ ] Live: same flow with **Claude** (proves multi-engine — the reason this exists).
- [ ] Agent process killed mid-run → harness deterministically writes BLOCKED + cause.
- [ ] Only the watched project is touched; other issues untouched (isolation).
