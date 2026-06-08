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
  terminalNames: string[];
}

export interface RunBreakdownDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "fetchChildIssues" | "createIssue" | "createRelation" | "updateIssueBody" | "updateState">;
  w: LinearWatchConfig;
  parent: LinearIssue;
  repoRoot: string;
  stateIds: ResolvedStateIds;
  teamAndLabels: { teamId: string; projectId: string; labels: Record<string, string> };
}

export type RunBreakdownResult = { ok: true; created: number } | { ok: false; error: string };

export async function runBreakdown(deps: RunBreakdownDeps): Promise<RunBreakdownResult> {
  const { db, client, parent, repoRoot, stateIds, teamAndLabels } = deps;

  // Self-idempotent: if this parent was already fully batch-created (stamp present),
  // do nothing. The stamp is written just before the parent state-move (see ordering
  // invariant below), so a crash before the stamp leaves the parent in trigger state and
  // the next call re-enters and skip-by-title recovers; a completed run is a no-op here.
  // This makes runBreakdown safe regardless of the caller's own guarding.
  const alreadyDone = db
    .prepare("SELECT 1 FROM tasks WHERE linear_issue_id = ? AND linear_breakdown_done_at IS NOT NULL")
    .get(parent.id);
  if (alreadyDone) return { ok: true, created: 0 };

  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".devlog", "breakdown.json"), "utf-8");
  } catch {
    return { ok: false, error: "breakdown.json not found in repo .devlog/" };
  }
  const parsed = parseBreakdown(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const plan = parsed.plan;
  if (plan.parentIdentifier && plan.parentIdentifier !== parent.identifier) {
    return { ok: false, error: `breakdown.json targets ${plan.parentIdentifier}, but this issue is ${parent.identifier} — stale or mismatched file` };
  }

  const existing = await client.fetchChildIssues(parent.id);
  const byTitle = new Map(existing.map((c) => [c.title.trim().toLowerCase(), c]));

  const childIds: string[] = [];
  let createdCount = 0;
  for (let i = 0; i < plan.subIssues.length; i++) {
    const sub = plan.subIssues[i];
    const key = sub.title.trim().toLowerCase();
    const reuse = byTitle.get(key);
    let childId: string;
    let childIdentifier: string;
    if (reuse) {
      childId = reuse.id;
      childIdentifier = reuse.identifier;
    } else {
      const labelIds = sub.labels
        .filter((l) => l.trim().toLowerCase() !== deps.w.breakdownLabel)
        .map((l) => {
          const id = teamAndLabels.labels[l.trim().toLowerCase()];
          if (!id) console.warn(`[breakdown] sub "${sub.title}": label "${l}" not found in team — dropped (engine routing may fall back to default)`);
          return id;
        })
        .filter((x): x is string => typeof x === "string");
      const out = await client.createIssue({
        teamId: teamAndLabels.teamId,
        title: sub.title,
        description: sub.description,
        parentId: parent.id,
        labelIds,
        stateId: i === 0 ? stateIds.trigger : stateIds.parked,
        projectId: teamAndLabels.projectId,
      });
      childId = out.id;
      childIdentifier = out.identifier;
      createdCount++;
    }
    childIds.push(childId);
    const has = db
      .prepare("SELECT 1 FROM linear_breakdown_subs WHERE parent_issue_id = ? AND position = ?")
      .get(parent.id, i);
    if (!has) {
      db.prepare(
        "INSERT INTO linear_breakdown_subs (parent_issue_id, child_issue_id, child_identifier, position) VALUES (?, ?, ?, ?)",
      ).run(parent.id, childId, childIdentifier, i);
    }
  }

  for (let i = 1; i < childIds.length; i++) {
    try {
      await client.createRelation(childIds[i - 1], childIds[i], "blocks");
    } catch {
      /* relation may already exist on a resumed run */
    }
  }

  await client.updateIssueBody(parent.id, plan.parentSummary);

  // Crash-safety ordering invariant: stamp the parent tasks row BEFORE moving the
  // parent out of trigger state. If we crash before the stamp, the parent is still in
  // trigger state and runBreakdown re-runs (skip-by-title recovers). If we crash after
  // the stamp but before the state move, reconcileBreakdowns selects the parent (stamp
  // present) and drives the chain forward. Never move state first: a parent that left
  // trigger state without a stamp is invisible to both paths → orphaned forever.
  const taskId = randomBytes(8).toString("hex");
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, linear_issue_id, linear_identifier, linear_breakdown_done_at, created_at, updated_at)
     VALUES (?, ?, ?, 'in_progress', ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
  ).run(taskId, deps.w.devlogProjectId, parent.title, parent.id, parent.identifier);

  await client.updateState(parent.id, stateIds.inProgress);

  return { ok: true, created: createdCount };
}
