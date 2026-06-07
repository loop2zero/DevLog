# DevLog ↔ Linear Integration (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linear the board/source-of-truth that drives DevLog: a poller picks up trigger-state issues in a scoped Linear project, runs them through DevLog's existing multi-engine execute path, and writes status + a workpad comment back to Linear (hybrid writeback: harness owns the state machine + liveness, the agent owns the narrative via `.devlog/workpad.md`).

**Architecture:** New `src/core/linear/` package (client, state-map, dispatcher, writeback, poller) plus a small extraction of the existing execute-route body into a reusable `executeTask()`. Linear is read+written only by harness code; the agent never touches Linear (so any engine works). Each watched Linear project maps to one local repo (the isolation boundary). The poller is a single reconcile loop: dispatch new trigger issues, finalize in-flight ones from their DB session status.

**Tech Stack:** TypeScript, Bun, `bun test`, better-sqlite3, commander (CLI), Linear GraphQL API, `gh` CLI for PR detection. Reuses DevLog's `createWorktree`, `processManager`, agent-presets, session-runtime-auth.

**Spec:** `docs/superpowers/specs/2026-06-07-devlog-linear-integration-design.md`

---

## Build Environment & Test Conventions (AUTHORITATIVE — overrides any `bun:test` snippets below)

DevLog runs tests on **Node 20** via `node --test`, NOT Bun (`better-sqlite3` is native and does not load under `bun test`). All test code blocks below were drafted with `bun:test`/`expect`; **translate them to the conventions here**:

- **Framework:** `import { test } from "node:test"` + `import assert from "node:assert/strict"`. Use `assert.equal`, `assert.deepEqual`, `assert.ok`, `assert.throws` — NOT `expect`.
- **DB tests:** use `makeTestDb()`, `insertTask(db, {...})`, `insertSession(db, {...})` from `src/core/__tests__/test-helpers.ts` (in-memory better-sqlite3 seeded with `SCHEMA`). Do NOT `new Database(":memory:")` by hand.
- **Test file location:** `src/core/__tests__/linear-<name>.test.ts` — the runner glob only covers `src/core/__tests__/*.test.ts`. Source files still live in `src/core/linear/`.
- **Run one file:** `node --test --import tsx --test-reporter spec src/core/__tests__/linear-<name>.test.ts`
- **Run full suite:** `bun run test` (the glob was fixed in Task 0; husky pre-commit = `typecheck` + full suite, currently green at 208/0). Commit normally — do NOT use `--no-verify` for code.
- **Schema parity (important for Task 2):** `makeTestDb()` builds from the `SCHEMA` constant in `src/core/db-schema.ts`, not from the migration functions. So Task 2 must add the three `linear_*` columns to BOTH the runtime migration (`migrateLinearColumns`, for existing DBs) AND the `SCHEMA` constant in `db-schema.ts` (so fresh/test DBs have them). Tests should then use `makeTestDb()` directly.
- **Task 0 (DONE):** `package.json` test globs unquoted so `node --test` resolves them on Node 20.

---

## File Structure

**Create:**
- `src/core/linear/types.ts` — Linear-layer types (`LinearIssue`, `LinearWatchConfig`, `EngineId`).
- `src/core/linear/state-map.ts` — pure functions: engine resolution, workpad assembly, mirror-task shaping. No I/O.
- `src/core/linear/client.ts` — `LinearClient` + `LinearClientI` interface (GraphQL: query trigger issues, update state, create/update comment).
- `src/core/linear/dispatcher.ts` — issue → mirror DevLog task → `executeTask()` with chosen engine; idempotency.
- `src/core/linear/writeback.ts` — finalize a dispatched issue: detect PR, move state, relay `.devlog/workpad.md`.
- `src/core/linear/poller.ts` — reconcile loop (`tick()`): finalize in-flight, then dispatch new.
- `src/core/task-execution.ts` — `executeTask()` extracted from the execute route (shared by route + dispatcher).
- `src/cli/commands/watch.ts` — `devlog watch` command.
- `src/core/linear/__tests__/*.test.ts` — unit + integration tests.

**Modify:**
- `src/core/types-project.ts` — add `linear?` to `DevlogConfig`.
- `src/core/project-adapter.ts` — add `getLinearConfig()`.
- `src/core/types-dashboard.ts` — add `linear_issue_id?`, `linear_identifier?`, `linear_workpad_comment_id?` to `Task`.
- `src/core/db.ts` — guarded `ALTER TABLE tasks` for the three linear columns.
- `src/app/api/tasks/[id]/execute/route.ts` — call `executeTask()`.
- `src/cli/cli.ts` — register `watch`.

**Test commands:** unit tests run with `bun test src/core/linear`. The husky pre-commit runs the full suite; for focused commits during this plan use `git commit` (let it run) and only fall back to `--no-verify` for docs.

---

## Task 1: Linear config types + loader

**Files:**
- Modify: `src/core/types-project.ts`
- Modify: `src/core/project-adapter.ts`
- Create: `src/core/linear/types.ts`
- Test: `src/core/linear/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/linear/__tests__/config.test.ts
import { test, expect } from "bun:test";
import { normalizeWatchConfig } from "../types";

test("normalizeWatchConfig fills defaults", () => {
  const w = normalizeWatchConfig({ projectSlugId: "abc", devlogProjectId: "repo1" });
  expect(w.triggerState).toBe("Todo");
  expect(w.reviewState).toBe("In Review");
  expect(w.terminalStates).toContain("Done");
  expect(w.defaultEngine).toBe("claude");
  expect(w.labelEngineMap).toEqual({ claude: "claude", codex: "codex" });
});

test("normalizeWatchConfig keeps explicit values", () => {
  const w = normalizeWatchConfig({ projectSlugId: "abc", devlogProjectId: "r", triggerState: "Ready", defaultEngine: "codex" });
  expect(w.triggerState).toBe("Ready");
  expect(w.defaultEngine).toBe("codex");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/config.test.ts`
