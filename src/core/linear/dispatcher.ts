import type Database from "better-sqlite3";
import { randomBytes } from "crypto";
import type { LinearIssue, LinearWatchConfig } from "./types";
import { resolveEngine } from "./state-map";
import { buildEngineExecuteInput } from "../task-execution";

type ExecuteFn = (taskId: string, projectId: string, payload: unknown) => Promise<unknown>;

export function alreadyLinked(db: Database.Database, issueId: string): boolean {
  return !!db.prepare("SELECT 1 FROM tasks WHERE linear_issue_id = ?").get(issueId);
}

export async function dispatchIssue(
  db: Database.Database,
  issue: LinearIssue,
  w: LinearWatchConfig,
  execute: ExecuteFn,
): Promise<void> {
  if (alreadyLinked(db, issue.id)) return; // idempotency guard

  const engine = resolveEngine(issue.labels, w);
  const taskId = randomBytes(8).toString("hex");
  const prompt = buildDispatchPrompt(issue);

  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, sort_order, prompt, linear_issue_id, linear_identifier, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'todo', 'high', 0, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    taskId,
    w.devlogProjectId,
    issue.title,
    issue.description ?? null,
    prompt,
    issue.id,
    issue.identifier,
  );

  await execute(taskId, w.devlogProjectId, buildEngineExecuteInput(engine));
}

function buildDispatchPrompt(issue: LinearIssue): string {
  return [
    `Implement this ticket. cwd is the repo worktree; a working branch is already checked out.`,
    ``,
    `TICKET ${issue.identifier}: ${issue.title}`,
    ``,
    issue.description ?? "",
    ``,
    `Delivery: implement, run the project's tests until green, commit, push the branch, and open a PR against the default branch with \`gh\`.`,
    `Maintain a running narrative (plan, reproduce, validation evidence) in \`.devlog/workpad.md\` at the repo root — create it if absent and keep it updated.`,
    `Do NOT touch Linear in any way; status and the Linear comment are handled outside this session. Do not merge.`,
  ].join("\n");
}
