import type { LinearClientI } from "./client";
import type { EngineId, LinearWatchConfig } from "./types";
import { assembleWorkpad, isTerminal } from "./state-map";

export interface FinalizeCtx {
  client: Pick<LinearClientI, "updateState" | "updateComment">;
  reviewStateId: string;
  commentId: string;
  issueId: string;
  branch: string;
  engine: EngineId;
  stamp: string;
  cost?: string | null;
  /** Current Linear state name of the issue (fetched before calling). */
  currentState: string;
  detectPr: () => Promise<string>;
  readWorkpad: () => Promise<string>;
}

export type SessionOutcome = "idle" | "completed" | "failed" | "killed";

export type FinalizeResult = "review" | "blocked" | "skipped";

export async function finalizeOutcome(
  outcome: SessionOutcome,
  ctx: FinalizeCtx,
  w: LinearWatchConfig,
): Promise<FinalizeResult> {
  // Terminal-state guard: if a human already closed the issue, do nothing.
  if (isTerminal(ctx.currentState, w)) {
    return "skipped";
  }

  const agentBody = await safe(ctx.readWorkpad);

  // PR is the source of truth regardless of session outcome: a session that ended
  // 'failed' or 'killed' may still have opened a PR (ARC-94 scenario).
  const pr = await safe(ctx.detectPr);
  if (pr) {
    await ctx.client.updateComment(
      ctx.commentId,
      assembleWorkpad({
        engine: ctx.engine,
        branch: ctx.branch,
        state: "In Review",
        stamp: ctx.stamp,
        pr,
        cost: ctx.cost,
        agentBody,
      }),
    );
    await ctx.client.updateState(ctx.issueId, ctx.reviewStateId);
    return "review";
  }

  const reason =
    outcome === "idle" || outcome === "completed"
      ? "session ended but no PR was opened"
      : `agent ${outcome}, no PR opened`;
  await ctx.client.updateComment(
    ctx.commentId,
    assembleWorkpad({
      engine: ctx.engine,
      branch: ctx.branch,
      state: "In Progress — BLOCKED",
      stamp: ctx.stamp,
      cost: ctx.cost,
      agentBody: `**BLOCKED:** ${reason}. Left for a human.\n\n${agentBody ?? ""}`,
    }),
  );
  return "blocked";
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