Expected: FAIL — cannot find module `../types`.

- [ ] **Step 3: Create the types + normalizer**

```ts
// src/core/linear/types.ts
export type EngineId = "claude" | "codex";

export interface LinearWatchConfig {
  projectSlugId: string;
  devlogProjectId: string;
  triggerState: string;
  reviewState: string;
  terminalStates: string[];
  defaultEngine: EngineId;
  labelEngineMap: Record<string, EngineId>;
}

export interface LinearConfig {
  watch: LinearWatchConfig[];
  pollIntervalMs: number;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  stateName: string;
  labels: string[];
}

export function normalizeWatchConfig(raw: Partial<LinearWatchConfig> & { projectSlugId: string; devlogProjectId: string }): LinearWatchConfig {
  return {
    projectSlugId: raw.projectSlugId,
    devlogProjectId: raw.devlogProjectId,
    triggerState: raw.triggerState ?? "Todo",
    reviewState: raw.reviewState ?? "In Review",
    terminalStates: raw.terminalStates ?? ["Done", "Canceled", "Cancelled", "Duplicate"],
    defaultEngine: raw.defaultEngine ?? "claude",
    labelEngineMap: raw.labelEngineMap ?? { claude: "claude", codex: "codex" },
  };
}
```

- [ ] **Step 4: Wire config into DevlogConfig + adapter**

In `src/core/types-project.ts` add the import-free shape (keep this file dependency-light — duplicate the minimal raw shape):

```ts
// append to src/core/types-project.ts
export interface DevlogConfig {
  projects: ProjectConfig[];
  activeProject: string;
  port: number;
  linear?: {
    watch: Array<{
      projectSlugId: string;
      devlogProjectId: string;
      triggerState?: string;
      reviewState?: string;
      terminalStates?: string[];
      defaultEngine?: "claude" | "codex";
      labelEngineMap?: Record<string, "claude" | "codex">;
    }>;
    pollIntervalMs?: number;
  };
}
```

In `src/core/project-adapter.ts` add:

```ts
import { normalizeWatchConfig, type LinearConfig } from "./linear/types";

export function getLinearConfig(): LinearConfig | null {
  const cfg = loadConfig();
  if (!cfg.linear) return null;
  return {
    watch: cfg.linear.watch.map(normalizeWatchConfig),
    pollIntervalMs: cfg.linear.pollIntervalMs ?? 10000,
  };
}
```

(`loadConfig` is the existing private loader; if it is not exported, place `getLinearConfig` in the same module so it can call it.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/linear/types.ts src/core/types-project.ts src/core/project-adapter.ts src/core/linear/__tests__/config.test.ts
git commit -m "feat(linear): config types + getLinearConfig loader"
```

---

## Task 2: DB columns linking tasks to Linear issues

**Files:**
- Modify: `src/core/db.ts` (the guarded-migration block inside `getDb`, near `migrateTasksV2`)
- Modify: `src/core/types-dashboard.ts` (Task interface)
- Test: `src/core/linear/__tests__/migration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/linear/__tests__/migration.test.ts
import { test, expect } from "bun:test";
import Database from "better-sqlite3";
import { migrateLinearColumns } from "../../db";

test("migrateLinearColumns adds linear linkage columns to tasks", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT)");
  migrateLinearColumns(db);
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  expect(cols).toContain("linear_issue_id");
  expect(cols).toContain("linear_identifier");
  expect(cols).toContain("linear_workpad_comment_id");
});

test("migrateLinearColumns is idempotent", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT)");
  migrateLinearColumns(db);
  expect(() => migrateLinearColumns(db)).not.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/migration.test.ts`
Expected: FAIL — `migrateLinearColumns` is not exported from `../../db`.

- [ ] **Step 3: Add the migration function + call it in getDb**

```ts
// src/core/db.ts — add near migrateTasksV2
export function migrateLinearColumns(db: Database.Database): void {
  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("linear_issue_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_issue_id TEXT");
  if (!cols.includes("linear_identifier")) db.exec("ALTER TABLE tasks ADD COLUMN linear_identifier TEXT");
  if (!cols.includes("linear_workpad_comment_id")) db.exec("ALTER TABLE tasks ADD COLUMN linear_workpad_comment_id TEXT");
}
```

In `getDb()`, right after the existing `migrateTasksV2(_db);` call, add:

```ts
  migrateLinearColumns(_db);
```

- [ ] **Step 4: Extend the Task type**

```ts
// src/core/types-dashboard.ts — add to interface Task
  linear_issue_id?: string | null;
  linear_identifier?: string | null;
  linear_workpad_comment_id?: string | null;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/migration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/db.ts src/core/types-dashboard.ts src/core/linear/__tests__/migration.test.ts
git commit -m "feat(linear): tasks↔linear linkage columns + idempotent migration"
```

---

## Task 3: Pure logic — engine resolution, state mapping, workpad assembly

**Files:**
- Create: `src/core/linear/state-map.ts`
- Test: `src/core/linear/__tests__/state-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/linear/__tests__/state-map.test.ts
import { test, expect } from "bun:test";
import { resolveEngine, assembleWorkpad, isTerminal } from "../state-map";
import { normalizeWatchConfig } from "../types";

const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });

test("resolveEngine: label beats default", () => {
  expect(resolveEngine(["codex"], w)).toBe("codex");
  expect(resolveEngine(["urgent"], w)).toBe("claude"); // falls to default
  expect(resolveEngine([], w)).toBe("claude");
});

test("resolveEngine: conflicting engine labels -> default (deterministic)", () => {
  expect(resolveEngine(["claude", "codex"], w)).toBe("claude");
});

