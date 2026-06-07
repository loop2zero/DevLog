import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { hostname } from "os";
import { getDb } from "../db";
import { getLinearConfig } from "../project-adapter";
import { LinearClient, type LinearClientI } from "./client";
import { dispatchIssue } from "./dispatcher";
import { finalizeOutcome } from "./writeback";
import { assembleWorkpad } from "./state-map";
import { executeTask } from "../task-execution";
import { startPoller, type TickDeps } from "./poller";
import type { EngineId, LinearWatchConfig } from "./types";

const execAsync = promisify(exec);

export function buildEnvStamp(host: string, path: string, sha: string): string {
  return `${host}:${path}@${sha}`;
}

export async function resolveStateIds(
  client: Pick<LinearClientI, "fetchWorkflowStates">,
  w: LinearWatchConfig,
): Promise<{ inProgress: string; review: string }> {
  const states = await client.fetchWorkflowStates(w.projectSlugId);
  const byName = (name: string) => {
    const s = states.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) throw new Error(`Linear state "${name}" not found in project ${w.projectSlugId}`);
    return s.id;
  };
  return { inProgress: byName("In Progress"), review: byName(w.reviewState) };
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
    const stateIds = await resolveStateIds(client, w);
    const deps: TickDeps = {
      db,
      client,
      watch: w,
      stateIds,
      onDispatch: async (issue) => {
        await dispatchIssue(db, issue, w, executeTask);
        await client.updateState(issue.id, stateIds.inProgress);
        const row = db
          .prepare(
            "SELECT s.branch_name as branch, s.worktree_path as wp, s.local_cli_agent_id as engine FROM tasks t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.linear_issue_id = ?",
          )
          .get(issue.id) as { branch?: string; wp?: string; engine?: string } | undefined;
        const stamp = buildEnvStamp(hostname(), row?.wp ?? "?", "new");
        const commentId = await client.createComment(
          issue.id,
          assembleWorkpad({
            engine: (row?.engine as EngineId) ?? "claude",
            branch: row?.branch ?? "?",
            state: "In Progress",
            stamp,
          }),
        );
        db.prepare("UPDATE tasks SET linear_workpad_comment_id = ? WHERE linear_issue_id = ?").run(
          commentId,
          issue.id,
        );
      },
      finalize: async () => {
        const rows = db
          .prepare(
            "SELECT t.linear_issue_id as iid, t.linear_workpad_comment_id as cid, s.status as st, s.branch_name as branch, s.worktree_path as wp, s.local_cli_agent_id as engine FROM tasks t JOIN sessions s ON s.id = t.session_id WHERE t.linear_issue_id IS NOT NULL AND s.status IN ('completed','failed','killed') AND t.status = 'in_progress'",
          )
          .all() as Array<{
          iid: string;
          cid: string;
          st: "completed" | "failed" | "killed";
          branch: string;
          wp: string;
          engine: string;
        }>;
        for (const r of rows) {
          await finalizeOutcome(
            r.st,
            {
              client,
              reviewStateId: stateIds.review,
              commentId: r.cid,
              issueId: r.iid,
              branch: r.branch,
              engine: (r.engine as EngineId) ?? "claude",
              stamp: buildEnvStamp(hostname(), r.wp, "done"),
              detectPr: async () => {
                try {
                  const { stdout } = await execAsync(
                    `gh pr list --head ${r.branch} --json url --jq '.[0].url'`,
                    { cwd: r.wp },
                  );
                  return stdout.trim();
                } catch {
                  return "";
                }
              },
              readWorkpad: async () => readFile(`${r.wp}/.devlog/workpad.md`, "utf-8"),
            },
            w,
          );
          db.prepare(
            "UPDATE tasks SET status = CASE WHEN ? = 'completed' THEN 'review' ELSE 'blocked' END, updated_at = datetime('now') WHERE linear_issue_id = ?",
          ).run(r.st, r.iid);
        }
      },
    };
    handles.push(startPoller(deps, cfg.pollIntervalMs));
  }
  return handles;
}
