# ARC-100 — Live Linear `design-breakdown` Flow (Design)

**Date:** 2026-06-07
**Branch:** `feat/linear-bridge`
**Tracking:** Linear ARC-100
**Builds on:** `2026-06-07-devlog-linear-integration-design.md` (the DevLog↔Linear bridge v1)

## Goal

Wire **intelligent requirement decomposition** into the live DevLog↔Linear bridge.
A requirement becomes a reviewed, human-corrected set of Linear issues
(parent + ordered sub-issues + blocking chain) that then **auto-executes** as a
chain: first sub builds, a human merges it, the poller advances the next, until
the parent closes.

The decomposition is **agent-driven** (intelligent, not mechanical) and
**human-corrected** before any Linear issue is created.

## Core principle — two phases, two execution models

The single most important architectural decision: decomposition+correction is an
**interactive in-session loop** (a human is present, like a brainstorm); only
batch-creation and chain-execution are **headless** (poller-driven, unattended).

```
┌── Phase 1: Interactive (in-session, human present) ────────────┐
│  intake requirement                                            │
│        ▼                                                       │
│  agent proposes draft → renders NUMBERED preview               │
│  (.devlog/breakdown.json is the source of truth)              │
│        ▼                                                       │
│ ┌── Correction loop (HARD-GATE) ──────────────┐               │
│ │  human gives natural-language feedback        │               │
│ │  (local "#3 ..." / global "add a phase")      │ ◄─┐ loop      │
│ │  agent patches breakdown.json → re-renders    │   │           │
│ └──────────────┬────────────────────────────────┘   │          │
│        human says "approve" ─────────────────────────┘          │
└────────────────┬───────────────────────────────────────────────┘
                 ▼  (approval = stamp breakdown.json + label parent design-breakdown)
┌── Phase 2: Headless (poller, unattended) ──────────────────────┐
│  batch-create: real parent + sub-issues + blocking chain       │
│        ▼                                                        │
│  first sub auto-starts → existing build flow → PR → In Review  │
│        ▼                                                        │
│  human merges sub → poller reconcile advances next sub         │
│        ▼                                                        │
│  all subs Done → poller closes parent  ✅                       │
└────────────────────────────────────────────────────────────────┘
```

**Owner boundaries stay clean:**
- **Agent** — produces/patches `breakdown.json` only (zero Linear access → any engine).
- **Human** — corrects the draft (Phase 1) and merges each sub (Phase 2 gate).
- **Harness** — owns the Linear state machine and all writes (Phase 2).

## Phase 1 — Interactive decompose + correction

### Input format (decided): numbered preview + natural-language feedback

The human never hand-edits JSON or drags issues in Linear during review. Instead:

1. Agent renders the draft as a **numbered, human-readable list** backed by
   `.devlog/breakdown.json`.
2. Human gives **free-form NL feedback**; the stable numbers make the reference
   unambiguous:
   - **Local** (within one issue): `"#3 retitle to X"`, `"#3 add an acceptance: cover timeout"` → patch that one object.
   - **Global** (structure): `"add a regression issue at the end"`, `"split into 5 not 3"`, `"swap #2 and #3"`, `"label all claude"` → restructure the array.
3. Agent applies the patch to `breakdown.json` and **re-renders** the numbered list.
4. Loop until the human says **"approve"**.

Why this shape: the human's input is free natural language (low friction for them),
but it lands precisely via stable numbers (unambiguous for the agent), and the
single source of truth stays a structured JSON artifact (no drift from free-text
parsing). Local and global edits are just different-granularity patches to the
same JSON.

Rendered preview the human sees:
```
Requirement: XXX  →  4 sub-issues proposed (order = dependency)

#1  Ledger base slice          [claude]  no blocker, starts first
#2  Redeem API + state machine [claude]  blocked-by #1
#3  Admin review page          [codex]   blocked-by #2
#4  Regression + integration   [claude]  blocked-by #3

parent: <requirement title>  body=<decomposition rationale>
————
Edit? (e.g. "#3 -> claude", "split #2 into two", "add a docs issue at the end")
or "approve" to enter batch generation?
```