test("assembleWorkpad: header + agent body", () => {
  const body = assembleWorkpad({
    engine: "claude", branch: "b", state: "In Review", stamp: "host:/p@abc",
    pr: "https://x/pull/1", agentBody: "### Plan\n[x] done",
  });
  expect(body).toContain("In Review");
  expect(body).toContain("engine: claude");
  expect(body).toContain("https://x/pull/1");
  expect(body).toContain("### Plan");
});

test("isTerminal", () => {
  expect(isTerminal("Done", w)).toBe(true);
  expect(isTerminal("In Progress", w)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/state-map.test.ts`
Expected: FAIL — cannot find module `../state-map`.

- [ ] **Step 3: Implement the pure functions**

```ts
// src/core/linear/state-map.ts
import type { EngineId, LinearWatchConfig } from "./types";

export function resolveEngine(labels: string[], w: LinearWatchConfig): EngineId {
  const matched = labels
    .map((l) => w.labelEngineMap[l.trim().toLowerCase()])
    .filter((e): e is EngineId => e === "claude" || e === "codex");
  const unique = [...new Set(matched)];
  if (unique.length === 1) return unique[0];
  return w.defaultEngine; // 0 matches or conflicting -> default
}

export function isTerminal(stateName: string, w: LinearWatchConfig): boolean {
  return w.terminalStates.some((s) => s.toLowerCase() === stateName.trim().toLowerCase());
}

export interface WorkpadParts {
  engine: EngineId;
  branch: string;
  state: string;
  stamp: string;
  pr?: string | null;
  cost?: string | null;
  agentBody?: string | null;
}

export function assembleWorkpad(p: WorkpadParts): string {
  const header = [
    `## DevLog Workpad`,
    "",
    `\`${p.stamp}\``,
    "",
    `- state: ${p.state}`,
    `- engine: ${p.engine}`,
    `- branch: ${p.branch}`,
    ...(p.pr ? [`- PR: ${p.pr}`] : []),
    ...(p.cost ? [`- cost: ${p.cost}`] : []),
  ].join("\n");
  const body = p.agentBody?.trim()
    ? `\n\n---\n\n${p.agentBody.trim()}`
    : `\n\n---\n\n_(agent narrative pending — written to .devlog/workpad.md)_`;
  return header + body;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/state-map.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/state-map.ts src/core/linear/__tests__/state-map.test.ts
git commit -m "feat(linear): pure engine-resolution + state-map + workpad assembly"
```

---

## Task 4: Linear GraphQL client (with injectable interface for fakes)

**Files:**
- Create: `src/core/linear/client.ts`
- Test: `src/core/linear/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test** (tests the query/variable construction + response mapping via an injected fetch)

```ts
// src/core/linear/__tests__/client.test.ts
import { test, expect } from "bun:test";
import { LinearClient } from "../client";

function fakeFetch(captured: any[]) {
  return async (_url: string, init: any) => {
    captured.push(JSON.parse(init.body));
    return { json: async () => ({ data: { issues: { nodes: [
      { id: "i1", identifier: "ARC-1", title: "t", description: "d", state: { name: "Todo" }, labels: { nodes: [{ name: "codex" }] } },
    ] } } }) } as any;
  };
}

test("fetchTriggerIssues queries by slugId+state and maps labels", async () => {
  const captured: any[] = [];
  const c = new LinearClient("KEY", fakeFetch(captured) as any);
  const issues = await c.fetchTriggerIssues("slug123", "Todo");
  expect(captured[0].variables).toEqual({ slug: "slug123", state: "Todo" });
  expect(issues[0]).toEqual({ id: "i1", identifier: "ARC-1", title: "t", description: "d", stateName: "Todo", labels: ["codex"] });
});

test("updateState sends issueUpdate mutation", async () => {
  const captured: any[] = [];
  const fetch2 = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueUpdate: { success: true } } }) } as any; };
  const c = new LinearClient("KEY", fetch2 as any);
  await c.updateState("i1", "STATEID");
  expect(captured[0].query).toContain("issueUpdate");
  expect(captured[0].variables).toEqual({ id: "i1", stateId: "STATEID" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/client.test.ts`
Expected: FAIL — cannot find module `../client`.

- [ ] **Step 3: Implement the client + interface**

```ts
// src/core/linear/client.ts
import type { LinearIssue } from "./types";

type FetchFn = typeof fetch;

export interface LinearClientI {
  fetchTriggerIssues(slugId: string, state: string): Promise<LinearIssue[]>;
  fetchStateNameByIssue(issueId: string): Promise<string | null>;
  updateState(issueId: string, stateId: string): Promise<void>;
  createComment(issueId: string, body: string): Promise<string>; // returns comment id
  updateComment(commentId: string, body: string): Promise<void>;
}

const Q_TRIGGER = `query($slug:String!,$state:String!){ issues(filter:{project:{slugId:{eq:$slug}}, state:{name:{eq:$state}}}, first:25){ nodes{ id identifier title description state{name} labels{ nodes{ name } } } } }`;
const Q_STATE = `query($id:String!){ issue(id:$id){ state{ name } } }`;
const M_STATE = `mutation($id:String!,$stateId:String!){ issueUpdate(id:$id, input:{stateId:$stateId}){ success } }`;
const M_COMMENT = `mutation($issueId:String!,$body:String!){ commentCreate(input:{issueId:$issueId, body:$body}){ success comment{ id } } }`;
const M_COMMENT_UPD = `mutation($id:String!,$body:String!){ commentUpdate(id:$id, input:{body:$body}){ success } }`;

export class LinearClient implements LinearClientI {
  constructor(private key: string, private fetchFn: FetchFn = fetch) {}

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await this.fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j: any = await r.json();
    if (j.errors) throw new Error(`Linear GraphQL: ${JSON.stringify(j.errors)}`);
    return j.data as T;
  }

  async fetchTriggerIssues(slugId: string, state: string): Promise<LinearIssue[]> {
    const d = await this.gql<{ issues: { nodes: any[] } }>(Q_TRIGGER, { slug: slugId, state });
    return d.issues.nodes.map((n) => ({
      id: n.id, identifier: n.identifier, title: n.title, description: n.description ?? null,
      stateName: n.state.name, labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
    }));
  }

  async fetchStateNameByIssue(issueId: string): Promise<string | null> {
    const d = await this.gql<{ issue: { state: { name: string } } | null }>(Q_STATE, { id: issueId });
    return d.issue?.state.name ?? null;
  }

  async updateState(issueId: string, stateId: string): Promise<void> {
    await this.gql(M_STATE, { id: issueId, stateId });
  }

  async createComment(issueId: string, body: string): Promise<string> {
    const d = await this.gql<{ commentCreate: { comment: { id: string } } }>(M_COMMENT, { issueId, body });
    return d.commentCreate.comment.id;
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.gql(M_COMMENT_UPD, { id: commentId, body });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/client.ts src/core/linear/__tests__/client.test.ts
git commit -m "feat(linear): GraphQL client (query/state/comment) with injectable fetch"
```

---

## Task 5: Extract `executeTask()` from the execute route

**Files:**
- Create: `src/core/task-execution.ts`
- Modify: `src/app/api/tasks/[id]/execute/route.ts`
- Test: `src/core/linear/__tests__/task-execution.test.ts`

This moves the route body into a reusable function so the Linear dispatcher can run a task without HTTP. Keep behavior identical.

- [ ] **Step 1: Write the failing test** (uses a fake processManager + in-memory db helper)

```ts
// src/core/linear/__tests__/task-execution.test.ts
import { test, expect } from "bun:test";
import { buildEngineExecuteInput } from "../../task-execution";

test("buildEngineExecuteInput maps engine -> local_cli_agent_id", () => {
  expect(buildEngineExecuteInput("codex").runtimeAuthInput.local_cli_agent_id).toBe("codex");
  expect(buildEngineExecuteInput("claude").runtimeAuthInput.local_cli_agent_id).toBe("claude");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/task-execution.test.ts`
Expected: FAIL — cannot find module `../../task-execution`.

- [ ] **Step 3: Create `executeTask()` + `buildEngineExecuteInput()`**

Move the body of the route's `POST` (steps 1–6 in the existing handler) into:

```ts
// src/core/task-execution.ts
import { getDb } from "./db";
import { getProject } from "./project-adapter";
import { createWorktree, listWorktrees } from "./worktree-manager";
import { processManager, validateSessionRuntimeProcessLaunch } from "./process-manager";
import { fileWatcher } from "./file-watcher";
import { hasTaskPrompt } from "./task-readiness";
import { markSessionFailedAndReleaseLinkedTask, slugify, buildPromptTemplate } from "./task-lifecycle";
import { isTaskExecutableStatus } from "./task-status-flow";
import { getAgentExecutionInputFromPayload, resolveAgentExecutionConfig } from "./agent-presets";
import { getSessionRuntimeAuthInputFromPayload, getPersistedSessionBaseUrl, resolveSessionRuntimeAuthConfig } from "./session-runtime-auth";
import type { Task, Session } from "./types-dashboard";
import { randomBytes } from "crypto";

export type ExecutePayload = unknown;
export interface ExecuteResult { ok: true; session: Session; worktree: { name: string; path: string } } 
export interface ExecuteError { ok: false; status: number; error: string }

/** Build an execute payload that selects the engine via local_cli_agent_id. */
export function buildEngineExecuteInput(engine: "claude" | "codex") {
  return { agentInput: {}, runtimeAuthInput: { local_cli_agent_id: engine } };
}

export async function executeTask(taskId: string, projectId: string, payload: ExecutePayload): Promise<ExecuteResult | ExecuteError> {
  const db = getDb();
  const agentConfig = resolveAgentExecutionConfig(getAgentExecutionInputFromPayload(payload));
  const runtimeAuthInput = getSessionRuntimeAuthInputFromPayload(payload);
  const runtimeAuthConfig = resolveSessionRuntimeAuthConfig(runtimeAuthInput);

  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?").get(taskId, projectId) as Task | undefined;
  if (!task) return { ok: false, status: 404, error: "Task not found" };
  if (!hasTaskPrompt(task.prompt)) return { ok: false, status: 400, error: "Task has no prompt." };
  if (!isTaskExecutableStatus(task.status)) return { ok: false, status: 400, error: `Cannot execute task with status '${task.status}'` };

  const project = getProject(projectId);
  const preflight = validateSessionRuntimeProcessLaunch(runtimeAuthConfig, project.path);
  if (!preflight.ok) return { ok: false, status: 400, error: preflight.error };

  const slug = slugify(task.title);
  const worktreeName = `task-${slug}`;
  const branchName = `task/${taskId.slice(0, 8)}-${slug}`;

  let worktree;
  try {
    worktree = await createWorktree(worktreeName, branchName, project.defaultBranch, projectId);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("already exists")) {
      worktree = (await listWorktrees(projectId)).find((w) => w.name === worktreeName);
      if (!worktree) return { ok: false, status: 409, error: `Worktree conflict: ${msg}` };
    } else return { ok: false, status: 500, error: `Failed to create worktree: ${msg}` };
  }

  const sessionId = randomBytes(8).toString("hex");
  const prompt = buildPromptTemplate(task, project, worktree.path, branchName, agentConfig, runtimeAuthConfig);

  const session = db.prepare(
    `INSERT INTO sessions (id, project_id, task_id, worktree_name, worktree_path, branch_name, status, coding_agent_id, agent_team_id, session_auth_mode, agent_api_key_env_var, local_cli_agent_id, agent_model, agent_reasoning, agent_api_protocol, agent_api_version, agent_base_url, agent_max_tokens, prompt)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).get(
    sessionId, projectId, taskId, worktreeName, worktree.path, branchName,
    agentConfig.codingAgent.id, agentConfig.agentTeam.id, runtimeAuthConfig.mode,
    runtimeAuthConfig.agentApiKeyEnvVar, runtimeAuthConfig.localCliAgentId, runtimeAuthConfig.model,
    runtimeAuthConfig.reasoning, runtimeAuthConfig.apiProtocol, runtimeAuthConfig.apiVersion,
    getPersistedSessionBaseUrl(runtimeAuthConfig), runtimeAuthConfig.maxTokens, prompt
  ) as Session;

  db.prepare("UPDATE tasks SET status = 'in_progress', worktree_name = ?, session_id = ?, fail_reason = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(worktreeName, sessionId, taskId);

  try { fileWatcher.watchWorktree(worktreeName, worktree.path, sessionId); } catch {}

  try {
    processManager.sendMessage(sessionId, prompt, runtimeAuthInput);
  } catch (err) {
    markSessionFailedAndReleaseLinkedTask(db, sessionId, `Failed to start agent: ${(err as Error).message}`);
    return { ok: false, status: 500, error: `Failed to start agent: ${(err as Error).message}` };
  }

  return { ok: true, session, worktree: { name: worktree.name, path: worktree.path } };
}
```

- [ ] **Step 4: Refactor the route to call `executeTask()`**

Replace the body of `POST` in `src/app/api/tasks/[id]/execute/route.ts` with:

```ts
import { executeTask } from "@/core/task-execution";
import { resolveProjectId } from "@/lib/api-utils";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params;
  let payload: unknown;
  try { payload = await req.json(); } catch {}
  const projectId = resolveProjectId(req);
  const result = await executeTask(taskId, projectId, payload);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ session: result.session, worktree: result.worktree }, { status: 201 });
}
```

- [ ] **Step 5: Run tests to verify**

Run: `bun test src/core/linear/__tests__/task-execution.test.ts`
Expected: PASS (1 test). Then run the existing task suite to confirm no regression: `bun test src/core` (the execute route behavior is unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/core/task-execution.ts "src/app/api/tasks/[id]/execute/route.ts" src/core/linear/__tests__/task-execution.test.ts
git commit -m "refactor(tasks): extract executeTask() core shared by route + linear dispatcher"
```

