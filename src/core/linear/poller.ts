import type Database from "better-sqlite3";
import type { LinearClientI } from "./client";
import type { LinearIssue, LinearWatchConfig } from "./types";
import { alreadyLinked } from "./dispatcher";

export interface TickDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "fetchTriggerIssues">;
  watch: LinearWatchConfig;
  onDispatch: (issue: LinearIssue) => Promise<void>;
  finalize: () => Promise<void>;
  stateIds: { inProgress: string; review: string };
}

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
