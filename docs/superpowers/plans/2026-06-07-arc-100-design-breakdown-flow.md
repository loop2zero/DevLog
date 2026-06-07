# ARC-100 Live Linear `design-breakdown` Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire human-corrected, agent-driven requirement decomposition into the live DevLog↔Linear bridge so an approved breakdown becomes a real parent + ordered sub-issues + blocking chain that auto-executes (first sub builds, human merges, poller advances the next, parent closes).

**Architecture:** Phase 1 (decompose + human correction) is interactive and out of scope for new bridge code — it produces a committed `.devlog/breakdown.json` and the `design-breakdown` label on the requirement issue. Phase 2 (this plan) is headless: the poller reads `breakdown.json`, batch-creates the Linear structure (idempotent/resumable), and each tick runs a reconcile that advances unblocked subs and closes the finished parent. The poller is the single owner of progression. The agent never touches Linear; the harness owns all Linear writes.

**Tech Stack:** TypeScript, better-sqlite3, Linear GraphQL API, node:test (run via `node --test --import tsx`, NOT `bun test` — better-sqlite3 fails under Bun).

**Spec:** `docs/superpowers/specs/2026-06-07-arc-100-design-breakdown-flow-design.md`

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/core/db-schema.ts` | `linear_breakdown_subs` table + `linear_breakdown_done_at` column in base SCHEMA | Modify |
| `src/core/db.ts` | idempotent migrations for the above | Modify |
| `src/core/linear/types.ts` | `breakdownLabel` watch-config field | Modify |
| `src/core/linear/client.ts` | new GraphQL methods: `createIssue`, `createRelation`, `updateIssueBody`, `fetchChildIssues`, `fetchTeamAndLabels`; `fetchWorkflowStates` returns `type` | Modify |
| `src/core/linear/breakdown.ts` | pure: parse/validate `breakdown.json` + render numbered preview | Create |
| `src/core/linear/reconcile.ts` | pure `computeReconcile` + `reconcileBreakdowns` DB/Linear integration | Create |
| `src/core/linear/batch-create.ts` | `runBreakdown` orchestration (read json → resumable create → relations → states → DB rows) | Create |
| `src/core/linear/poller.ts` | `tick` calls `reconcile` each cycle | Modify |
| `src/core/linear/wiring.ts` | `resolveStateIds` extended; route breakdown label → `runBreakdown`; resolve team+labels; pass `reconcile` | Modify |

Tests live in `src/core/__tests__/` following the existing `linear-*.test.ts` files. Test DB via `makeTestDb()` from `./test-helpers`; mock Linear via a `fakeFetch` passed to `new LinearClient("KEY", fakeFetch)`.

---

### Task 1: DB — breakdown column + sub-order table

**Files:**
- Modify: `src/core/db-schema.ts` (add table to `SCHEMA`)
- Modify: `src/core/db.ts` (`migrateLinearColumns` + new `migrateBreakdownTable`)
- Test: `src/core/__tests__/linear-breakdown-migration.test.ts`

The reconcile step needs the chain order; we store it in `linear_breakdown_subs(parent_issue_id, child_issue_id, child_identifier, position)`. The idempotency marker is a new `linear_breakdown_done_at` column on `tasks` (mirrors the proven `linear_finalized_at`).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/__tests__/linear-breakdown-migration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateLinearColumns, migrateBreakdownTable } from "../db";
import { makeTestDb } from "./test-helpers";

test("migrateLinearColumns adds linear_breakdown_done_at to a bare tasks table", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
  migrateLinearColumns(db);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("linear_breakdown_done_at"));
});

test("migrateBreakdownTable creates linear_breakdown_subs and is idempotent", () => {
  const db = new Database(":memory:");
  migrateBreakdownTable(db);
  migrateBreakdownTable(db); // second call must not throw
  db.prepare(
    "INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES ('p','c','ARC-2',1)",
  ).run();
  const row: any = db.prepare("SELECT * FROM linear_breakdown_subs WHERE child_issue_id='c'").get();
  assert.equal(row.position, 1);
  assert.equal(row.parent_issue_id, "p");
});

test("fresh SCHEMA db already has the breakdown column and table", () => {
  const db = makeTestDb();
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("linear_breakdown_done_at"));
  assert.doesNotThrow(() =>
    db.prepare("SELECT COUNT(*) FROM linear_breakdown_subs").get(),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-breakdown-migration.test.ts`
Expected: FAIL — `migrateBreakdownTable` is not exported; column/table absent.

- [ ] **Step 3: Add the column to `migrateLinearColumns` and a new migration**

In `src/core/db.ts`, add one line inside `migrateLinearColumns` (after the `linear_finalized_at` line):

```ts
  if (!cols.includes("linear_breakdown_done_at")) db.exec("ALTER TABLE tasks ADD COLUMN linear_breakdown_done_at TEXT");
```

Add a new exported function (place it directly below `migrateLinearColumns`):

```ts
export function migrateBreakdownTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS linear_breakdown_subs (
    parent_issue_id TEXT NOT NULL,
    child_issue_id TEXT NOT NULL,
    child_identifier TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parent_issue_id, position)
  )`);
}
```

Call it in `getDb()` immediately after the existing `migrateLinearColumns(_db);` line:

```ts
  migrateLinearColumns(_db);
  migrateBreakdownTable(_db);
```

- [ ] **Step 4: Add the same DDL to the base SCHEMA**

In `src/core/db-schema.ts`, add to the `SCHEMA` string (near the other `CREATE TABLE` statements):

```sql
CREATE TABLE IF NOT EXISTS linear_breakdown_subs (
  parent_issue_id TEXT NOT NULL,
  child_issue_id TEXT NOT NULL,
  child_identifier TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parent_issue_id, position)
);
```

Also add `linear_breakdown_done_at TEXT` to the `tasks` column list in `SCHEMA` (alongside `linear_finalized_at`).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-breakdown-migration.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Commit**

```bash
git add src/core/db.ts src/core/db-schema.ts src/core/__tests__/linear-breakdown-migration.test.ts
git commit -m "feat(linear): breakdown idempotency column + sub-order table"
```

---

### Task 2: types — `breakdownLabel` watch-config field

**Files:**
- Modify: `src/core/linear/types.ts`
- Test: `src/core/__tests__/linear-config.test.ts` (add cases)

The label that marks an approved breakdown is configurable, defaulting to `design-breakdown`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/__tests__/linear-config.test.ts`:

