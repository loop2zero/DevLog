import type Database from "better-sqlite3";
import type { LinearClientI } from "./client";
import type { LinearWatchConfig } from "./types";
import type { ResolvedStateIds } from "./batch-create";

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
    const terminalStates = [...new Set([...stateIds.terminalNames, ...w.terminalStates])];
    const decision = computeReconcile(states, { terminalStates, parkedState: stateIds.parkedName });

    for (const idx of decision.advanceIndexes) {
      await client.updateState(subs[idx].cid, stateIds.trigger);
    }
    // Invariant: update Linear (parent → done) BEFORE the DB finalize stamp. If the
    // stamp write crashes, the next tick re-selects this parent and retries the close
    // (idempotent in Linear). The reverse order could orphan an open Linear parent.
    if (decision.closeParent) {
      await client.updateState(pid, stateIds.done);
      db.prepare(
        "UPDATE tasks SET linear_finalized_at = datetime('now'), status = 'done', updated_at = datetime('now') WHERE linear_issue_id = ?",
      ).run(pid);
    }
  }
}
