import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import { hostname } from "os";
import { getDb } from "../db";
import { getLinearConfig, getRepoRoot } from "../project-adapter";
import { LinearClient, type LinearClientI } from "./client";
import { dispatchIssue } from "./dispatcher";
import { finalizeOutcome } from "./writeback";
import { assembleWorkpad } from "./state-map";
import { executeTask } from "../task-execution";
import { startPoller, type TickDeps } from "./poller";
import { runBreakdown } from "./batch-create";
import { reconcileBreakdowns } from "./reconcile";
import type { EngineId, LinearIssue, LinearWatchConfig } from "./types";

const execFileAsync = promisify(execFile);

export function buildEnvStamp(host: string, path: string, sha: string): string {
  return `${host}:${path}@${sha}`;
}

export async function resolveStateIds(
  client: Pick<LinearClientI, "fetchWorkflowStates">,
  w: LinearWatchConfig,
): Promise<{ trigger: string; inProgress: string; review: string; done: string; parked: string; parkedName: string; terminalNames: string[] }> {
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
  const terminalNames = states
    .filter((x) => x.type === "completed" || x.type === "canceled" || x.type === "cancelled")
    .map((x) => x.name);
  return {
    trigger: byName(w.triggerState),
    inProgress: byName("In Progress"),
    review: byName(w.reviewState),
    done: done.id,
    parked: parked.id,
    parkedName: parked.name,
    terminalNames,
  };
}

export function isBreakdownIssue(issue: LinearIssue, w: LinearWatchConfig): boolean {
  return issue.labels.some((l) => l.trim().toLowerCase() === w.breakdownLabel);
}

export async function startWatching(): Promise<Array<{ stop: () => void }>> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");
  const cfg = getLinearConfig();
  if (!cfg) throw new Error("No `linear` config in devlog.config.json");
  const db = getDb();
  const client = new LinearClient(key);

  // Scrub all LINEAR_* vars so spawned agent processes cannot see the token.
  // The LinearClient already holds `key` in its closure — harness calls still work.
  for (const k of Object.keys(process.env)) {
    if (k === "LINEAR_API_KEY" || k.startsWith("LINEAR_")) delete process.env[k];
  }

  const handles: Array<{ stop: () => void }> = [];

  for (const w of cfg.watch) {
    const stateIds = await resolveStateIds(client, w);
    const teamAndLabels = await client.fetchTeamAndLabels(w.projectSlugId);
    const repoRoot = getRepoRoot(w.devlogProjectId);
    const deps: TickDeps = {
      db,
      client,
      watch: w,
      stateIds,
      reconcile: async () => {
        await reconcileBreakdowns({ db, client, w, stateIds });
      },
      onDispatch: async (issue) => {
        if (isBreakdownIssue(issue, w)) {
          const result = await runBreakdown({ db, client, w, parent: issue, repoRoot, stateIds, teamAndLabels });
          if (!result.ok) {
            await client.createComment(issue.id, `**Breakdown failed:** ${result.error}. Fix \`.devlog/breakdown.json\` and re-label.`);
          }
          return;
        }
        const res = await dispatchIssue(db, issue, w, executeTask);
        // Always move to In Progress — the issue was claimed regardless of launch outcome.
        await client.updateState(issue.id, stateIds.inProgress);

        const row = db
          .prepare(
            "SELECT s.branch_name as branch, s.worktree_path as wp, s.local_cli_agent_id as engine FROM tasks t LEFT JOIN sessions s ON s.id = t.session_id WHERE t.linear_issue_id = ?",
          )
          .get(issue.id) as { branch?: string; wp?: string; engine?: string } | undefined;

        if (res.ok) {
          if (!row?.wp) {
            console.warn(
              "[linear dispatch] no session row for",
              issue.identifier,
              "— executeTask may have failed",
            );
          }
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
        } else {
          // Launch failed — create a blocked workpad comment so the Linear issue reflects the failure.
          const stamp = buildEnvStamp(hostname(), "?", "new");
          const commentId = await client.createComment(
            issue.id,
            assembleWorkpad({
              engine: (row?.engine as EngineId) ?? "claude",
              branch: row?.branch ?? "?",
              state: "In Progress — BLOCKED",
              stamp,
              agentBody: `**BLOCKED:** launch failed: ${res.error}`,
            }),
          );
          db.prepare("UPDATE tasks SET linear_workpad_comment_id = ? WHERE linear_issue_id = ?").run(
            commentId,
            issue.id,
          );
        }
      },
      finalize: async () => {
        // FIX 1: include 'idle' — process-manager marks local-CLI sessions 'idle' on exit.
        const rows = db
          .prepare(
            "SELECT t.linear_issue_id as iid, t.linear_workpad_comment_id as cid, s.status as st, s.branch_name as branch, s.worktree_path as wp, s.local_cli_agent_id as engine FROM tasks t JOIN sessions s ON s.id = t.session_id WHERE t.linear_issue_id IS NOT NULL AND t.linear_workpad_comment_id IS NOT NULL AND s.status IN ('idle','completed','failed','killed') AND t.linear_finalized_at IS NULL AND t.project_id = ?",
          )
          .all(w.devlogProjectId) as Array<{
          iid: string;
          cid: string;
          st: "idle" | "completed" | "failed" | "killed";
          branch: string;
          wp: string;
          engine: string;
        }>;
        for (const r of rows) {
          try {
            // FIX 2: fetch the issue's current Linear state before calling finalizeOutcome,
            // so the terminal-state guard can skip issues a human already closed.
            const currentState = (await client.fetchStateNameByIssue(r.iid)) ?? "";

            const result = await finalizeOutcome(
              r.st,
              {
                client,
                reviewStateId: stateIds.review,
                commentId: r.cid,
                issueId: r.iid,
                branch: r.branch,
                engine: (r.engine as EngineId) ?? "claude",
                stamp: buildEnvStamp(hostname(), r.wp, "done"),
                currentState,
                // FIX 7: use execFile (no shell) to avoid injection via branch name.
                detectPr: async () => {
                  try {
                    const { stdout } = await execFileAsync(
                      "gh",
                      ["pr", "list", "--head", r.branch, "--json", "url", "--jq", ".[0].url"],
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

            // Stamp finalized so this row is never processed again (even if DevLog's own
            // onSessionExit already moved task.status away from 'in_progress').
            // "skipped" means a human already closed the Linear issue — leave DevLog status
            // as-is, but still mark finalized so we stop polling it.
            if (result === "skipped") {
              db.prepare(
                "UPDATE tasks SET linear_finalized_at = datetime('now'), updated_at = datetime('now') WHERE linear_issue_id = ?",
              ).run(r.iid);
            } else {
              const boardStatus = result === "review" ? "review" : result === "blocked" ? "blocked" : "done";
              db.prepare(
                "UPDATE tasks SET status = ?, linear_finalized_at = datetime('now'), updated_at = datetime('now') WHERE linear_issue_id = ?",
              ).run(boardStatus, r.iid);
            }
          } catch (e) {
            console.error("[linear finalize] row failed", r.iid, e);
          }
        }
      },
    };
    handles.push(startPoller(deps, cfg.pollIntervalMs));
  }
  return handles;
}