---

## Task 6: Dispatcher — Linear issue → mirror task → executeTask(engine), idempotent

**Files:**
- Create: `src/core/linear/dispatcher.ts`
- Test: `src/core/linear/__tests__/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test** (in-memory db + fake executeTask)

```ts
// src/core/linear/__tests__/dispatcher.test.ts
import { test, expect } from "bun:test";
import Database from "better-sqlite3";
import { dispatchIssue, alreadyLinked } from "../dispatcher";
import { normalizeWatchConfig } from "../types";

function db0() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'todo', priority TEXT DEFAULT 'medium', worktree_name TEXT, session_id TEXT, sort_order INTEGER DEFAULT 0, prompt TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT, linear_issue_id TEXT, linear_identifier TEXT, linear_workpad_comment_id TEXT)`);
  return db;
}
const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "repo1" });
const issue = { id: "i1", identifier: "ARC-1", title: "do x", description: "body", stateName: "Todo", labels: ["codex"] };

test("dispatchIssue creates a mirror task with linkage + chosen engine, and calls executeTask once", async () => {
  const db = db0();
  const calls: any[] = [];
  const fakeExecute = async (taskId: string, projectId: string, payload: any) => { calls.push({ taskId, projectId, payload }); return { ok: true } as any; };
  await dispatchIssue(db, issue, w, fakeExecute);
  const row = db.prepare("SELECT * FROM tasks WHERE linear_issue_id = ?").get("i1") as any;
  expect(row.title).toBe("do x");
  expect(row.linear_identifier).toBe("ARC-1");
  expect(calls.length).toBe(1);
  expect(calls[0].payload.runtimeAuthInput.local_cli_agent_id).toBe("codex");
});

test("alreadyLinked is true after dispatch (idempotency guard)", async () => {
  const db = db0();
  const fakeExecute = async () => ({ ok: true } as any);
  await dispatchIssue(db, issue, w, fakeExecute);
  expect(alreadyLinked(db, "i1")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/dispatcher.test.ts`
