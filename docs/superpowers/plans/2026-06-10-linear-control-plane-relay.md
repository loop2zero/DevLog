# Linear Control-Plane Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relay the upstream control-plane (stage progress + human gates on `tasks.current_stage`/`tasks.gate_status`) to Linear comments, and feed human replies on Linear back into `processManager.resolveGate`, so the operator drives the whole loop from the Linear mobile app.

**Architecture:** New pure-logic module `src/core/linear/relay.ts` (injected deps, same pattern as `reconcile.ts`) with three steps per poller tick — `relayStages` (stage change → refresh workpad comment), `relayGates` (new gate → post dedicated gate comment), `pollGateReplies` (first non-watch comment after the gate comment → normalize → `resolveGate` → receipt). Watch-created comment ids live in a new `linear_relay_comments` registry table (watch and the human share one Linear account, so comment-id registry — not author — discriminates bot vs human). Engine-agnostic by construction.

**Tech Stack:** TypeScript, better-sqlite3, node:test + tsx (`bun run test` wraps `node --test`), fake Linear client + in-memory SQLite test pattern from `src/core/__tests__/linear-*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-06-10-linear-control-plane-relay-design.md`

**Pre-existing invariants you must not break:**
- `migrateLinearColumns` must remain the LAST migration in `getDb()` (after all table-recreation migrations) — see `db.ts` FIX 5 comment.
- Comments: at-least-once; `resolveGate`: exactly-once (core's "no pending gate" guard); stage writes only on change.
- Commits trigger a pre-commit hook (`bun run quality:precommit` = typecheck + full tests, ~30s). Don't bypass it.

---

### Task 1: Schema + migrations (3 task columns + registry table)

**Files:**
- Modify: `src/core/db-schema.ts` (tasks block — after the `linear_breakdown_done_at` line; new table after the `linear_breakdown_subs` block)
- Modify: `src/core/db.ts` (`migrateLinearColumns`; new `migrateRelayCommentsTable`; call it in `getDb()` right after `migrateBreakdownTable(_db)`)
- Test: `src/core/__tests__/linear-relay-migration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { makeTestDb } from "./test-helpers";
import { migrateLinearColumns, migrateRelayCommentsTable } from "../db";

function taskCols(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
}

test("fresh SCHEMA db has the relay columns and registry table", () => {
  const db = makeTestDb();
  const cols = taskCols(db);
  for (const c of ["linear_relayed_stage", "linear_gate_comment_id", "linear_gate_id"]) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
  // table exists and accepts a row
  db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('c1','i1','gate')").run();
  const row: any = db.prepare("SELECT * FROM linear_relay_comments WHERE comment_id='c1'").get();
  assert.equal(row.issue_id, "i1");
  assert.ok(row.created_at);
});

test("migrateLinearColumns adds relay columns to a bare legacy tasks table", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT,
    created_at TEXT, updated_at TEXT)`);
  migrateLinearColumns(db);
  const cols = taskCols(db);
  for (const c of ["linear_issue_id", "linear_relayed_stage", "linear_gate_comment_id", "linear_gate_id"]) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
  migrateLinearColumns(db); // idempotent
});

