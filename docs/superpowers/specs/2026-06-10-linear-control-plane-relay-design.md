# Linear Control-Plane Relay — Design

**Date:** 2026-06-10
**Status:** Approved (ship Lite run; contract HARD-GATE + design gate passed)
**Branch:** `feat/linear-control-plane-relay` (origin/main control-plane core merged, 316 tests green at baseline)
**Upstream context:** moose-lab/DevLog#37 → implemented upstream as the control-plane stdout protocol (`[DEVLOG_STAGE]` / `[DEVLOG_GATE]` markers → `current_stage` / `gate_status` on `sessions`+`tasks`; gate pauses the session; `processManager.resolveGate(sessionId, response)` clears the gate and delivers the reply). Upstream's only resolve surface is the DevLog web/API. This design adds the **Linear relay** so the operator can drive the whole loop from the Linear mobile app.

## 1. Goal

Linear becomes the full remote cockpit for the control plane: the operator sees stage progress on the issue, answers gates by replying to a comment, and the agent resumes — without the relay introducing new failure modes (idempotent, no duplicate comments, no lost replies, no per-tick rewrite loops).

## 2. Contract (six decisions, human-confirmed)

1. **Gate presentation** — a dedicated gate comment per gate: `⚠️ GATE [gate_id]` + stage context + question + numbered options; after resolution a `✅ GATE resolved [gate_id]` receipt comment. The workpad comment keeps owning state/stage/narrative.
2. **Reply recognition** — first comment after the gate comment whose id is **not in the watch-created comment registry** (watch and the human share the same Linear account, so author-based detection is impossible — registry is the only reliable discriminator). Body passed **verbatim** to the agent; if it is an option number or a case-insensitive option match, normalize to that option.
3. **Stage refresh** — each tick, compare `tasks.current_stage` to `tasks.linear_relayed_stage`; only on change: refresh the workpad comment header stage line **and** re-read `.devlog/workpad.md` to refresh the narrative body. Change-only writes = natural idempotency (no ARC-101-style loops).
4. **Engines** — the relay is engine-agnostic by construction (DB columns + comments + `resolveGate`). Stage relay works for both engines today. Gate delivery inherits core capability: Claude closes the loop now; codex cannot receive a gate response today (evidence below) — that core gap is filed upstream as a separate issue, NOT fixed in this ship.
5. **Timeout** — none. AWAITING INPUT stays visible indefinitely; session death is covered by the existing finalize path.
6. **Dual-surface resolution** — if the gate is resolved elsewhere (web UI), the relay posts a "✅ resolved elsewhere" receipt once and does not call `resolveGate`.

### Codex evidence (decision-4 reflow, verified in code)

- `writeGateResponse` guard: codex launches with `stdin.end(prompt)` (plain-stdin one-shot), so a live paused codex process has `writableEnded` stdin → the gate response is **dropped with a warning**.
- `resolveGate` → `ensureProcess` respawn for codex builds `codex exec --json … -` with **no resume argument**.
- `sp.claudeSessionId = event.session_id` is only assigned in claude-stream-json parsing paths; the codex event parser never captures a codex session/thread id — nothing to resume from.
- Fixing this = core surgery (capture codex session id + `codex exec resume <id>` launch path + queue-until-exit delivery). Out of scope; goes upstream like #37.

## 3. Architecture

New module **`src/core/linear/relay.ts`** (pure logic + injected deps, same pattern as `reconcile.ts`), wired into the poller tick in `wiring.ts`:

```
tick: finalize → reconcile → relay → dispatch
```

Three sub-steps per tick, all scoped to linked, non-finalized tasks of the watched project:

1. **`relayStages`** — rows where `current_stage IS NOT NULL AND current_stage IS DISTINCT FROM linear_relayed_stage`: best-effort read `.devlog/workpad.md`, `updateComment` on the workpad comment (header stage line + narrative body), then record `linear_relayed_stage`.
2. **`relayGates`** — rows where `gate_status IS NOT NULL` and (no `linear_gate_comment_id` **or** stored `linear_gate_id` ≠ current gate id — guards core overwriting with a new gate): post the gate comment, record `linear_gate_comment_id` + `linear_gate_id` on the task, register the comment id in the registry.
3. **`pollGateReplies`** — rows with a pending gate comment: fetch comments on the issue created after the gate comment; first one whose id is not in the registry = human reply → normalize → `processManager.resolveGate(session_id, text)` → on ok post ✅ receipt (registered) and clear the gate columns. If `gate_status` is already NULL while `linear_gate_comment_id` is set → resolved elsewhere → post receipt, clear columns, no resolveGate.

## 4. Data & migrations

- `tasks` gains 3 columns: `linear_relayed_stage TEXT`, `linear_gate_comment_id TEXT`, `linear_gate_id TEXT` — added in `migrateLinearColumns` (which must keep running LAST, after all table-recreation migrations — existing FIX 5 invariant).
- New table `linear_relay_comments (comment_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))` — every comment the watch creates (workpad / gate / receipt) is registered here. This registry is the bot-vs-human discriminator.
- `LinearClient` gains `fetchComments(issueId)` → `[{ id, body, createdAt }]`; time filtering happens client-side.

## 5. Idempotency invariants

- **Comments: at-least-once.** The crash window between "comment posted" and "DB recorded" can, at worst, produce one duplicate gate comment after restart. Accepted.
- **resolveGate: exactly-once.** Core's "no pending gate" guard makes a second call harmless; any resolveGate failure is treated as the resolved-elsewhere path.
- Stage writes only on change; gate comments keyed by gate id; all relay state lives in SQLite — watch restart rebuilds everything from DB, no in-memory dependence.
- Any single-row Linear failure: log + skip the row, retry next tick. A full Linear outage must never affect the agent itself.
- `resolveGate` is only ever called inside the watch process (single-owner constraint: the process that spawned the session holds the stdin handle).

## 6. Acceptance (GWT)

1. Given a linked task whose `current_stage` changes, When the relay tick runs, Then the workpad comment header and narrative update once; And a tick with unchanged stage performs zero Linear writes.
2. Given a new `gate_status` appears, When the relay tick runs, Then exactly one gate comment is posted containing question, numbered options, and gate id.
3. Given a human replies "2" / "Revise" / free text after the gate comment, When the tick runs, Then `resolveGate` is called exactly once with the normalized (option) or verbatim text, the agent resumes, and a ✅ receipt is posted.
4. Given the gate was resolved via the web UI first, Then exactly one "resolved elsewhere" receipt is posted and `resolveGate` is not called.
5. Given the Linear API is down, Then the agent session is unaffected and the relay retries next tick.
6. Given the watch restarts mid-gate, Then no duplicate resolve occurs and the pending gate is rediscovered from the DB.

## 7. Testing

- **Unit:** fake Linear client + in-memory SQLite (existing `linear-*.test.ts` pattern) per relay function: stage idempotency, gate comment exactly-once-per-gate-id, reply normalization matrix, registry discrimination, resolved-elsewhere, restart recovery.
- **Integration:** tick wiring order (finalize → reconcile → relay → dispatch) with all fakes.
- **Live (ship 4.5):** one real ARC issue end-to-end with Claude (stage refresh → gate comment → phone reply → resume → In Review); codex run verifying stage relay.

## 8. Out of scope

- Codex gate-response delivery in core (upstream issue, like #37).
- Gate timeout / reminders; multi-gate concurrency beyond core's single `gate_status` column; dedicated needs-input Linear workflow state.