Expected: FAIL — cannot find module `../dispatcher`.

- [ ] **Step 3: Implement the dispatcher**

```ts
// src/core/linear/dispatcher.ts
import type Database from "better-sqlite3";
import { randomBytes } from "crypto";
import type { LinearIssue, LinearWatchConfig } from "./types";
import { resolveEngine } from "./state-map";
import { buildEngineExecuteInput, type ExecuteResult, type ExecuteError } from "../task-execution";

type ExecuteFn = (taskId: string, projectId: string, payload: unknown) => Promise<ExecuteResult | ExecuteError>;

export function alreadyLinked(db: Database.Database, issueId: string): boolean {
  return !!db.prepare("SELECT 1 FROM tasks WHERE linear_issue_id = ?").get(issueId);
}

export async function dispatchIssue(db: Database.Database, issue: LinearIssue, w: LinearWatchConfig, execute: ExecuteFn): Promise<void> {
  if (alreadyLinked(db, issue.id)) return; // idempotency
  const engine = resolveEngine(issue.labels, w);
  const taskId = randomBytes(8).toString("hex");
  const prompt = buildDispatchPrompt(issue, engine);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, sort_order, prompt, linear_issue_id, linear_identifier)
     VALUES (?, ?, ?, ?, 'todo', 'high', 0, ?, ?, ?)`
  ).run(taskId, w.devlogProjectId, issue.title, issue.description ?? null, prompt, issue.id, issue.identifier);

  const input = buildEngineExecuteInput(engine);
  await execute(taskId, w.devlogProjectId, input);
}