### `.devlog/breakdown.json` schema

Agent writes, harness consumes. Engine-agnostic (like `.devlog/workpad.md`).

```jsonc
{
  "parentSummary": "string — goes into the parent issue body: design rationale + decomposition narrative",
  "subIssues": [
    {
      "title": "string — Linear-style: short, plain-language, outcome/deliverable-oriented",
      "description": "string — minimal; what 'done' means",
      "labels": ["claude"]          // engine routing label for THIS sub's eventual build
    }
    // ordered; index 0 = first to run, no blocker
  ]
}
```

- **Dependency chain is implicit by array order.** The harness wires
  `subIssues[i]` *blocked by* `subIssues[i-1]`. The agent never expresses
  dependencies — keeps the agent contract dumb and engine-agnostic; the harness
  owns the graph.
- The triggering requirement issue becomes the **parent**; `parentSummary` is
  written into its body. There is **no** redundant "design / breakdown"
  sub-issue — decomposition *is* the design work, already done by the agent; its
  rationale lives in the parent body.

### Approval → handoff to Phase 2

On "approve", the agent:
1. Ensures `.devlog/breakdown.json` is final and committed in the repo.
2. Applies the `design-breakdown` label to the requirement issue (the parent) in
   Linear (or equivalently records the approved breakdown so the poller picks it
   up). The label's meaning is **"approved breakdown ready for batch-generation"**
   — NOT "start a headless decomposition".

## Phase 2 — Headless batch-create + chain (poller)

### New `LinearClient` methods

The bridge currently has none of these (it only reads triggers + updates state +
comments).

| Method | GraphQL mutation | Purpose |
|---|---|---|
| `createIssue({teamId, title, description, parentId?, labelIds?})` | `issueCreate` | create each sub-issue (`parentId` = the trigger/parent issue) |
| `createRelation({issueId, relatedIssueId, type:"blocks"})` | `issueRelationCreate` | wire the blocking chain |
| `setIssueState(issueId, stateId)` | reuse existing `updateState` | move first sub → Todo, parent → In Progress, parent → Done |

### Batch-create (idempotent + resumable)

Creating N sub-issues + N−1 relations is multi-step and can die mid-way (network,
Linear 5xx). The sequence is ordered so a crash leaves a recoverable state:

1. **Resumability guard:** before creating, query Linear for sub-issues already
   parented to the trigger issue; **skip those whose title matches** an entry in
   `breakdown.json`. Avoids duplicates on retry.
2. Create all sub-issues (`issueCreate` with `parentId`, `labelIds`).
3. Wire the blocking chain (`issueRelationCreate`, `sub[i]` blocked-by `sub[i-1]`).
4. Parent → In Progress + write `parentSummary` into its body; `sub[0]` → Todo
   (the trigger state the existing build flow watches).
5. **Stamp `linear_breakdown_done_at` LAST** — this is the idempotency marker that
   permanently excludes the parent from re-decomposition/re-creation, mirroring
   the proven `linear_finalized_at` pattern.

If the run dies before step 5, the next tick re-enters and the resumability guard
(step 1) skips already-created subs.

### Poller reconcile — auto-progression (single owner)

Added to `poller.tick`, runs each tick alongside `fetchTriggerIssues`. The poller
is the **single owner** of all progression — both advancing subs and closing the
parent. No Linear blocking-relation auto-start trick (Linear does NOT auto-start
unblocked issues — it only flips the dependency indicator green).

For each breakdown-parent (a parent with `linear_breakdown_done_at` set):
1. **Advance:** find sub-issues whose blocker is now Done and that are still in a
   pre-trigger state → move them → Todo (trigger state). The existing build flow
   picks them up next tick.
2. **Close parent:** when *all* sub-issues are Done → parent → Done.

