import type { LinearClientI } from "./client";
import type { EngineId, LinearWatchConfig } from "./types";
import { assembleWorkpad } from "./state-map";

export interface FinalizeCtx {
  client: Pick<LinearClientI, "updateState" | "updateComment">;
  reviewStateId: string;
  commentId: string;
  issueId: string;
  branch: string;
  engine: EngineId;
  stamp: string;
  cost?: string | null;
  detectPr: () => Promise<string>;
  readWorkpad: () => Promise<string>;
}

export type SessionOutcome = "completed" | "failed" | "killed";

export async function finalizeOutcome(outcome: SessionOutcome, ctx: FinalizeCtx, _w: LinearWatchConfig): Promise<void> {
  const agentBody = await safe(ctx.readWorkpad);
  if (outcome === "completed") {
    const pr = await safe(ctx.detectPr);
    if (pr) {
      await ctx.client.updateComment(
        ctx.commentId,
        assembleWorkpad({ engine: ctx.engine, branch: ctx.branch, state: "In Review", stamp: ctx.stamp, pr, cost: ctx.cost, agentBody }),
      );
      await ctx.client.updateState(ctx.issueId, ctx.reviewStateId);
      return;
    }
  }
  const reason = outcome === "completed" ? "session ended but no PR was opened" : `agent ${outcome}`;
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
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