function buildDispatchPrompt(issue: LinearIssue, engine: string): string {
  return [
    `Implement this ticket. cwd is the repo worktree; a working branch is already checked out.`,
    ``,
    `TICKET ${issue.identifier}: ${issue.title}`,
    ``,
    issue.description ?? "",
    ``,
    `Delivery: implement, run the project's tests until green, commit, push the branch, and open a PR against the default branch with \`gh\`.`,
    `Maintain a running narrative (plan, reproduce, validation evidence) in \`.devlog/workpad.md\` at the repo root — create it if absent and keep it updated.`,
    `Do NOT touch Linear in any way; status + the Linear comment are handled outside this session. Do not merge.`,
  ].join("\n");
}
```

(Note: `.devlog/workpad.md` should be added to the repo's `.gitignore` by the agent or pre-seeded; it must not block the PR. The writeback reads it from the worktree, not from git.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/dispatcher.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/dispatcher.ts src/core/linear/__tests__/dispatcher.test.ts
git commit -m "feat(linear): dispatcher mirrors issue->task, resolves engine, idempotent"
```

---

## Task 7: Writeback — finalize a dispatched issue (PR detect, state, relay workpad)

**Files:**
- Create: `src/core/linear/writeback.ts`
- Test: `src/core/linear/__tests__/writeback.test.ts`

- [ ] **Step 1: Write the failing test** (fake LinearClient + fake PR-detector + fake workpad reader)

```ts
// src/core/linear/__tests__/writeback.test.ts
import { test, expect } from "bun:test";
import { finalizeOutcome } from "../writeback";
import { normalizeWatchConfig } from "../types";

const w = normalizeWatchConfig({ projectSlugId: "p", devlogProjectId: "r" });
const ctx = (over: any = {}) => ({
  client: { calls: [] as any[], async updateState(id: string, s: string) { this.calls.push(["state", id, s]); }, async updateComment(id: string, b: string) { this.calls.push(["comment", id, b]); } },
  reviewStateId: "REVIEW", commentId: "c1", issueId: "i1", branch: "b", engine: "claude" as const, stamp: "h:/p@a",
  detectPr: async () => "https://x/pull/9", readWorkpad: async () => "### Plan\n[x] ok", ...over,
});

test("session completed + PR -> In Review + workpad relayed", async () => {
  const c = ctx();
  await finalizeOutcome("completed", c as any, w);
  expect(c.client.calls).toContainEqual(["state", "i1", "REVIEW"]);
  const comment = c.client.calls.find((x) => x[0] === "comment");
  expect(comment[2]).toContain("In Review");
  expect(comment[2]).toContain("### Plan");
});

test("session failed -> stays In Progress, BLOCKED note, no state change", async () => {
  const c = ctx({ detectPr: async () => "" });
  await finalizeOutcome("failed", c as any, w);
  expect(c.client.calls.find((x) => x[0] === "state")).toBeUndefined();
  const comment = c.client.calls.find((x) => x[0] === "comment");
  expect(comment[2]).toContain("BLOCKED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/writeback.test.ts`
Expected: FAIL — cannot find module `../writeback`.

- [ ] **Step 3: Implement writeback**

```ts
// src/core/linear/writeback.ts
import type { LinearClientI } from "./client";
import type { EngineId, LinearWatchConfig } from "./types";
import { assembleWorkpad } from "./state-map";

export interface FinalizeCtx {
  client: LinearClientI;
  reviewStateId: string;
  commentId: string;
  issueId: string;
  branch: string;
  engine: EngineId;
  stamp: string;
  cost?: string | null;
  detectPr: () => Promise<string>;       // gh pr list --head <branch> --json url
  readWorkpad: () => Promise<string>;    // read .devlog/workpad.md from worktree
}

export type SessionOutcome = "completed" | "failed" | "killed";

export async function finalizeOutcome(outcome: SessionOutcome, ctx: FinalizeCtx, _w: LinearWatchConfig): Promise<void> {
  const agentBody = await safe(ctx.readWorkpad);
  if (outcome === "completed") {
    const pr = await safe(ctx.detectPr);
    if (pr) {
      await ctx.client.updateComment(ctx.commentId, assembleWorkpad({ engine: ctx.engine, branch: ctx.branch, state: "In Review", stamp: ctx.stamp, pr, cost: ctx.cost, agentBody }));
      await ctx.client.updateState(ctx.issueId, ctx.reviewStateId);
      return;
    }
  }
  // failed / killed / completed-without-PR -> stays In Progress, BLOCKED note, harness reports the reason
  const reason = outcome === "completed" ? "session ended but no PR was opened" : `agent ${outcome}`;
  await ctx.client.updateComment(ctx.commentId, assembleWorkpad({
    engine: ctx.engine, branch: ctx.branch, state: `In Progress — BLOCKED`, stamp: ctx.stamp, cost: ctx.cost,
    agentBody: `**BLOCKED:** ${reason}. Left for a human.\n\n${agentBody ?? ""}`,
  }));
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/writeback.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/writeback.ts src/core/linear/__tests__/writeback.test.ts
git commit -m "feat(linear): writeback finalize (In Review on PR, BLOCKED on failure, relay workpad)"
```

---

## Task 8: Poller — reconcile loop (finalize in-flight, dispatch new)

**Files:**
- Create: `src/core/linear/poller.ts`
- Test: `src/core/linear/__tests__/poller.test.ts`