```ts
import { normalizeWatchConfig } from "../linear/types";

test("normalizeWatchConfig defaults breakdownLabel to design-breakdown (lowercased)", () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  assert.equal(w.breakdownLabel, "design-breakdown");
});

test("normalizeWatchConfig lowercases an explicit breakdownLabel", () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r", breakdownLabel: "Design-Breakdown" });
  assert.equal(w.breakdownLabel, "design-breakdown");
});
```

(If `linear-config.test.ts` lacks the `test`/`assert` imports for these, they already exist at the top of that file — reuse them; do not redeclare.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-config.test.ts`
Expected: FAIL — `breakdownLabel` is `undefined`.

- [ ] **Step 3: Add the field**

In `src/core/linear/types.ts`, add to `LinearWatchConfig`:

```ts
  breakdownLabel: string;
```

In `normalizeWatchConfig`, add to the returned object:

```ts
    breakdownLabel: (raw.breakdownLabel ?? "design-breakdown").trim().toLowerCase(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/types.ts src/core/__tests__/linear-config.test.ts
git commit -m "feat(linear): configurable breakdownLabel (default design-breakdown)"
```

---

### Task 3: client — `fetchWorkflowStates` returns `type`

**Files:**
- Modify: `src/core/linear/client.ts`
- Test: `src/core/__tests__/linear-client.test.ts` (update existing case)

Reconcile and batch-create need state `type` (`backlog` / `unstarted` / `completed`) to resolve the parked + done states deterministically.

- [ ] **Step 1: Update the failing test**

In `src/core/__tests__/linear-client.test.ts`, change the existing `fetchWorkflowStates` test's `fakeData` to include `type` and assert it:

```ts
test("fetchWorkflowStates flattens teams→states, dedupes by id, includes type", async () => {
  const fakeData = {
    projects: { nodes: [ { teams: { nodes: [
      { states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted" }, { id: "s2", name: "In Progress", type: "started" }] } },
      { states: { nodes: [{ id: "s2", name: "In Progress", type: "started" }, { id: "s3", name: "Done", type: "completed" }] } },
    ] } } ] },
  };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const states = await c.fetchWorkflowStates("slug123");
  assert.deepEqual(states, [
    { id: "s1", name: "Todo", type: "unstarted" },
    { id: "s2", name: "In Progress", type: "started" },
    { id: "s3", name: "Done", type: "completed" },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-client.test.ts`
Expected: FAIL — returned objects lack `type`.

- [ ] **Step 3: Implement**

In `src/core/linear/client.ts`:

1. Update the interface signature:
```ts
  fetchWorkflowStates(projectSlugId: string): Promise<Array<{ id: string; name: string; type: string }>>;
```
2. Update the query constant:
```ts
const Q_WORKFLOW_STATES = `query($slug:String!){ projects(filter:{slugId:{eq:$slug}}, first:1){ nodes{ teams{ nodes{ states{ nodes{ id name type } } } } } } }`;
```
3. Update the method body's generic + push to carry `type`:
```ts
  async fetchWorkflowStates(projectSlugId: string): Promise<Array<{ id: string; name: string; type: string }>> {
    const d = await this.gql<{
      projects: { nodes: Array<{ teams: { nodes: Array<{ states: { nodes: Array<{ id: string; name: string; type: string }> } }> } }> };
    }>(Q_WORKFLOW_STATES, { slug: projectSlugId });
    const seen = new Set<string>();
    const result: Array<{ id: string; name: string; type: string }> = [];
    for (const project of d.projects.nodes) {
      for (const team of project.teams.nodes) {
        for (const state of team.states.nodes) {
          if (!seen.has(state.id)) { seen.add(state.id); result.push({ id: state.id, name: state.name, type: state.type }); }
        }
      }
    }
    return result;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/client.ts src/core/__tests__/linear-client.test.ts
git commit -m "feat(linear): fetchWorkflowStates returns state type"
```

---

### Task 4: client — `createIssue`, `createRelation`, `updateIssueBody`

**Files:**
- Modify: `src/core/linear/client.ts`
- Test: `src/core/__tests__/linear-client.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append to `src/core/__tests__/linear-client.test.ts`:

```ts
test("createIssue sends issueCreate with input and returns id+identifier", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueCreate: { success: true, issue: { id: "n1", identifier: "ARC-9" } } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  const out = await c.createIssue({ teamId: "t1", title: "Ledger slice", description: "do x", parentId: "p1", labelIds: ["l1"], stateId: "st1" });
  assert.ok(captured[0].query.includes("issueCreate"));
  assert.deepEqual(captured[0].variables.input, { teamId: "t1", title: "Ledger slice", description: "do x", parentId: "p1", labelIds: ["l1"], stateId: "st1" });
  assert.deepEqual(out, { id: "n1", identifier: "ARC-9" });
});

test("createRelation sends issueRelationCreate with blocks type", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueRelationCreate: { success: true } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.createRelation("a", "b", "blocks");
  assert.ok(captured[0].query.includes("issueRelationCreate"));
  assert.deepEqual(captured[0].variables.input, { issueId: "a", relatedIssueId: "b", type: "blocks" });
});

test("updateIssueBody sends issueUpdate with description", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueUpdate: { success: true } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.updateIssueBody("i1", "new body");
  assert.ok(captured[0].query.includes("issueUpdate"));
  assert.deepEqual(captured[0].variables, { id: "i1", desc: "new body" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-client.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

In `src/core/linear/client.ts`, add to the `LinearClientI` interface:

```ts
  createIssue(input: { teamId: string; title: string; description?: string; parentId?: string; labelIds?: string[]; stateId?: string }): Promise<{ id: string; identifier: string }>;
  createRelation(issueId: string, relatedIssueId: string, type: "blocks"): Promise<void>;
  updateIssueBody(issueId: string, body: string): Promise<void>;
```

Add the query constants near the others:

```ts
const M_ISSUE_CREATE = `mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success issue{ id identifier } } }`;
const M_RELATION = `mutation($input:IssueRelationCreateInput!){ issueRelationCreate(input:$input){ success } }`;
const M_ISSUE_BODY = `mutation($id:String!,$desc:String!){ issueUpdate(id:$id, input:{description:$desc}){ success } }`;
```

Add the methods to the class:

```ts
  async createIssue(input: { teamId: string; title: string; description?: string; parentId?: string; labelIds?: string[]; stateId?: string }): Promise<{ id: string; identifier: string }> {
    const d = await this.gql<{ issueCreate: { issue: { id: string; identifier: string } } }>(M_ISSUE_CREATE, { input });
    return d.issueCreate.issue;
  }

  async createRelation(issueId: string, relatedIssueId: string, type: "blocks"): Promise<void> {
    await this.gql(M_RELATION, { input: { issueId, relatedIssueId, type } });
  }

  async updateIssueBody(issueId: string, body: string): Promise<void> {
    await this.gql(M_ISSUE_BODY, { id: issueId, desc: body });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/client.ts src/core/__tests__/linear-client.test.ts
git commit -m "feat(linear): client createIssue / createRelation / updateIssueBody"
```

---

### Task 5: client — `fetchChildIssues`, `fetchTeamAndLabels`

**Files:**
- Modify: `src/core/linear/client.ts`
- Test: `src/core/__tests__/linear-client.test.ts` (add cases)

`fetchChildIssues` powers resumable batch-create (skip-by-title) and reconcile state reads. `fetchTeamAndLabels` resolves the teamId required by `issueCreate` and maps engine-label names → ids (lowercased keys).

- [ ] **Step 1: Write the failing test**

Append to `src/core/__tests__/linear-client.test.ts`:

```ts
test("fetchChildIssues returns children with id/title/stateName", async () => {
  const fakeData = { issue: { children: { nodes: [
    { id: "c1", identifier: "ARC-2", title: "Slice", state: { name: "Done" } },
    { id: "c2", identifier: "ARC-3", title: "API", state: { name: "Backlog" } },
  ] } } };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const kids = await c.fetchChildIssues("p1");
  assert.deepEqual(kids, [
    { id: "c1", identifier: "ARC-2", title: "Slice", stateName: "Done" },
    { id: "c2", identifier: "ARC-3", title: "API", stateName: "Backlog" },
  ]);
});

test("fetchTeamAndLabels returns first team id and lowercased label map", async () => {
  const fakeData = { projects: { nodes: [ { teams: { nodes: [
    { id: "team1", labels: { nodes: [{ id: "l1", name: "claude" }, { id: "l2", name: "Codex" }] } },
  ] } } ] } };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const out = await c.fetchTeamAndLabels("slug123");
  assert.equal(out.teamId, "team1");
  assert.deepEqual(out.labels, { claude: "l1", codex: "l2" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-client.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

In `src/core/linear/client.ts`, add to `LinearClientI`:

```ts
  fetchChildIssues(parentId: string): Promise<Array<{ id: string; identifier: string; title: string; stateName: string }>>;
  fetchTeamAndLabels(projectSlugId: string): Promise<{ teamId: string; labels: Record<string, string> }>;
```

Add query constants:

```ts
const Q_CHILDREN = `query($id:String!){ issue(id:$id){ children{ nodes{ id identifier title state{ name } } } } }`;
const Q_TEAM_LABELS = `query($slug:String!){ projects(filter:{slugId:{eq:$slug}}, first:1){ nodes{ teams{ nodes{ id labels{ nodes{ id name } } } } } } }`;
```

Add methods:

```ts
  async fetchChildIssues(parentId: string): Promise<Array<{ id: string; identifier: string; title: string; stateName: string }>> {
    const d = await this.gql<{ issue: { children: { nodes: any[] } } | null }>(Q_CHILDREN, { id: parentId });
    return (d.issue?.children.nodes ?? []).map((n) => ({ id: n.id, identifier: n.identifier, title: n.title, stateName: n.state.name }));
  }

  async fetchTeamAndLabels(projectSlugId: string): Promise<{ teamId: string; labels: Record<string, string> }> {
    const d = await this.gql<{ projects: { nodes: Array<{ teams: { nodes: Array<{ id: string; labels: { nodes: Array<{ id: string; name: string }> } }> } }> } }>(Q_TEAM_LABELS, { slug: projectSlugId });
    const team = d.projects.nodes[0]?.teams.nodes[0];
    if (!team) throw new Error(`No team for project ${projectSlugId}`);
    const labels: Record<string, string> = {};
    for (const l of team.labels.nodes) labels[l.name.trim().toLowerCase()] = l.id;
    return { teamId: team.id, labels };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/client.ts src/core/__tests__/linear-client.test.ts
git commit -m "feat(linear): client fetchChildIssues / fetchTeamAndLabels"
```

---

### Task 6: breakdown.ts — parse/validate + render preview (pure)

**Files:**
- Create: `src/core/linear/breakdown.ts`
- Test: `src/core/__tests__/linear-breakdown.test.ts`

Pure functions. `parseBreakdown` validates the agent-written JSON (≥1 sub-issue, non-empty titles). `renderBreakdownPreview` produces the numbered, human-readable preview used in the Phase 1 interactive loop.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/__tests__/linear-breakdown.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBreakdown, renderBreakdownPreview } from "../linear/breakdown";

test("parseBreakdown accepts a valid plan", () => {
  const raw = JSON.stringify({ parentSummary: "why", subIssues: [{ title: "A", description: "da", labels: ["claude"] }] });
  const r = parseBreakdown(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.parentSummary, "why");
    assert.equal(r.plan.subIssues[0].title, "A");
    assert.deepEqual(r.plan.subIssues[0].labels, ["claude"]);
  }
});

test("parseBreakdown defaults a missing labels array to empty", () => {
  const raw = JSON.stringify({ parentSummary: "why", subIssues: [{ title: "A" }] });
  const r = parseBreakdown(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.plan.subIssues[0].labels, []);
});

test("parseBreakdown rejects malformed JSON", () => {
  const r = parseBreakdown("{not json");
  assert.equal(r.ok, false);
});

test("parseBreakdown rejects an empty subIssues array", () => {
  const r = parseBreakdown(JSON.stringify({ parentSummary: "x", subIssues: [] }));
  assert.equal(r.ok, false);
});

test("parseBreakdown rejects a sub-issue with a blank title", () => {
  const r = parseBreakdown(JSON.stringify({ parentSummary: "x", subIssues: [{ title: "  " }] }));
  assert.equal(r.ok, false);
});

test("renderBreakdownPreview numbers subs and shows blockers + labels", () => {
  const out = renderBreakdownPreview({
    parentSummary: "why",
    subIssues: [
      { title: "Ledger", description: "", labels: ["claude"] },
      { title: "API", description: "", labels: ["codex"] },
    ],
  }, "ARC-1");
  assert.match(out, /#1\s+Ledger\s+\[claude\]\s+no blocker, starts first/);
  assert.match(out, /#2\s+API\s+\[codex\]\s+blocked-by #1/);
  assert.match(out, /ARC-1/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-breakdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/linear/breakdown.ts
export interface SubIssueSpec {
  title: string;
  description: string;
  labels: string[];
}

export interface BreakdownPlan {
  parentSummary: string;
  subIssues: SubIssueSpec[];
}

export type ParseResult = { ok: true; plan: BreakdownPlan } | { ok: false; error: string };

export function parseBreakdown(raw: string): ParseResult {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "breakdown.json is not valid JSON" };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "breakdown.json must be an object" };
  if (!Array.isArray(data.subIssues) || data.subIssues.length === 0) {
    return { ok: false, error: "breakdown.json needs a non-empty subIssues array" };
  }
  const subIssues: SubIssueSpec[] = [];
  for (let i = 0; i < data.subIssues.length; i++) {
    const s = data.subIssues[i];
    if (!s || typeof s.title !== "string" || s.title.trim() === "") {
      return { ok: false, error: `subIssues[${i}] has a missing or blank title` };
    }
    subIssues.push({
      title: s.title.trim(),
      description: typeof s.description === "string" ? s.description : "",
      labels: Array.isArray(s.labels) ? s.labels.filter((l: unknown): l is string => typeof l === "string") : [],
    });
  }
  return {
    ok: true,
    plan: { parentSummary: typeof data.parentSummary === "string" ? data.parentSummary : "", subIssues },
  };
}

export function renderBreakdownPreview(plan: BreakdownPlan, parentIdentifier?: string): string {
  const head = `Requirement${parentIdentifier ? ` ${parentIdentifier}` : ""}  →  ${plan.subIssues.length} sub-issues proposed (order = dependency)`;
  const lines = plan.subIssues.map((s, i) => {
    const labels = s.labels.length ? `[${s.labels.join(",")}]` : "[default]";
    const blocker = i === 0 ? "no blocker, starts first" : `blocked-by #${i}`;
    return `#${i + 1}  ${s.title}  ${labels}  ${blocker}`;
  });
  return [head, "", ...lines, "", `parent body = decomposition rationale`].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-breakdown.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/breakdown.ts src/core/__tests__/linear-breakdown.test.ts
git commit -m "feat(linear): breakdown.json parse/validate + numbered preview"
```

---

### Task 7: reconcile.ts — pure `computeReconcile`

**Files:**
- Create: `src/core/linear/reconcile.ts`
- Test: `src/core/__tests__/linear-reconcile.test.ts`

Pure decision function over an ordered list of sub-issue state names. A sub at index `i ≥ 1` advances when its predecessor is terminal AND it is still in the parked state. The parent closes when every sub is terminal. Index 0 is never advanced (batch-create starts it at the trigger state).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/__tests__/linear-reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReconcile } from "../linear/reconcile";

const opts = { terminalStates: ["Done", "Canceled"], parkedState: "Backlog" };

test("advances the sub whose predecessor just went Done", () => {
  const r = computeReconcile(["Done", "Backlog", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, [1]);
  assert.equal(r.closeParent, false);
});

test("does not advance a sub whose predecessor is not terminal", () => {
  const r = computeReconcile(["In Review", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, []);
});

test("does not re-advance a sub already moved off parked", () => {
  const r = computeReconcile(["Done", "Todo", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, []); // #2 is Todo (active), #3 blocked by #2 (not terminal)
});

test("never advances index 0", () => {
  const r = computeReconcile(["Backlog", "Backlog"], opts);
  assert.deepEqual(r.advanceIndexes, []);
});

test("closes parent when all subs terminal", () => {
  const r = computeReconcile(["Done", "Done", "Canceled"], opts);
  assert.equal(r.closeParent, true);
  assert.deepEqual(r.advanceIndexes, []);
});

test("empty list does not close parent", () => {
  const r = computeReconcile([], opts);
  assert.equal(r.closeParent, false);
});

test("tolerates null states (unreadable) as non-terminal, non-parked", () => {
  const r = computeReconcile(["Done", null], opts);
  assert.deepEqual(r.advanceIndexes, []);
  assert.equal(r.closeParent, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/linear/reconcile.ts
export interface ReconcileOpts {
  terminalStates: string[];
  parkedState: string;
}

export interface ReconcileDecision {
  advanceIndexes: number[];
  closeParent: boolean;
}

function eqName(a: string | null, b: string): boolean {
  return a != null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isTerminalName(s: string | null, terminalStates: string[]): boolean {
  return s != null && terminalStates.some((t) => t.trim().toLowerCase() === s.trim().toLowerCase());
}

export function computeReconcile(states: Array<string | null>, opts: ReconcileOpts): ReconcileDecision {
  const advanceIndexes: number[] = [];
  for (let i = 1; i < states.length; i++) {
    if (isTerminalName(states[i - 1], opts.terminalStates) && eqName(states[i], opts.parkedState)) {
      advanceIndexes.push(i);
    }
  }
  const closeParent = states.length > 0 && states.every((s) => isTerminalName(s, opts.terminalStates));
  return { advanceIndexes, closeParent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-reconcile.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/reconcile.ts src/core/__tests__/linear-reconcile.test.ts
git commit -m "feat(linear): pure computeReconcile chain-advance decision"
```

---

### Task 8: wiring — extend `resolveStateIds` with trigger / done / parked

**Files:**
- Modify: `src/core/linear/wiring.ts`
- Test: `src/core/__tests__/linear-wiring.test.ts` (update existing `resolveStateIds` cases)

Batch-create starts sub[0] at `trigger` and parks the rest at `parked`; reconcile advances parked→`trigger` and closes the parent at `done`. We resolve `parked` by the first `backlog`-type state and `done` by the first `completed`-type state.

- [ ] **Step 1: Update the failing test**

Replace the existing `resolveStateIds` happy-path test in `src/core/__tests__/linear-wiring.test.ts` with:

```ts
test("resolveStateIds maps trigger/inProgress/review/done/parked by name and type", async () => {
  const client = { fetchWorkflowStates: async () => [
    { id: "todo", name: "Todo", type: "unstarted" },
    { id: "prog", name: "In Progress", type: "started" },
    { id: "rev", name: "In Review", type: "started" },
    { id: "back", name: "Backlog", type: "backlog" },
    { id: "done", name: "Done", type: "completed" },
  ] };
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  const ids = await resolveStateIds(client as any, w);
  assert.equal(ids.trigger, "todo");
  assert.equal(ids.inProgress, "prog");
  assert.equal(ids.review, "rev");
  assert.equal(ids.done, "done");
  assert.equal(ids.parked, "back");
  assert.equal(ids.parkedName, "Backlog");
});
```

(Keep the existing "throws when a required state is missing" test; it still applies because In Progress is still required by name.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-wiring.test.ts`
Expected: FAIL — `ids.trigger` / `done` / `parked` undefined.

- [ ] **Step 3: Implement**

In `src/core/linear/wiring.ts`, replace `resolveStateIds`:

```ts
export async function resolveStateIds(
  client: Pick<LinearClientI, "fetchWorkflowStates">,
  w: LinearWatchConfig,
): Promise<{ trigger: string; inProgress: string; review: string; done: string; parked: string; parkedName: string }> {
  const states = await client.fetchWorkflowStates(w.projectSlugId);
  const byName = (name: string) => {
    const s = states.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) throw new Error(`Linear state "${name}" not found in project ${w.projectSlugId}`);
    return s.id;
  };
  const byType = (type: string, label: string) => {
    const s = states.find((x) => x.type === type);
    if (!s) throw new Error(`Linear state of type "${type}" (${label}) not found in project ${w.projectSlugId}`);
    return s;
  };
  const parked = byType("backlog", "parked");
  const done = byType("completed", "done");
  return {
    trigger: byName(w.triggerState),
    inProgress: byName("In Progress"),
    review: byName(w.reviewState),
    done: done.id,
    parked: parked.id,
    parkedName: parked.name,
  };
}
```

Note: `TickDeps.stateIds` (in `poller.ts`) is typed `{ inProgress: string; review: string }`. Widen it in Task 10 when reconcile is wired; the extra fields are additive and don't break existing reads.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/wiring.ts src/core/__tests__/linear-wiring.test.ts
git commit -m "feat(linear): resolveStateIds resolves trigger/done/parked states"
```

---

### Task 9: batch-create.ts — `runBreakdown` orchestration

**Files:**
- Create: `src/core/linear/batch-create.ts`
- Test: `src/core/__tests__/linear-batch-create.test.ts`

Reads `breakdown.json`, idempotently/resumably creates the Linear structure, records sub order in the DB, and stamps the parent row last.

**Behavior contract:**
1. Read `<repoRoot>/.devlog/breakdown.json`; on parse failure return `{ ok: false, error }` (caller surfaces it; nothing is stamped).
2. Fetch existing children (skip-by-title) so a re-run never duplicates an already-created sub.
3. For each plan sub: reuse an existing child with the same title, else `createIssue` (with `parentId`, mapped `labelIds`, and `stateId = trigger` for index 0 / `parked` for the rest). Record/ensure a `linear_breakdown_subs` row at its position.
4. Wire `sub[i]` blocked-by `sub[i-1]` (`createRelation(child[i], child[i-1], "blocks")`), tolerating duplicate-relation errors.
5. Set the parent body to `parentSummary`; move the parent to `inProgress`.
6. Insert the parent task row with `linear_breakdown_done_at` set (the idempotency stamp — written last).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/__tests__/linear-batch-create.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "./test-helpers";
import { runBreakdown } from "../linear/batch-create";
import { normalizeWatchConfig } from "../linear/types";

function tmpRepoWith(plan: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "devlog-breakdown-"));
  mkdirSync(join(dir, ".devlog"));
  writeFileSync(join(dir, ".devlog", "breakdown.json"), JSON.stringify(plan));
  return dir;
}

const stateIds = { trigger: "todo", inProgress: "prog", review: "rev", done: "done", parked: "back", parkedName: "Backlog" };
const teamAndLabels = { teamId: "team1", labels: { claude: "lc", codex: "lx" } };
const parent = { id: "p1", identifier: "ARC-1", title: "Big REQ", description: "", stateName: "Todo", labels: ["design-breakdown"] };

function fakeClient(overrides: any = {}) {
  const calls: any = { created: [], relations: [], states: [], bodies: [] };
  let n = 0;
  const client = {
    fetchChildIssues: async () => overrides.existingChildren ?? [],
    createIssue: async (input: any) => { n++; const id = `c${n}`; calls.created.push({ id, input }); return { id, identifier: `ARC-${n + 1}` }; },
    createRelation: async (a: string, b: string) => { calls.relations.push([a, b]); },
    updateIssueBody: async (id: string, body: string) => { calls.bodies.push([id, body]); },
    updateState: async (id: string, s: string) => { calls.states.push([id, s]); },
    ...overrides.client,
  };
  return { client, calls };
}

test("runBreakdown creates subs, wires chain, sets states, stamps parent row", async () => {
  const db = makeTestDb();
  const repo = tmpRepoWith({ parentSummary: "rationale", subIssues: [
    { title: "Ledger", description: "d1", labels: ["claude"] },
    { title: "API", description: "d2", labels: ["codex"] },
  ] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client, calls } = fakeClient();

  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });
  assert.equal(res.ok, true);

  // two subs created with correct states + labels
  assert.equal(calls.created.length, 2);
  assert.equal(calls.created[0].input.stateId, "todo");  // first → trigger
  assert.deepEqual(calls.created[0].input.labelIds, ["lc"]);
  assert.equal(calls.created[1].input.stateId, "back");  // rest → parked
  assert.deepEqual(calls.created[1].input.labelIds, ["lx"]);
  // chain: c2 blocked-by c1
  assert.deepEqual(calls.relations, [["c2", "c1"]]);
  // parent body + In Progress
  assert.deepEqual(calls.bodies, [["p1", "rationale"]]);
  assert.ok(calls.states.some(([id, s]: any) => id === "p1" && s === "prog"));
  // sub-order rows
  const subs = db.prepare("SELECT child_issue_id, position FROM linear_breakdown_subs WHERE parent_issue_id='p1' ORDER BY position").all();
  assert.deepEqual(subs, [{ child_issue_id: "c1", position: 0 }, { child_issue_id: "c2", position: 1 }]);
  // parent stamp row
  const prow: any = db.prepare("SELECT linear_issue_id, linear_breakdown_done_at FROM tasks WHERE linear_issue_id='p1'").get();
  assert.ok(prow && prow.linear_breakdown_done_at);
});

test("runBreakdown reuses an existing child by title (resumable, no duplicate)", async () => {
  const db = makeTestDb();
  const repo = tmpRepoWith({ parentSummary: "r", subIssues: [
    { title: "Ledger", description: "", labels: ["claude"] },
    { title: "API", description: "", labels: ["claude"] },
  ] });
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client, calls } = fakeClient({ existingChildren: [{ id: "old1", identifier: "ARC-2", title: "Ledger", stateName: "Backlog" }] });

  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: repo, stateIds, teamAndLabels });
  assert.equal(res.ok, true);
  assert.equal(calls.created.length, 1);           // only "API" newly created
  const subs = db.prepare("SELECT child_issue_id FROM linear_breakdown_subs WHERE parent_issue_id='p1' ORDER BY position").all();
  assert.deepEqual(subs, [{ child_issue_id: "old1" }, { child_issue_id: "c1" }]);
});

test("runBreakdown returns error on malformed breakdown.json and stamps nothing", async () => {
  const db = makeTestDb();
  const dir = mkdtempSync(join(tmpdir(), "devlog-breakdown-"));
  mkdirSync(join(dir, ".devlog"));
  writeFileSync(join(dir, ".devlog", "breakdown.json"), "{bad");
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  const { client } = fakeClient();
  const res = await runBreakdown({ db, client: client as any, w, parent, repoRoot: dir, stateIds, teamAndLabels });
  assert.equal(res.ok, false);
  const prow = db.prepare("SELECT 1 FROM tasks WHERE linear_issue_id='p1'").get();
  assert.equal(prow, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-batch-create.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/core/linear/batch-create.ts
import type Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import type { LinearClientI } from "./client";
import type { LinearIssue, LinearWatchConfig } from "./types";
import { parseBreakdown } from "./breakdown";

export interface ResolvedStateIds {
  trigger: string;
  inProgress: string;
  review: string;
  done: string;
  parked: string;
  parkedName: string;
}

export interface RunBreakdownDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "fetchChildIssues" | "createIssue" | "createRelation" | "updateIssueBody" | "updateState">;
  w: LinearWatchConfig;
  parent: LinearIssue;
  repoRoot: string;
  stateIds: ResolvedStateIds;
  teamAndLabels: { teamId: string; labels: Record<string, string> };
}

export type RunBreakdownResult = { ok: true; created: number } | { ok: false; error: string };

export async function runBreakdown(deps: RunBreakdownDeps): Promise<RunBreakdownResult> {
  const { db, client, parent, repoRoot, stateIds, teamAndLabels } = deps;

  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".devlog", "breakdown.json"), "utf-8");
  } catch {
    return { ok: false, error: "breakdown.json not found in repo .devlog/" };
  }
  const parsed = parseBreakdown(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const plan = parsed.plan;

  // Resumability: an existing child with the same title is reused, never duplicated.
  const existing = await client.fetchChildIssues(parent.id);
  const byTitle = new Map(existing.map((c) => [c.title.trim().toLowerCase(), c]));

  const childIds: string[] = [];
  let createdCount = 0;
  for (let i = 0; i < plan.subIssues.length; i++) {
    const sub = plan.subIssues[i];
    const key = sub.title.trim().toLowerCase();
    const reuse = byTitle.get(key);
    let childId: string;
    let childIdentifier: string | null = null;
    if (reuse) {
      childId = reuse.id;
      childIdentifier = reuse.identifier;
    } else {
      const labelIds = sub.labels
        .map((l) => teamAndLabels.labels[l.trim().toLowerCase()])
        .filter((x): x is string => typeof x === "string");
      const out = await client.createIssue({
        teamId: teamAndLabels.teamId,
        title: sub.title,
        description: sub.description,
        parentId: parent.id,
        labelIds,
        stateId: i === 0 ? stateIds.trigger : stateIds.parked,
      });
      childId = out.id;
      childIdentifier = out.identifier;
      createdCount++;
    }
    childIds.push(childId);
    // Record sub order (idempotent on parent+position).
    const has = db
      .prepare("SELECT 1 FROM linear_breakdown_subs WHERE parent_issue_id = ? AND position = ?")
      .get(parent.id, i);
    if (!has) {
      db.prepare(
        "INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES (?, ?, ?, ?)",
      ).run(parent.id, childId, childIdentifier, i);
    }
  }

  // Wire the blocking chain; duplicate-relation errors are harmless on a re-run.
  for (let i = 1; i < childIds.length; i++) {
    try {
      await client.createRelation(childIds[i], childIds[i - 1], "blocks");
    } catch {
      /* relation may already exist on a resumed run */
    }
  }

  // Parent body + In Progress.
  await client.updateIssueBody(parent.id, plan.parentSummary);
  await client.updateState(parent.id, stateIds.inProgress);

  // Stamp LAST — idempotency marker + reconcile anchor.
  const taskId = randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, linear_issue_id, linear_identifier, linear_breakdown_done_at, created_at, updated_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
  ).run(taskId, deps.w.devlogProjectId, parent.title, parent.id, parent.identifier);

  return { ok: true, created: createdCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/core/__tests__/linear-batch-create.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/batch-create.ts src/core/__tests__/linear-batch-create.test.ts
git commit -m "feat(linear): runBreakdown idempotent batch-create of parent+sub chain"
```

---

### Task 10: reconcile integration — `reconcileBreakdowns` + poller tick

**Files:**
- Modify: `src/core/linear/reconcile.ts` (add `reconcileBreakdowns`)
- Modify: `src/core/linear/poller.ts` (add `reconcile` to `TickDeps`, call in `tick`)
- Test: `src/core/__tests__/linear-reconcile-integration.test.ts`
- Test: `src/core/__tests__/linear-poller.test.ts` (add a case that `tick` calls `reconcile`)

`reconcileBreakdowns` finds active breakdown-parents (`linear_breakdown_done_at` set, not yet finalized), reads each sub's current Linear state in order, runs `computeReconcile`, advances unblocked subs to `trigger`, and — when all subs are terminal — moves the parent to `done` and stamps `linear_finalized_at` so it is never reconciled again.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/__tests__/linear-reconcile-integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./test-helpers";
import { reconcileBreakdowns } from "../linear/reconcile";
import { normalizeWatchConfig } from "../linear/types";

const stateIds = { trigger: "todo", inProgress: "prog", review: "rev", done: "done", parked: "back", parkedName: "Backlog" };

function seedParent(db: any, parentId: string, subs: Array<{ id: string; pos: number }>) {
  db.prepare(
    "INSERT INTO tasks (id, project_id, title, status, linear_issue_id, linear_breakdown_done_at, created_at, updated_at) VALUES (?, 'repo1', 't', 'in_progress', ?, datetime('now'), datetime('now'), datetime('now'))",
  ).run("task-" + parentId, parentId);
  for (const s of subs) {
    db.prepare(
      "INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES (?, ?, ?, ?)",
    ).run(parentId, s.id, "X", s.pos);
  }
}

test("advances the next sub when its predecessor is Done", async () => {
  const db = makeTestDb();
  seedParent(db, "p1", [{ id: "c1", pos: 0 }, { id: "c2", pos: 1 }]);
  const states: Record<string, string> = { c1: "Done", c2: "Backlog" };
  const moves: any[] = [];
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  await reconcileBreakdowns({
    db, w, stateIds,
    client: {
      fetchStateNameByIssue: async (id: string) => states[id] ?? null,
      updateState: async (id: string, s: string) => { moves.push([id, s]); },
    } as any,
  });
  assert.deepEqual(moves, [["c2", "todo"]]); // c2 advanced to trigger
});

test("closes the parent and finalizes it when all subs terminal", async () => {
  const db = makeTestDb();
  seedParent(db, "p2", [{ id: "c1", pos: 0 }, { id: "c2", pos: 1 }]);
  const states: Record<string, string> = { c1: "Done", c2: "Done" };
  const moves: any[] = [];
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  await reconcileBreakdowns({
    db, w, stateIds,
    client: {
      fetchStateNameByIssue: async (id: string) => states[id] ?? null,
      updateState: async (id: string, s: string) => { moves.push([id, s]); },
    } as any,
  });
  assert.ok(moves.some(([id, s]) => id === "p2" && s === "done"));
  const row: any = db.prepare("SELECT linear_finalized_at FROM tasks WHERE linear_issue_id='p2'").get();
  assert.ok(row.linear_finalized_at);
});

test("skips a parent already finalized", async () => {
  const db = makeTestDb();
  seedParent(db, "p3", [{ id: "c1", pos: 0 }]);
  db.prepare("UPDATE tasks SET linear_finalized_at = datetime('now') WHERE linear_issue_id='p3'").run();
  let called = 0;
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
  await reconcileBreakdowns({
    db, w, stateIds,
    client: { fetchStateNameByIssue: async () => { called++; return "Done"; }, updateState: async () => {} } as any,
  });
  assert.equal(called, 0);
});
```

Append to `src/core/__tests__/linear-poller.test.ts`:

```ts
test("tick calls reconcile each cycle", async () => {
  const db = makeTestDb();
  let reconciled = 0;
  await tick({
    db,
    client: { fetchTriggerIssues: async () => [] },
    watch: normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" }),
    onDispatch: async () => {},
    finalize: async () => {},
    reconcile: async () => { reconciled++; },
    stateIds: { trigger: "t", inProgress: "ip", review: "rv", done: "d", parked: "b", parkedName: "Backlog" },
  } as any);
  assert.equal(reconciled, 1);
});
```

(Ensure `makeTestDb` and `normalizeWatchConfig` are imported at the top of `linear-poller.test.ts`; add them if missing.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-reconcile-integration.test.ts src/core/__tests__/linear-poller.test.ts`
Expected: FAIL — `reconcileBreakdowns` undefined; `tick` ignores `reconcile`.

- [ ] **Step 3: Implement `reconcileBreakdowns`**

Append to `src/core/linear/reconcile.ts`:

```ts
import type Database from "better-sqlite3";
import type { LinearClientI } from "./client";
import type { LinearWatchConfig } from "./types";
import type { ResolvedStateIds } from "./batch-create";

export interface ReconcileDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "fetchStateNameByIssue" | "updateState">;
  w: LinearWatchConfig;
  stateIds: ResolvedStateIds;
}

export async function reconcileBreakdowns(deps: ReconcileDeps): Promise<void> {
  const { db, client, w, stateIds } = deps;
  const parents = db
    .prepare(
      "SELECT linear_issue_id AS pid FROM tasks WHERE linear_breakdown_done_at IS NOT NULL AND linear_finalized_at IS NULL AND project_id = ?",
    )
    .all(w.devlogProjectId) as Array<{ pid: string }>;

  for (const { pid } of parents) {
    const subs = db
      .prepare("SELECT child_issue_id AS cid, position FROM linear_breakdown_subs WHERE parent_issue_id = ? ORDER BY position")
      .all(pid) as Array<{ cid: string; position: number }>;
    if (subs.length === 0) continue;

    const states = await Promise.all(subs.map((s) => client.fetchStateNameByIssue(s.cid)));
    const decision = computeReconcile(states, { terminalStates: w.terminalStates, parkedState: stateIds.parkedName });

    for (const idx of decision.advanceIndexes) {
      await client.updateState(subs[idx].cid, stateIds.trigger);
    }
    if (decision.closeParent) {
      await client.updateState(pid, stateIds.done);
      db.prepare(
        "UPDATE tasks SET linear_finalized_at = datetime('now'), status = 'done', updated_at = datetime('now') WHERE linear_issue_id = ?",
      ).run(pid);
    }
  }
}
```

- [ ] **Step 4: Wire `reconcile` into the poller**

In `src/core/linear/poller.ts`, widen `TickDeps`:

```ts
export interface TickDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "fetchTriggerIssues">;
  watch: LinearWatchConfig;
  onDispatch: (issue: LinearIssue) => Promise<void>;
  finalize: () => Promise<void>;
  reconcile: () => Promise<void>;
  stateIds: { trigger: string; inProgress: string; review: string; done: string; parked: string; parkedName: string };
}
```

In `tick`, call reconcile after finalize:

```ts
export async function tick(deps: TickDeps): Promise<void> {
  await deps.finalize();
  await deps.reconcile();
  const issues = await deps.client.fetchTriggerIssues(deps.watch.projectSlugId, deps.watch.triggerState);
  for (const issue of issues) {
    if (alreadyLinked(deps.db, issue.id)) continue;
    await deps.onDispatch(issue);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --import tsx src/core/__tests__/linear-reconcile-integration.test.ts src/core/__tests__/linear-poller.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/linear/reconcile.ts src/core/linear/poller.ts src/core/__tests__/linear-reconcile-integration.test.ts src/core/__tests__/linear-poller.test.ts
git commit -m "feat(linear): reconcileBreakdowns advances chain + closes parent; poller runs it each tick"
```

---

### Task 11: wiring — route breakdown label + resolve team/labels + pass reconcile

**Files:**
- Modify: `src/core/linear/wiring.ts`
- Test: `src/core/__tests__/linear-wiring.test.ts` (add an `isBreakdownIssue` unit test)

Ties it together in the composition root: resolve `teamAndLabels` once; route a `design-breakdown`-labelled trigger issue to `runBreakdown` instead of the build dispatch; pass a `reconcile` closure to the poller. Extract a tiny pure predicate so routing is unit-testable without the full wiring.

- [ ] **Step 1: Write the failing test**

Append to `src/core/__tests__/linear-wiring.test.ts`:

```ts
import { isBreakdownIssue } from "../linear/wiring";

test("isBreakdownIssue matches the configured breakdown label case-insensitively", () => {
  const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
  assert.equal(isBreakdownIssue({ labels: ["Design-Breakdown"] } as any, w), true);
  assert.equal(isBreakdownIssue({ labels: ["claude"] } as any, w), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/core/__tests__/linear-wiring.test.ts`
Expected: FAIL — `isBreakdownIssue` not exported.

- [ ] **Step 3: Implement the predicate**

In `src/core/linear/wiring.ts`, add:

```ts
import type { LinearIssue } from "./types";

export function isBreakdownIssue(issue: LinearIssue, w: LinearWatchConfig): boolean {
  return issue.labels.some((l) => l.trim().toLowerCase() === w.breakdownLabel);
}
```

- [ ] **Step 4: Wire routing + reconcile into `startWatching`**

In `src/core/linear/wiring.ts`, inside `startWatching`'s `for (const w of cfg.watch)` loop:

1. After `const stateIds = await resolveStateIds(client, w);`, resolve team/labels and the repo root:
```ts
    const teamAndLabels = await client.fetchTeamAndLabels(w.projectSlugId);
    const repoRoot = getRepoRoot(w.devlogProjectId);
```
   (Add `import { getRepoRoot } from "../project-adapter";` and `import { runBreakdown } from "./batch-create";` and `import { reconcileBreakdowns } from "./reconcile";` at the top.)

2. At the top of the `onDispatch` closure, branch to breakdown before the normal dispatch:
```ts
      onDispatch: async (issue) => {
        if (isBreakdownIssue(issue, w)) {
          const result = await runBreakdown({ db, client, w, parent: issue, repoRoot, stateIds, teamAndLabels });
          if (!result.ok) {
            await client.createComment(issue.id, `**Breakdown failed:** ${result.error}. Fix \`.devlog/breakdown.json\` and re-label.`);
          }
          return;
        }
        // ... existing build-dispatch body unchanged ...
```

3. Add a `reconcile` closure to the `deps` object:
```ts
      reconcile: async () => {
        await reconcileBreakdowns({ db, client, w, stateIds });
      },
```

- [ ] **Step 5: Run the full suite**

Run: `bun run typecheck && node --test --import tsx src/core/__tests__/*.test.ts`
Expected: PASS — all linear tests green, including the prior 262 baseline plus the new files. Fix any type drift surfaced by `typecheck` (e.g. the `stateIds` shape now flows through `TickDeps`).

- [ ] **Step 6: Commit**

```bash
git add src/core/linear/wiring.ts src/core/__tests__/linear-wiring.test.ts
git commit -m "feat(linear): route design-breakdown to runBreakdown; wire reconcile + team/labels"
```

---

## Final verification (after all tasks)

- [ ] **Full gate:** `bun run typecheck && TZ=Asia/Shanghai bun run test` — all green (262 baseline + new tests).
- [ ] **Different-engine review (ship Stage 5.0):** holistic `codex exec --sandbox read-only` review of the full diff (merge-base→HEAD). Verify findings before acting.
- [ ] **Live demo (ship Stage 4.5, non-waivable):** on real betakairos + a real repo —
  1. Run a requirement through the interactive decompose + correction loop; approve (commit `.devlog/breakdown.json`, label the issue `design-breakdown`).
  2. Start watch; confirm in Linear UI: real parent body + N sub-issues + blocking chain; sub #1 in Todo, rest parked.
  3. Sub #1 builds → PR → In Review; human merges + marks Done.
  4. Next tick: poller advances sub #2 to Todo; chain proceeds.
  5. All subs Done → poller closes the parent.

## Self-Review notes

- **Spec coverage:** two-phase model (Phase 2 here; Phase 1 interactive, no new bridge code) ✓; `breakdown.json` schema (Task 6) ✓; numbered preview (Task 6) ✓; new client methods (Tasks 3–5) ✓; idempotent+resumable batch-create via `linear_breakdown_done_at` (Tasks 1, 9) ✓; poller single-owner reconcile advance+close (Tasks 7, 10) ✓; per-sub human merge gate (unchanged build flow) ✓; error handling for malformed json (Tasks 9, 11) ✓; v1 boundary (no projects/parallel graphs) — nothing in plan exceeds it ✓.
- **Type consistency:** `ResolvedStateIds` (batch-create.ts) is the single source for the `{trigger,inProgress,review,done,parked,parkedName}` shape, reused by `resolveStateIds`, `TickDeps.stateIds`, and `reconcileBreakdowns`. `BreakdownPlan`/`SubIssueSpec` defined once (breakdown.ts) and consumed by batch-create. `computeReconcile` signature matches its caller in `reconcileBreakdowns`.
- **Resumability subtlety (intentional):** the parent task row (the `alreadyLinked` anchor) is inserted only at the end of `runBreakdown`, so a mid-run crash leaves the parent un-anchored and the next tick re-enters `runBreakdown`; skip-by-title prevents duplicate children. This is why the stamp is written last.