test("migrateRelayCommentsTable is idempotent and PK-deduped", () => {
  const db = new Database(":memory:");
  migrateRelayCommentsTable(db);
  migrateRelayCommentsTable(db);
  db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('c1','i1','gate')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('c1','i2','receipt')").run(),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-relay-migration.test.ts`
Expected: FAIL — `migrateRelayCommentsTable` is not exported; fresh-SCHEMA test missing columns.

- [ ] **Step 3: Implement**

In `src/core/db-schema.ts`, inside `CREATE TABLE IF NOT EXISTS tasks (...)`, directly after the `linear_breakdown_done_at TEXT,` line add:

```sql
  linear_relayed_stage TEXT,
  linear_gate_comment_id TEXT,
  linear_gate_id TEXT,
```

After the `linear_breakdown_subs` table block in the same SCHEMA string add:

```sql
CREATE TABLE IF NOT EXISTS linear_relay_comments (
  comment_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

(If SCHEMA does not contain `linear_breakdown_subs`, place the new table at the end of the SCHEMA string — and check where `linear-breakdown-migration.test.ts` asserts it instead.)

In `src/core/db.ts`, extend `migrateLinearColumns` (keep it LAST in `getDb()`):

```ts
  if (!cols.includes("linear_relayed_stage")) db.exec("ALTER TABLE tasks ADD COLUMN linear_relayed_stage TEXT");
  if (!cols.includes("linear_gate_comment_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_gate_comment_id TEXT");
  if (!cols.includes("linear_gate_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_gate_id TEXT");
```

Add below `migrateBreakdownTable`:

```ts
export function migrateRelayCommentsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS linear_relay_comments (
    comment_id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}
```

In `getDb()` after `migrateBreakdownTable(_db);` add `migrateRelayCommentsTable(_db);`.

Also add the three fields to the `Task` interface in `src/core/types-dashboard.ts` after `linear_finalized_at`:

```ts
  linear_relayed_stage?: string | null;
  linear_gate_comment_id?: string | null;
  linear_gate_id?: string | null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-relay-migration.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/db-schema.ts src/core/db.ts src/core/types-dashboard.ts src/core/__tests__/linear-relay-migration.test.ts
git commit -m "feat(linear): relay columns + linear_relay_comments registry table"
```

---

### Task 2: `LinearClient.fetchComments`

**Files:**
- Modify: `src/core/linear/client.ts`
- Test: `src/core/__tests__/linear-relay-client.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient } from "../linear/client";

function fakeFetch(data: unknown): { fn: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fn = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return { json: async () => ({ data }) } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

test("fetchComments returns id/body/createdAt for an issue", async () => {
  const { fn, calls } = fakeFetch({
    issue: { comments: { nodes: [
      { id: "cm1", body: "workpad", createdAt: "2026-06-10T01:00:00.000Z" },
      { id: "cm2", body: "Approve", createdAt: "2026-06-10T02:00:00.000Z" },
    ] } },
  });
  const client = new LinearClient("key", fn);
  const comments = await client.fetchComments("issue-1");
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[1], { id: "cm2", body: "Approve", createdAt: "2026-06-10T02:00:00.000Z" });
  assert.match(calls[0].query, /comments/);
  assert.equal(calls[0].variables.id, "issue-1");
});

test("fetchComments returns [] when the issue is unreadable", async () => {
  const { fn } = fakeFetch({ issue: null });
  const client = new LinearClient("key", fn);
  assert.deepEqual(await client.fetchComments("gone"), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-relay-client.test.ts`
Expected: FAIL — `fetchComments` does not exist.

- [ ] **Step 3: Implement**

In `src/core/linear/client.ts` add to `LinearClientI`:

```ts
  fetchComments(issueId: string): Promise<Array<{ id: string; body: string; createdAt: string }>>;
```

Add the query constant next to the others:

```ts
const Q_COMMENTS = `query($id:String!){ issue(id:$id){ comments(first:50){ nodes{ id body createdAt } } } }`;
```

Add the method to `LinearClient`:

```ts
  async fetchComments(issueId: string): Promise<Array<{ id: string; body: string; createdAt: string }>> {
    const d = await this.gql<{ issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string }> } } | null }>(Q_COMMENTS, { id: issueId });
    return d.issue?.comments.nodes ?? [];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-relay-client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/client.ts src/core/__tests__/linear-relay-client.test.ts
git commit -m "feat(linear): client fetchComments for gate reply polling"
```

---

### Task 3: `assembleWorkpad` stage line

**Files:**
- Modify: `src/core/linear/state-map.ts`
- Test: Modify `src/core/__tests__/linear-state-map.test.ts` (append tests)

- [ ] **Step 1: Write the failing test** (append to the existing file)

```ts
test("assembleWorkpad renders a stage line when provided", () => {
  const out = assembleWorkpad({ engine: "claude", branch: "b", state: "In Progress", stamp: "h:p@s", stage: "3/7 · running tests" });
  assert.match(out, /- stage: 3\/7 · running tests/);
  // stage line sits between state and engine context lines
  assert.ok(out.indexOf("- state:") < out.indexOf("- stage:"));
});

test("assembleWorkpad omits the stage line when absent", () => {
  const out = assembleWorkpad({ engine: "claude", branch: "b", state: "In Progress", stamp: "h:p@s" });
  assert.ok(!out.includes("- stage:"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-state-map.test.ts`
Expected: FAIL — TypeScript/object shape: `stage` not in `WorkpadParts`, no stage line rendered.

- [ ] **Step 3: Implement**

In `src/core/linear/state-map.ts`, add to `WorkpadParts`:

```ts
  stage?: string | null;
```

In `assembleWorkpad`'s header array, directly after the `- state:` line add:

```ts
    ...(p.stage ? [`- stage: ${p.stage}`] : []),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-state-map.test.ts`
Expected: PASS (all, including the 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/state-map.ts src/core/__tests__/linear-state-map.test.ts
git commit -m "feat(linear): workpad header stage line"
```

---

### Task 4: relay pure helpers (reply normalization, comment bodies, registry)

**Files:**
- Create: `src/core/linear/relay.ts`
- Test: `src/core/__tests__/linear-relay.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import {
  normalizeGateReply,
  buildGateCommentBody,
  buildGateReceiptBody,
  registerRelayComment,
  isRelayComment,
} from "../linear/relay";

const OPTS = ["Approve", "Revise plan"];

test("normalizeGateReply maps an option number to the option text", () => {
  assert.equal(normalizeGateReply("2", OPTS), "Revise plan");
  assert.equal(normalizeGateReply(" 1 ", OPTS), "Approve");
});

test("normalizeGateReply matches options case-insensitively", () => {
  assert.equal(normalizeGateReply("approve", OPTS), "Approve");
  assert.equal(normalizeGateReply("REVISE PLAN", OPTS), "Revise plan");
});

test("normalizeGateReply passes free text through verbatim (trimmed)", () => {
  assert.equal(normalizeGateReply("  Approve, but verify on staging first  ", OPTS), "Approve, but verify on staging first");
  // out-of-range numbers are NOT treated as option indexes
  assert.equal(normalizeGateReply("9", OPTS), "9");
  // no options → always verbatim
  assert.equal(normalizeGateReply("2", []), "2");
});

test("buildGateCommentBody contains gate id, question, numbered options, stage", () => {
  const body = buildGateCommentBody({ id: "gate_1", question: "Approve the migration plan?", options: OPTS, created_at: "t", stage: "2/4 · plan review" });
  assert.match(body, /⚠️ GATE/);
  assert.match(body, /\[gate_1\]/);
  assert.match(body, /Approve the migration plan\?/);
  assert.match(body, /1\. Approve/);
  assert.match(body, /2\. Revise plan/);
  assert.match(body, /2\/4 · plan review/);
});

test("buildGateReceiptBody distinguishes linear-delivered vs resolved-elsewhere", () => {
  const a = buildGateReceiptBody("gate_1", "Approve", "linear");
  assert.match(a, /✅ GATE resolved/);
  assert.match(a, /Approve/);
  const b = buildGateReceiptBody("gate_1", "", "elsewhere");
  assert.match(b, /resolved elsewhere/);
});

test("registry: registerRelayComment is idempotent and isRelayComment discriminates", () => {
  const db = makeTestDb();
  registerRelayComment(db, "cm1", "i1", "gate");
  registerRelayComment(db, "cm1", "i1", "gate"); // no throw (INSERT OR IGNORE)
  assert.equal(isRelayComment(db, "cm1"), true);
  assert.equal(isRelayComment(db, "cm-human"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: FAIL — module `../linear/relay` does not exist.

- [ ] **Step 3: Implement** — create `src/core/linear/relay.ts`:

```ts
import type Database from "better-sqlite3";
import type { GateStatus } from "../types-dashboard";

export function normalizeGateReply(body: string, options: string[]): string {
  const trimmed = body.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10);
    if (idx >= 1 && idx <= options.length) return options[idx - 1];
  }
  const hit = options.find((o) => o.trim().toLowerCase() === trimmed.toLowerCase());
  return hit ?? trimmed;
}

export function buildGateCommentBody(gate: GateStatus): string {
  const lines = [
    `## ⚠️ GATE — needs your confirmation \`[${gate.id}]\``,
    "",
    ...(gate.stage ? [`stage: ${gate.stage}`, ""] : []),
    `**Q: ${gate.question}**`,
  ];
  if (gate.options.length > 0) {
    lines.push("", ...gate.options.map((o, i) => `${i + 1}. ${o}`));
  }
  lines.push("", "_Reply to this issue with an option number or free text — the watch relays it to the agent._");
  return lines.join("\n");
}

export function buildGateReceiptBody(gateId: string, response: string, via: "linear" | "elsewhere"): string {
  if (via === "elsewhere") {
    return `## ✅ GATE resolved elsewhere \`[${gateId}]\`\n\nThe gate was answered outside Linear (e.g. DevLog UI); nothing to do here.`;
  }
  return `## ✅ GATE resolved \`[${gateId}]\`\n\nReply delivered to the agent:\n\n> ${response}`;
}

export function registerRelayComment(db: Database.Database, commentId: string, issueId: string, kind: string): void {
  db.prepare("INSERT OR IGNORE INTO linear_relay_comments (comment_id, issue_id, kind) VALUES (?, ?, ?)").run(commentId, issueId, kind);
}

export function isRelayComment(db: Database.Database, commentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM linear_relay_comments WHERE comment_id = ?").get(commentId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/relay.ts src/core/__tests__/linear-relay.test.ts
git commit -m "feat(linear): relay pure helpers — reply normalization, gate comment bodies, comment registry"
```

---

### Task 5: `relayStages`

**Files:**
- Modify: `src/core/linear/relay.ts`
- Test: append to `src/core/__tests__/linear-relay.test.ts`

**Behavior:** rows of the watched project with a linked issue, a workpad comment, an unfinalized task, a live session join, and `current_stage` differing from `linear_relayed_stage`: re-render the workpad comment (stage line + AWAITING INPUT state if a gate is pending + best-effort narrative re-read), then stamp `linear_relayed_stage`. Unchanged stage ⇒ zero Linear calls. Per-row failures are swallowed (retry next tick).

- [ ] **Step 1: Write the failing test** (append; also add these imports at the top of the test file: `relayStages`, `RelayDeps` from `../linear/relay`, and `normalizeWatchConfig` from `../linear/types`)

```ts
function seedLinked(db: any, opts: { taskId?: string; issue?: string; stage?: string | null; relayed?: string | null; gate?: string | null } = {}) {
  const taskId = opts.taskId ?? "t1";
  const sid = `s-${taskId}`;
  db.prepare(
    `INSERT INTO sessions (id, project_id, status, branch_name, worktree_path, local_cli_agent_id)
     VALUES (?, 'repo1', 'running', 'feat/x', '/tmp/wt', 'claude')`,
  ).run(sid);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, session_id, linear_issue_id, linear_workpad_comment_id, current_stage, linear_relayed_stage, gate_status, created_at, updated_at)
     VALUES (?, 'repo1', 'x', 'in_progress', ?, ?, 'wp-comment', ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(taskId, sid, opts.issue ?? "iss1", opts.stage ?? null, opts.relayed ?? null, opts.gate ?? null);
  return { taskId, sid };
}

function makeRelayDeps(db: any, over: Partial<RelayDeps> = {}): RelayDeps & { updates: any[]; creates: any[] } {
  const updates: any[] = [];
  const creates: any[] = [];
  return {
    db,
    w: normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" }),
    client: {
      updateComment: async (id: string, body: string) => { updates.push([id, body]); },
      createComment: async (_issueId: string, body: string) => { creates.push(body); return `cm-${creates.length}`; },
      fetchComments: async () => [],
    },
    resolveGate: () => ({ ok: true as const }),
    readWorkpadFile: async () => "narrative from file",
    updates,
    creates,
    ...over,
  } as any;
}

test("relayStages refreshes the workpad once when stage changed, then stamps", async () => {
  const db = makeTestDb();
  seedLinked(db, { stage: "3/7 · tests", relayed: null });
  const deps = makeRelayDeps(db);
  await relayStages(deps);
  assert.equal(deps.updates.length, 1);
  assert.equal(deps.updates[0][0], "wp-comment");
  assert.match(deps.updates[0][1], /- stage: 3\/7 · tests/);
  assert.match(deps.updates[0][1], /narrative from file/);
  const row: any = db.prepare("SELECT linear_relayed_stage FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_relayed_stage, "3/7 · tests");
  // second tick: no change → zero writes
  await relayStages(deps);
  assert.equal(deps.updates.length, 1);
});

test("relayStages shows AWAITING INPUT while a gate is pending", async () => {
  const db = makeTestDb();
  const gate = JSON.stringify({ id: "g1", question: "ok?", options: [], created_at: "t", stage: null });
  seedLinked(db, { stage: "2/4", gate });
  const deps = makeRelayDeps(db);
  await relayStages(deps);
  assert.match(deps.updates[0][1], /AWAITING INPUT/);
});

test("relayStages tolerates a failing workpad file read", async () => {
  const db = makeTestDb();
  seedLinked(db, { stage: "1/2" });
  const deps = makeRelayDeps(db, { readWorkpadFile: async () => { throw new Error("no file"); } });
  await relayStages(deps);
  assert.equal((deps as any).updates.length, 1); // still updates, placeholder body
});

test("relayStages skips finalized and stage-null rows", async () => {
  const db = makeTestDb();
  seedLinked(db, { taskId: "t-null", stage: null });
  const { taskId } = seedLinked(db, { taskId: "t-fin", issue: "iss2", stage: "9/9" });
  db.prepare("UPDATE tasks SET linear_finalized_at = datetime('now') WHERE id = ?").run(taskId);
  const deps = makeRelayDeps(db);
  await relayStages(deps);
  assert.equal((deps as any).updates.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: FAIL — `relayStages` / `RelayDeps` not exported.

- [ ] **Step 3: Implement** — append to `src/core/linear/relay.ts`:

```ts
import { readFile } from "fs/promises";
import { hostname } from "os";
import type { LinearClientI } from "./client";
import type { EngineId, LinearWatchConfig } from "./types";
import { assembleWorkpad } from "./state-map";
import { parseGateStatus } from "../control-plane-state";

export interface RelayDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "createComment" | "updateComment" | "fetchComments">;
  w: LinearWatchConfig;
  resolveGate: (sessionId: string, response: string) => { ok: true } | { ok: false; error: string };
  /** Injectable for tests; defaults to reading <worktree>/.devlog/workpad.md */
  readWorkpadFile?: (worktreePath: string) => Promise<string>;
}

interface RelayRow {
  tid: string;
  sid: string;
  iid: string;
  cid: string | null;
  stage: string | null;
  relayed: string | null;
  gate: string | null;
  gateCommentId: string | null;
  relayedGateId: string | null;
  branch: string | null;
  wp: string | null;
  engine: string | null;
}

const Q_ROWS = `
  SELECT t.id AS tid, t.session_id AS sid, t.linear_issue_id AS iid, t.linear_workpad_comment_id AS cid,
         t.current_stage AS stage, t.linear_relayed_stage AS relayed, t.gate_status AS gate,
         t.linear_gate_comment_id AS gateCommentId, t.linear_gate_id AS relayedGateId,
         s.branch_name AS branch, s.worktree_path AS wp, s.local_cli_agent_id AS engine
  FROM tasks t JOIN sessions s ON s.id = t.session_id
  WHERE t.project_id = ? AND t.linear_issue_id IS NOT NULL AND t.linear_finalized_at IS NULL`;

function relayRows(db: Database.Database, w: LinearWatchConfig): RelayRow[] {
  return db.prepare(Q_ROWS).all(w.devlogProjectId) as RelayRow[];
}

async function renderWorkpad(deps: RelayDeps, row: RelayRow): Promise<string> {
  const read = deps.readWorkpadFile ?? ((wp: string) => readFile(`${wp}/.devlog/workpad.md`, "utf-8"));
  let agentBody: string | null = null;
  try {
    agentBody = row.wp ? await read(row.wp) : null;
  } catch {
    agentBody = null;
  }
  const state = row.gate ? "In Progress — AWAITING INPUT" : "In Progress";
  return assembleWorkpad({
    engine: (row.engine as EngineId) ?? "claude",
    branch: row.branch ?? "?",
    state,
    stage: row.stage,
    stamp: `${hostname()}:${row.wp ?? "?"}@run`,
    agentBody,
  });
}

export async function relayStages(deps: RelayDeps): Promise<void> {
  const rows = relayRows(deps.db, deps.w).filter(
    (r) => r.cid && r.stage != null && r.stage !== r.relayed,
  );
  for (const row of rows) {
    try {
      await deps.client.updateComment(row.cid!, await renderWorkpad(deps, row));
      deps.db.prepare("UPDATE tasks SET linear_relayed_stage = ?, updated_at = datetime('now') WHERE id = ?").run(row.stage, row.tid);
    } catch (e) {
      console.error("[linear relay] stage row failed", row.iid, e);
    }
  }
}
```

(Keep the existing Task-4 exports above; merge the `Database` type import — it is already imported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/relay.ts src/core/__tests__/linear-relay.test.ts
git commit -m "feat(linear): relayStages — change-only workpad stage refresh"
```

---

### Task 6: `relayGates`

**Files:**
- Modify: `src/core/linear/relay.ts`
- Test: append to `src/core/__tests__/linear-relay.test.ts`

**Behavior:** rows with a parsed `gate_status` whose gate id differs from `linear_gate_id`: post the gate comment, register it (`kind='gate'`), store `linear_gate_comment_id` + `linear_gate_id`, and best-effort refresh the workpad to AWAITING INPUT. Same gate id ⇒ no repost.

- [ ] **Step 1: Write the failing test** (append; import `relayGates`)

```ts
const GATE_G1 = JSON.stringify({ id: "g1", question: "Approve the plan?", options: ["Approve", "Revise"], created_at: "t0", stage: "2/4" });

test("relayGates posts exactly one gate comment per gate id and records it", async () => {
  const db = makeTestDb();
  seedLinked(db, { gate: GATE_G1, stage: "2/4" });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /\[g1\]/);
  assert.match(deps.creates[0], /1\. Approve/);
  const row: any = db.prepare("SELECT linear_gate_comment_id, linear_gate_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_comment_id, "cm-1");
  assert.equal(row.linear_gate_id, "g1");
  const reg: any = db.prepare("SELECT kind FROM linear_relay_comments WHERE comment_id='cm-1'").get();
  assert.equal(reg.kind, "gate");
  // second tick, same gate → no new comment
  await relayGates(deps);
  assert.equal(deps.creates.length, 1);
});

test("relayGates posts a NEW comment when core overwrote the gate with a new id", async () => {
  const db = makeTestDb();
  seedLinked(db, { gate: GATE_G1 });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  const g2 = JSON.stringify({ id: "g2", question: "Second question?", options: [], created_at: "t1", stage: null });
  db.prepare("UPDATE tasks SET gate_status = ? WHERE id='t1'").run(g2);
  await relayGates(deps);
  assert.equal(deps.creates.length, 2);
  const row: any = db.prepare("SELECT linear_gate_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_id, "g2");
});

test("relayGates skips rows with unparseable gate_status", async () => {
  const db = makeTestDb();
  seedLinked(db, { gate: "not-json" });
  const deps = makeRelayDeps(db);
  await relayGates(deps);
  assert.equal(deps.creates.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: FAIL — `relayGates` not exported.

- [ ] **Step 3: Implement** — append to `src/core/linear/relay.ts`:

```ts
export async function relayGates(deps: RelayDeps): Promise<void> {
  const rows = relayRows(deps.db, deps.w).filter((r) => r.gate != null);
  for (const row of rows) {
    const gate = parseGateStatus(row.gate);
    if (!gate || gate.id === row.relayedGateId) continue;
    try {
      const commentId = await deps.client.createComment(row.iid, buildGateCommentBody(gate));
      registerRelayComment(deps.db, commentId, row.iid, "gate");
      deps.db.prepare(
        "UPDATE tasks SET linear_gate_comment_id = ?, linear_gate_id = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(commentId, gate.id, row.tid);
      if (row.cid) {
        try {
          await deps.client.updateComment(row.cid, await renderWorkpad(deps, row));
        } catch {
          /* workpad refresh is best-effort */
        }
      }
    } catch (e) {
      console.error("[linear relay] gate row failed", row.iid, e);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/relay.ts src/core/__tests__/linear-relay.test.ts
git commit -m "feat(linear): relayGates — dedicated gate comment, exactly-once per gate id"
```

---

### Task 7: `pollGateReplies`

**Files:**
- Modify: `src/core/linear/relay.ts`
- Test: append to `src/core/__tests__/linear-relay.test.ts`

**Behavior:** rows with `linear_gate_comment_id` set:
- `gate_status` NULL ⇒ resolved elsewhere: post `elsewhere` receipt, register it, clear `linear_gate_comment_id` (keep `linear_gate_id`), refresh workpad. No `resolveGate`.
- otherwise: fetch comments; find the gate comment by id to get its `createdAt`; first later comment not in the registry = human reply → `normalizeGateReply` → `deps.resolveGate(sid, response)`. `ok` ⇒ `linear` receipt + register + clear + workpad refresh. `!ok` ⇒ treat as resolved-elsewhere.
- No reply yet ⇒ do nothing.

- [ ] **Step 1: Write the failing test** (append; import `pollGateReplies`)

```ts
function seedPendingGate(db: any) {
  const ids = seedLinked(db, { gate: GATE_G1, stage: "2/4" });
  db.prepare("UPDATE tasks SET linear_gate_comment_id='cm-gate', linear_gate_id='g1' WHERE id='t1'").run();
  db.prepare("INSERT OR IGNORE INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('cm-gate','iss1','gate')").run();
  return ids;
}

const GATE_COMMENT = { id: "cm-gate", body: "gate body", createdAt: "2026-06-10T01:00:00.000Z" };

test("pollGateReplies resolves once from the first human reply and posts a receipt", async () => {
  const db = makeTestDb();
  const { sid } = seedPendingGate(db);
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  (deps.client as any).fetchComments = async () => [
    GATE_COMMENT,
    { id: "cm-human", body: "2", createdAt: "2026-06-10T02:00:00.000Z" },
  ];
  await pollGateReplies(deps);
  assert.deepEqual(resolved, [[sid, "Revise"]]); // "2" normalized to option 2
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /✅ GATE resolved/);
  const row: any = db.prepare("SELECT linear_gate_comment_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_comment_id, null);
  // the receipt is registered, so a later gate cannot mistake it for a human reply
  const receiptRegistered: any = db.prepare("SELECT 1 FROM linear_relay_comments WHERE comment_id='cm-1'").get();
  assert.ok(receiptRegistered);
});

test("pollGateReplies ignores watch-created comments and earlier comments", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  db.prepare("INSERT INTO linear_relay_comments (comment_id, issue_id, kind) VALUES ('cm-wp','iss1','workpad')").run();
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  (deps.client as any).fetchComments = async () => [
    { id: "cm-earlier", body: "pre-gate human note", createdAt: "2026-06-10T00:30:00.000Z" },
    GATE_COMMENT,
    { id: "cm-wp", body: "workpad refresh", createdAt: "2026-06-10T01:30:00.000Z" },
  ];
  await pollGateReplies(deps);
  assert.equal(resolved.length, 0);
  assert.equal(deps.creates.length, 0);
});

test("pollGateReplies handles resolved-elsewhere without calling resolveGate", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  db.prepare("UPDATE tasks SET gate_status = NULL WHERE id='t1'").run();
  const resolved: any[] = [];
  const deps = makeRelayDeps(db, {
    resolveGate: (s: string, r: string) => { resolved.push([s, r]); return { ok: true as const }; },
  });
  await pollGateReplies(deps);
  assert.equal(resolved.length, 0);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /resolved elsewhere/);
  const row: any = db.prepare("SELECT linear_gate_comment_id FROM tasks WHERE id='t1'").get();
  assert.equal(row.linear_gate_comment_id, null);
  // exactly-once: a second tick posts nothing
  await pollGateReplies(deps);
  assert.equal(deps.creates.length, 1);
});

test("pollGateReplies treats a resolveGate failure as resolved-elsewhere", async () => {
  const db = makeTestDb();
  seedPendingGate(db);
  const deps = makeRelayDeps(db, {
    resolveGate: () => ({ ok: false as const, error: "no pending gate" }),
  });
  (deps.client as any).fetchComments = async () => [
    GATE_COMMENT,
    { id: "cm-human", body: "Approve", createdAt: "2026-06-10T02:00:00.000Z" },
  ];
  await pollGateReplies(deps);
  assert.equal(deps.creates.length, 1);
  assert.match(deps.creates[0], /resolved elsewhere/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: FAIL — `pollGateReplies` not exported.

- [ ] **Step 3: Implement** — append to `src/core/linear/relay.ts`:

```ts
async function settleGate(
  deps: RelayDeps,
  row: RelayRow,
  receipt: string,
): Promise<void> {
  const receiptId = await deps.client.createComment(row.iid, receipt);
  registerRelayComment(deps.db, receiptId, row.iid, "receipt");
  deps.db.prepare(
    "UPDATE tasks SET linear_gate_comment_id = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(row.tid);
  if (row.cid) {
    try {
      const fresh = relayRows(deps.db, deps.w).find((r) => r.tid === row.tid);
      if (fresh) await deps.client.updateComment(row.cid, await renderWorkpad(deps, fresh));
    } catch {
      /* best-effort */
    }
  }
}

export async function pollGateReplies(deps: RelayDeps): Promise<void> {
  const rows = relayRows(deps.db, deps.w).filter((r) => r.gateCommentId != null);
  for (const row of rows) {
    try {
      if (row.gate == null) {
        // Resolved on another surface (e.g. DevLog web UI) — close the Linear loop.
        await settleGate(deps, row, buildGateReceiptBody(row.relayedGateId ?? "?", "", "elsewhere"));
        continue;
      }
      const gate = parseGateStatus(row.gate);
      if (!gate) continue;

      const comments = await deps.client.fetchComments(row.iid);
      const gateComment = comments.find((c) => c.id === row.gateCommentId);
      if (!gateComment) continue;
      const reply = comments.find(
        (c) => c.createdAt > gateComment.createdAt && !isRelayComment(deps.db, c.id) && c.body.trim() !== "",
      );
      if (!reply) continue;

      const response = normalizeGateReply(reply.body, gate.options);
      const result = deps.resolveGate(row.sid, response);
      if (result.ok) {
        await settleGate(deps, row, buildGateReceiptBody(gate.id, response, "linear"));
      } else {
        await settleGate(deps, row, buildGateReceiptBody(gate.id, "", "elsewhere"));
      }
    } catch (e) {
      console.error("[linear relay] reply row failed", row.iid, e);
    }
  }
}

export async function relayControlPlane(deps: RelayDeps): Promise<void> {
  await relayStages(deps);
  await relayGates(deps);
  await pollGateReplies(deps);
}
```

Note: ISO-8601 UTC strings compare correctly as strings — no Date parsing needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-relay.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/relay.ts src/core/__tests__/linear-relay.test.ts
git commit -m "feat(linear): pollGateReplies — registry-discriminated human reply → resolveGate, receipts, resolved-elsewhere"
```

---

### Task 8: tick wiring (`poller.ts` + `wiring.ts`)

**Files:**
- Modify: `src/core/linear/poller.ts` (add `relay` to `TickDeps`, call after `reconcile`)
- Modify: `src/core/linear/wiring.ts` (construct relay deps; register workpad comment ids at dispatch)
- Test: Modify `src/core/__tests__/linear-poller.test.ts` (existing TickDeps literals gain `relay: async () => {}`; add order test)

- [ ] **Step 1: Write the failing test** (append to `linear-poller.test.ts`; also add `relay: async () => {}` to every existing TickDeps literal in that file so it compiles)

```ts
test("tick runs finalize → reconcile → relay → dispatch in order", async () => {
  const calls: string[] = [];
  const db = makeTestDb();
  await tick({
    db,
    client: { fetchTriggerIssues: async () => { calls.push("fetch"); return []; } } as any,
    watch: normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" }),
    onDispatch: async () => { calls.push("dispatch"); },
    finalize: async () => { calls.push("finalize"); },
    reconcile: async () => { calls.push("reconcile"); },
    relay: async () => { calls.push("relay"); },
    stateIds: { trigger: "t", inProgress: "p", review: "r", done: "d", parked: "b", parkedName: "Backlog", terminalNames: [] },
  });
  assert.deepEqual(calls, ["finalize", "reconcile", "relay", "fetch"]);
});
```

(Match the existing test file's import style for `tick`, `makeTestDb`, `normalizeWatchConfig` — they are already imported there.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-poller.test.ts`
Expected: FAIL — `relay` not in `TickDeps` (TS error via tsx) or order assertion fails.

- [ ] **Step 3: Implement**

`src/core/linear/poller.ts`: add to `TickDeps`:

```ts
  relay: () => Promise<void>;
```

In `tick`, after `await deps.reconcile();` add:

```ts
  await deps.relay();
```

`src/core/linear/wiring.ts`:

1. Add imports:

```ts
import { relayControlPlane, registerRelayComment } from "./relay";
import { processManager } from "../process-manager";
```

2. In the `deps: TickDeps` literal (next to `reconcile`), add:

```ts
      relay: async () => {
        await relayControlPlane({
          db,
          client,
          w,
          resolveGate: (sid, resp) => processManager.resolveGate(sid, resp),
        });
      },
```

3. In `onDispatch`, after EACH of the two `db.prepare("UPDATE tasks SET linear_workpad_comment_id = ...").run(commentId, issue.id)` calls (success and BLOCKED branches), add:

```ts
        registerRelayComment(db, commentId, issue.id, "workpad");
```

4. Also register the breakdown-failure comment if present (`createComment` call in the breakdown branch): capture its return and register with kind `"breakdown-failure"`:

```ts
            const failureCommentId = await client.createComment(issue.id, `**Breakdown failed:** ${result.error}. Fix \`.devlog/breakdown.json\` and re-label.`);
            registerRelayComment(db, failureCommentId, issue.id, "breakdown-failure");
```

(Keep the existing dedup guard around that comment if one exists — only add the registration.)

- [ ] **Step 4: Run tests + typecheck**

Run: `node --test --import tsx src/core/__tests__/linear-poller.test.ts` → PASS
Run: `bun run typecheck` → clean (this catches every other TickDeps literal that still misses `relay` — fix them with `relay: async () => {}`)

- [ ] **Step 5: Run the full suite**

Run: `TZ=Asia/Shanghai bun run test`
Expected: all green (316 baseline + ~22 new)

- [ ] **Step 6: Commit**

```bash
git add src/core/linear/poller.ts src/core/linear/wiring.ts src/core/__tests__/linear-poller.test.ts
git commit -m "feat(linear): wire relayControlPlane into the poller tick; register watch comments"
```

---

### Task 9: full-suite + typecheck sanity (gate for ship 4.0)

- [ ] **Step 1:** `bun run typecheck` → clean
- [ ] **Step 2:** `TZ=Asia/Shanghai bun run test` → all pass, record counts
- [ ] **Step 3:** `bun run quality:build` → web + cli build green
- [ ] **Step 4:** No commit needed if clean; otherwise fix and commit as `fix(linear): ...`

---

## Self-review notes

- **Spec coverage:** GWT-1 → Task 5; GWT-2 → Task 6; GWT-3 → Task 7 (normalize matrix in Task 4); GWT-4 → Task 7 (elsewhere + failure path); GWT-5 → per-row try/catch (Tasks 5–7) + tick's own catch; GWT-6 → all relay state in SQLite (Task 1), re-derived each tick.
- **Registry discrimination** (same-account constraint) → Tasks 4, 7, 8 (workpad registration at dispatch).
- **FIX 5 invariant** preserved — Task 1 only appends to `migrateLinearColumns` and adds a separate CREATE-IF-NOT-EXISTS table.
- **Types:** `RelayRow`/`RelayDeps` defined Task 5, reused Tasks 6–7; `relay` field added to `TickDeps` literals everywhere (Task 8 Step 4 catches strays via typecheck).