- [ ] **Step 1: Write the failing test** (one tick: dispatches a new trigger issue, doesn't double-dispatch)

```ts
// src/core/linear/__tests__/poller.test.ts
import { test, expect } from "bun:test";
import Database from "better-sqlite3";
import { tick } from "../poller";
import { normalizeWatchConfig } from "../types";

function db0() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT, priority TEXT, worktree_name TEXT, session_id TEXT, sort_order INTEGER DEFAULT 0, prompt TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT, linear_issue_id TEXT, linear_identifier TEXT, linear_workpad_comment_id TEXT)`);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, branch_name TEXT, worktree_path TEXT)`);
  return db;
}
const w = normalizeWatchConfig({ projectSlugId: "slug", devlogProjectId: "r" });

test("tick dispatches each trigger issue exactly once across two ticks", async () => {
  const db = db0();
  const issue = { id: "i1", identifier: "ARC-1", title: "t", description: null, stateName: "Todo", labels: [] };
  const client: any = { async fetchTriggerIssues() { return [issue]; }, async createComment() { return "c1"; }, async updateState() {}, async updateComment() {} };
  const dispatched: string[] = [];
  const deps = { db, client, watch: w,
    onDispatch: async (iss: any) => { dispatched.push(iss.id); db.prepare("INSERT INTO tasks (id, linear_issue_id, status, project_id) VALUES (?,?, 'in_progress', 'r')").run("t1", iss.id); },
    finalize: async () => {}, stateIds: { inProgress: "IP", review: "RV" } };
  await tick(deps as any);
  await tick(deps as any);
  expect(dispatched).toEqual(["i1"]); // only once
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/poller.test.ts`
Expected: FAIL — cannot find module `../poller`.

- [ ] **Step 3: Implement the poller**

```ts
// src/core/linear/poller.ts
import type Database from "better-sqlite3";
import type { LinearClientI } from "./client";
import type { LinearIssue, LinearWatchConfig } from "./types";
import { alreadyLinked } from "./dispatcher";

export interface TickDeps {
  db: Database.Database;
  client: LinearClientI;
  watch: LinearWatchConfig;
  onDispatch: (issue: LinearIssue) => Promise<void>;     // dispatchIssue bound + In Progress writeback + workpad create
  finalize: () => Promise<void>;                          // finalize in-flight tasks for this watch
  stateIds: { inProgress: string; review: string };
}

/** One reconcile pass: finalize in-flight first, then dispatch new trigger issues. */
export async function tick(deps: TickDeps): Promise<void> {
  await deps.finalize();
  const issues = await deps.client.fetchTriggerIssues(deps.watch.projectSlugId, deps.watch.triggerState);
  for (const issue of issues) {
    if (alreadyLinked(deps.db, issue.id)) continue;
    await deps.onDispatch(issue);
  }
}

export function startPoller(deps: TickDeps, intervalMs: number): { stop: () => void } {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try { await tick(deps); } catch (e) { console.error("[linear poller] tick error:", e); }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return { stop: () => { stopped = true; } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/poller.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/core/linear/poller.ts src/core/linear/__tests__/poller.test.ts
git commit -m "feat(linear): poller reconcile loop (finalize in-flight, dispatch new, dedup)"
```

---

## Task 9: `devlog watch` CLI command (wires it all together)

**Files:**
- Create: `src/cli/commands/watch.ts`
- Modify: `src/cli/cli.ts`
- Test: `src/core/linear/__tests__/wiring.test.ts`

This is the composition root: build the real `LinearClient`, resolve state IDs once, bind `dispatchIssue` (+ In Progress writeback + workpad-comment create) and `finalize` (read session status from DB, detect PR via `gh`, read `.devlog/workpad.md`, call `finalizeOutcome`), and start the poller per watch entry.

- [ ] **Step 1: Write the failing test** (asserts the wiring builds the dispatch+finalize closures; pure assembly, no network)

```ts
// src/core/linear/__tests__/wiring.test.ts
import { test, expect } from "bun:test";
import { buildEnvStamp } from "../../linear/wiring";

test("buildEnvStamp formats host:path@sha", () => {
  expect(buildEnvStamp("host", "/p", "abc1234")).toBe("host:/p@abc1234");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/core/linear/__tests__/wiring.test.ts`
Expected: FAIL — cannot find module `../../linear/wiring`.

- [ ] **Step 3: Implement wiring + the command**

Create `src/core/linear/wiring.ts` exporting the small pure helper plus the composition function:

```ts
// src/core/linear/wiring.ts
import { $ } from "bun";
import { hostname } from "os";
import { getDb } from "../db";
import { getLinearConfig } from "../project-adapter";
import { LinearClient } from "./client";
import { dispatchIssue } from "./dispatcher";
import { finalizeOutcome } from "./writeback";
import { assembleWorkpad } from "./state-map";
import { executeTask } from "../task-execution";
import { startPoller, type TickDeps } from "./poller";
import type { LinearWatchConfig } from "./types";

export function buildEnvStamp(host: string, path: string, sha: string): string {
  return `${host}:${path}@${sha}`;
}

async function resolveStateIds(key: string, _w: LinearWatchConfig) {
  // Query the team's states once; map triggerState/reviewState names -> ids.
  // (Use a small GraphQL call; omitted here for brevity — implement with the same fetch pattern as LinearClient.)
  return { inProgress: process.env.LINEAR_IN_PROGRESS_ID!, review: process.env.LINEAR_IN_REVIEW_ID! };
}

export async function startWatching(): Promise<Array<{ stop: () => void }>> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");
  const cfg = getLinearConfig();
  if (!cfg) throw new Error("No `linear` config in devlog.config.json");
  const db = getDb();
  const client = new LinearClient(key);
  const handles: Array<{ stop: () => void }> = [];

  for (const w of cfg.watch) {
    const stateIds = await resolveStateIds(key, w);
    const deps: TickDeps = {
      db, client, watch: w, stateIds,
      onDispatch: async (issue) => {
        await dispatchIssue(db, issue, w, executeTask);
        await client.updateState(issue.id, stateIds.inProgress);
        const row = db.prepare("SELECT t.id as taskId, s.branch_name as branch, s.worktree_path as wp, s.local_cli_agent_id as engine FROM tasks t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.linear_issue_id = ?").get(issue.id) as any;
        const stamp = buildEnvStamp(hostname(), row?.wp ?? "?", "new");
        const commentId = await client.createComment(issue.id, assembleWorkpad({ engine: row?.engine ?? "claude", branch: row?.branch ?? "?", state: "In Progress", stamp }));
        db.prepare("UPDATE tasks SET linear_workpad_comment_id = ? WHERE linear_issue_id = ?").run(commentId, issue.id);
      },
      finalize: async () => {
        const rows = db.prepare("SELECT t.linear_issue_id as iid, t.linear_workpad_comment_id as cid, s.status as st, s.branch_name as branch, s.worktree_path as wp, s.local_cli_agent_id as engine FROM tasks t JOIN sessions s ON s.id = t.session_id WHERE t.linear_issue_id IS NOT NULL AND s.status IN ('completed','failed','killed') AND t.status = 'in_progress'").all() as any[];
        for (const r of rows) {
          await finalizeOutcome(r.st, {
            client, reviewStateId: stateIds.review, commentId: r.cid, issueId: r.iid,
            branch: r.branch, engine: r.engine, stamp: buildEnvStamp(hostname(), r.wp, "done"),
            detectPr: async () => (await $`gh pr list --head ${r.branch} --json url --jq '.[0].url'`.cwd(r.wp).nothrow().quiet().text()).trim(),
            readWorkpad: async () => await Bun.file(`${r.wp}/.devlog/workpad.md`).text(),
          }, w);
          db.prepare("UPDATE tasks SET status = CASE WHEN ? = 'completed' THEN 'review' ELSE 'blocked' END, updated_at = datetime('now') WHERE linear_issue_id = ?").run(r.st, r.iid);
        }
      },
    };
    handles.push(startPoller(deps, cfg.pollIntervalMs));
  }
  return handles;
}
```

