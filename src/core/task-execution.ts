import { randomBytes } from "crypto";
import { getDb } from "./db";
import { getProject } from "./project-adapter";
import { createWorktree, listWorktrees } from "./worktree-manager";
import {
  processManager,
  validateSessionRuntimeProcessLaunch,
} from "./process-manager";
import { fileWatcher } from "./file-watcher";
import { hasTaskPrompt } from "./task-readiness";
import {
  markSessionFailedAndReleaseLinkedTask,
  slugify,
  buildPromptTemplate,
} from "./task-lifecycle";
import { isTaskExecutableStatus } from "./task-status-flow";
import {
  getAgentExecutionInputFromPayload,
  resolveAgentExecutionConfig,
} from "./agent-presets";
import {
  getSessionRuntimeAuthInputFromPayload,
  getPersistedSessionBaseUrl,
  resolveSessionRuntimeAuthConfig,
  type SessionRuntimeAuthInput,
} from "./session-runtime-auth";
import type { Task, Session } from "./types-dashboard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecuteSuccess {
  ok: true;
  session: Session;
  worktree: { name: string; path: string };
}

export interface ExecuteError {
  ok: false;
  status: number;
  error: string;
}

export type ExecuteResult = ExecuteSuccess | ExecuteError;

// ---------------------------------------------------------------------------
// buildEngineExecuteInput
// Helper for the Linear dispatcher: map a CLI engine name to a minimal payload
// that will be interpreted by resolveSessionRuntimeAuthConfig as a local-cli
// run with the given local_cli_agent_id.
// ---------------------------------------------------------------------------

export function buildEngineExecuteInput(
  engine: "claude" | "codex",
): SessionRuntimeAuthInput {
  return { local_cli_agent_id: engine, unattended: true };
}

// ---------------------------------------------------------------------------
// executeTask
// Reusable core: validates, creates worktree, inserts session row, updates
// task, starts file watcher, and spawns the agent process.
// Returns ExecuteResult — callers translate this to HTTP or use it directly.
// ---------------------------------------------------------------------------

export async function executeTask(
  taskId: string,
  projectId: string,
  payload: unknown,
): Promise<ExecuteResult> {
  const db = getDb();

  const agentConfig = resolveAgentExecutionConfig(
    getAgentExecutionInputFromPayload(payload),
  );
  const runtimeAuthInput = getSessionRuntimeAuthInputFromPayload(payload);
  const runtimeAuthConfig = resolveSessionRuntimeAuthConfig(runtimeAuthInput);

  // 1. Fetch and validate task
  const task = db
    .prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?")
    .get(taskId, projectId) as Task | undefined;

  if (!task) {
    return { ok: false, status: 404, error: "Task not found" };
  }
  if (!hasTaskPrompt(task.prompt)) {
    return {
      ok: false,
      status: 400,
      error: "Task has no prompt. Add a prompt before executing.",
    };
  }
  if (!isTaskExecutableStatus(task.status)) {
    return {
      ok: false,
      status: 400,
      error: `Cannot execute task with status '${task.status}'`,
    };
  }

  // 2. Create worktree
  const project = getProject(projectId);
  const preflight = validateSessionRuntimeProcessLaunch(
    runtimeAuthConfig,
    project.path,
  );
  if (!preflight.ok) {
    return { ok: false, status: 400, error: preflight.error };
  }

  const slug = slugify(task.title);
  const worktreeName = `task-${slug}`;
  const branchName = `task/${taskId.slice(0, 8)}-${slug}`;

  let worktree: { name: string; path: string } | undefined;
  try {
    worktree = await createWorktree(
      worktreeName,
      branchName,
      project.defaultBranch,
      projectId,
    );
  } catch (err) {
    // Worktree/branch might already exist (retry scenario)
    const msg = (err as Error).message;
    if (msg.includes("already exists")) {
      const wts = await listWorktrees(projectId);
      worktree = wts.find((w) => w.name === worktreeName);
      if (!worktree) {
        return {
          ok: false,
          status: 409,
          error: `Worktree conflict: ${msg}`,
        };
      }
    } else {
      return {
        ok: false,
        status: 500,
        error: `Failed to create worktree: ${msg}`,
      };
    }
  }

  // 3. Create session
  const sessionId = randomBytes(8).toString("hex");
  const prompt = buildPromptTemplate(
    task,
    project,
    worktree.path,
    branchName,
    agentConfig,
    runtimeAuthConfig,
  );

  const session = db
    .prepare(
      `INSERT INTO sessions (
        id, project_id, task_id, worktree_name, worktree_path, branch_name,
        status, coding_agent_id, agent_team_id, session_auth_mode,
        agent_api_key_env_var, local_cli_agent_id, agent_model,
        agent_reasoning, agent_api_protocol, agent_api_version,
        agent_base_url, agent_max_tokens, prompt
      )
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      sessionId,
      projectId,
      taskId,
      worktreeName,
      worktree.path,
      branchName,
      agentConfig.codingAgent.id,
      agentConfig.agentTeam.id,
      runtimeAuthConfig.mode,
      runtimeAuthConfig.agentApiKeyEnvVar,
      runtimeAuthConfig.localCliAgentId,
      runtimeAuthConfig.model,
      runtimeAuthConfig.reasoning,
      runtimeAuthConfig.apiProtocol,
      runtimeAuthConfig.apiVersion,
      getPersistedSessionBaseUrl(runtimeAuthConfig),
      runtimeAuthConfig.maxTokens,
      prompt,
    ) as Session;

  // 4. Update task
  db.prepare(
    "UPDATE tasks SET status = 'in_progress', worktree_name = ?, session_id = ?, fail_reason = NULL, completed_at = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(worktreeName, sessionId, taskId);

  // 5. Start file watcher
  try {
    fileWatcher.watchWorktree(worktreeName, worktree.path, sessionId);
  } catch {
    // non-fatal
  }

  // 6. Spawn agent (non-blocking)
  try {
    processManager.sendMessage(sessionId, prompt, runtimeAuthInput);
  } catch (err) {
    markSessionFailedAndReleaseLinkedTask(
      db,
      sessionId,
      `Failed to start agent: ${(err as Error).message}`,
    );
    return {
      ok: false,
      status: 500,
      error: `Failed to start agent: ${(err as Error).message}`,
    };
  }

  return { ok: true, session, worktree };
}