### Per-sub human gate (retained)

Each sub still goes through the normal build flow: dispatch → build → PR → In
Review → **human review + merge + mark sub Done**. The human checkpoint is the
merge of each sub. Auto-progression only fires *after* a sub is Done.

## Error handling & idempotency

| Failure | Handling |
|---|---|
| Decompose session re-runs / tick repeats | `linear_breakdown_done_at` marker (NULL → run; set → skip). Same pattern as `linear_finalized_at`. |
| Batch-create dies mid-way | Resumable: query existing subs by title before creating; stamp marker last. |
| Malformed / empty `breakdown.json` | Validate (≥1 sub-issue, non-empty titles). On failure: surface (move parent → a `breakdown-failed` state or comment + leave in place) and do NOT stamp. Never silent. |
| Linear read-replica lag after a write | Known artifact (see ARC-101 finding): a write then immediate read can be stale. Do not treat a stale read as a revert. Rely on markers, not re-read confirmation. |

## Scope — v1 boundary (YAGNI)

**In scope (v1):**
- Interactive numbered-preview decompose + NL correction loop.
- parent + sub-issues + implicit-order blocking chain.
- first-sub auto-start.
- poller auto-advance + poller parent-close.
- idempotent + resumable batch-create.

**Deferred (v2+):**
- Linear projects / milestones (the parent+sub-issues hierarchy is the right
  Linear granularity for a single requirement — "too large for one issue, too
  small for a project").
- Parallel (non-linear) dependency graphs.
- Re-decompose on scope change after creation.
- Sub-issue-of-sub-issue nesting.
- Cross-team sub-issues.

**The v1 line:** decomposition *quality* is the agent's job (Phase 1, with human
correction); the harness only guarantees the *mechanics* — issues exist, deps are
wired, the chain advances, the parent closes. We do not unit-test "is this a good
breakdown."

## Testing

**Unit (node:test — the bridge's existing harness; NOT `bun test`, better-sqlite3
fails under Bun):**
- `breakdown.ts` parse/validate: good JSON, empty, malformed, missing titles.
- reconcile: pure function — given sub states, computes the correct
  {advance these / close parent} set, no Linear calls.
- `LinearClient` new methods: mocked GraphQL, assert correct mutation + variables.
- batch-create resumability: given some subs already exist, skip-by-title is correct.

**Integration:**
- `dispatchIssue` routes `design-breakdown` → batch-create branch (not build).
- idempotency: `linear_breakdown_done_at` set → re-entry is a no-op.

**Live (non-waivable gate — real betakairos + real repo):**
1. Run a requirement through the interactive decompose + correction loop; approve.
2. Confirm in Linear UI: real parent body + N sub-issues + blocking chain.
3. First sub builds → PR → In Review.
4. On its merge, poller advances sub-2 → … (chain).
5. All subs Done → parent closes.

This full path is the ARC-100 acceptance.

## File structure (implementation preview, for the plan)

- **New** `src/core/linear/breakdown.ts` — `breakdown.json` parse/validate +
  batch-create orchestration (idempotent/resumable) + render-preview helper.
- **New** reconcile logic — pure function (own file or in `poller.ts`):
  given parent + sub states → {subs to advance, whether to close parent}.
- **Modify** `src/core/linear/client.ts` — add `createIssue`, `createRelation`,
  `setIssueState` (reuse `updateState`).
- **Modify** `src/core/linear/dispatcher.ts` — `dispatchIssue` routes
  `design-breakdown` → batch-create branch.
- **Modify** `src/core/linear/poller.ts` — `tick` runs reconcile alongside
  `fetchTriggerIssues`.
- **Modify** schema/migration — add `linear_breakdown_done_at` column (mirror
  `linear_finalized_at`; migration placement rule: last in `getDb`).

The interactive Phase 1 loop is driven in-session (agent + human), not by new
headless bridge code; it produces the committed `breakdown.json` + the
`design-breakdown` label that Phase 2 consumes.