Create the command:

```ts
// src/cli/commands/watch.ts
import { startWatching } from "../../core/linear/wiring";

export async function watchCommand(): Promise<void> {
  console.log("devlog watch — polling Linear (Ctrl-C to stop)");
  const handles = await startWatching();
  process.on("SIGINT", () => { handles.forEach((h) => h.stop()); process.exit(0); });
  await new Promise(() => {}); // run forever
}
```

Register in `src/cli/cli.ts` (follow the existing `serveCommand` registration pattern):

```ts
import { watchCommand } from "./commands/watch";
// ...
program.command("watch").description("Drive DevLog from Linear (poll trigger issues, run agents, write back)").action(() => watchCommand());
// add "watch" to KNOWN_COMMANDS
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/core/linear/__tests__/wiring.test.ts`
Expected: PASS (1 test). Then `bun test src/core/linear` — all linear unit tests green.

- [ ] **Step 5: Implement `resolveStateIds` properly**

Replace the env-var stub with a real GraphQL query of the team's workflow states (reuse `LinearClient`'s fetch pattern): query `team.states` (or `workflowStates`) and map `w.triggerState`/`w.reviewState` names → ids. Add a unit test with an injected fake that returns states and asserts the name→id mapping. Commit separately.

- [ ] **Step 6: Commit**

```bash
git add src/core/linear/wiring.ts src/cli/commands/watch.ts src/cli/cli.ts src/core/linear/__tests__/wiring.test.ts
git commit -m "feat(linear): devlog watch command + composition root"
```

---

## Task 10: Live smoke (manual, behind real Linear) — the ship Live-Demo / Done-when gate

**Files:** none (manual verification; record evidence in the tracking Linear issue).

- [ ] **Step 1: One-time setup** — fork already exists (`loop2zero/DevLog`). Add to `devlog.config.json` a `linear.watch` entry pointing a throwaway Linear project (its `slugId`) at a local test repo (e.g. `ai-native-intel`). Export `LINEAR_API_KEY`.

- [ ] **Step 2: Codex run** — create a small ticket in the watched project, move it to `Todo`. Run `devlog watch`. Expected: state → In Progress (harness), workpad comment appears, agent (codex) opens a PR, state → In Review with workpad body. Capture the issue URL as evidence.

- [ ] **Step 3: Claude run (the reason this exists)** — label a second ticket `claude`, move to `Todo`. Expected: same flow runs with Claude, zero code changes. Capture evidence.

- [ ] **Step 4: Kill test** — dispatch a third ticket, `kill` the agent process mid-run. Expected: harness deterministically writes a `BLOCKED` workpad with the reason; issue left In Progress. Capture evidence.

- [ ] **Step 5: Isolation check** — confirm only the watched project's issues were touched; other projects/issues untouched.

- [ ] **Step 6: Teardown** — close test PRs + delete branches, cancel test issues, `git worktree prune`. Record the run in the tracking Linear issue and move it per the human decision gate.

---

## Self-Review (done by author)

- **Spec coverage:** §2 writeback decision → Tasks 6/7/9 (harness state + agent workpad relay). §3 architecture → Tasks 4–9. §4 data flow/state-map → Tasks 3/7/8/9. §5 error/idempotency/safety → idempotency (Task 6 `alreadyLinked` + persisted columns Task 2), failure/liveness (Task 7 BLOCKED + Task 9 finalize from DB session status), scope guard (Task 8 per-watch slugId), auth (Task 9 `LINEAR_API_KEY` check), safety (no Linear access in agent — Task 6 prompt). §6 testing → every task is TDD; Task 10 live smoke. §6 v1 Done-when → Task 10 steps 2–5.
- **Placeholders:** `resolveStateIds` is intentionally stubbed in Task 9 Step 3 and then implemented for real in Task 9 Step 5 (called out, not a silent TODO). The `.devlog/workpad.md` gitignore note is explicit.
- **Type consistency:** `EngineId`, `LinearWatchConfig`, `LinearIssue`, `LinearClientI`, `executeTask`/`buildEngineExecuteInput`, `finalizeOutcome`/`FinalizeCtx`, `tick`/`TickDeps` names are used consistently across tasks.
