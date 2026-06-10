import type Database from "better-sqlite3";
import { readFile } from "fs/promises";
import { hostname } from "os";
import type { GateStatus } from "../types-dashboard";
import type { LinearClientI } from "./client";
import type { EngineId, LinearWatchConfig } from "./types";
import { assembleWorkpad } from "./state-map";
import { parseGateStatus } from "../control-plane-state";

export function normalizeGateReply(body: string, options: string[]): string {
  const trimmed = body.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10);
    if (idx >= 1 && idx <= options.length) return options[idx - 1];
  }
  const hit = options.find((o) => o.trim().toLowerCase() === trimmed.toLowerCase());
  return hit ?? trimmed;
}

export function buildGateCommentBody(gate: GateStatus): string {
  const lines = [
    `## ⚠️ GATE — needs your confirmation \`[${gate.id}]\``,
    "",
    ...(gate.stage ? [`stage: ${gate.stage}`, ""] : []),
    `**Q: ${gate.question}**`,
  ];
  if (gate.options.length > 0) {
    lines.push("", ...gate.options.map((o, i) => `${i + 1}. ${o}`));
  }
  lines.push("", "_Reply to this issue with an option number or free text — the watch relays it to the agent._");
  return lines.join("\n");
}

export function buildGateReceiptBody(gateId: string, response: string, via: "linear" | "elsewhere"): string {
  if (via === "elsewhere") {
    return `## ✅ GATE resolved elsewhere \`[${gateId}]\`\n\nThe gate was answered outside Linear (e.g. DevLog UI); nothing to do here.`;
  }
  return `## ✅ GATE resolved \`[${gateId}]\`\n\nReply delivered to the agent:\n\n> ${response}`;
}

export function registerRelayComment(db: Database.Database, commentId: string, issueId: string, kind: string): void {
  db.prepare("INSERT OR IGNORE INTO linear_relay_comments (comment_id, issue_id, kind) VALUES (?, ?, ?)").run(commentId, issueId, kind);
}

export function isRelayComment(db: Database.Database, commentId: string): boolean {
  return !!db.prepare("SELECT 1 FROM linear_relay_comments WHERE comment_id = ?").get(commentId);
}

export interface RelayDeps {
  db: Database.Database;
  client: Pick<LinearClientI, "createComment" | "updateComment" | "fetchComments">;
  w: LinearWatchConfig;
  resolveGate: (sessionId: string, response: string) => { ok: true } | { ok: false; error: string };
  /** Injectable for tests; defaults to reading <worktree>/.devlog/workpad.md */
  readWorkpadFile?: (worktreePath: string) => Promise<string>;
}

interface RelayRow {
  tid: string;
  sid: string;
  iid: string;
  cid: string | null;
  stage: string | null;
  relayed: string | null;
  gate: string | null;
  gateCommentId: string | null;
  relayedGateId: string | null;
  branch: string | null;
  wp: string | null;
  engine: string | null;
}

const Q_ROWS = `
  SELECT t.id AS tid, t.session_id AS sid, t.linear_issue_id AS iid, t.linear_workpad_comment_id AS cid,
         t.current_stage AS stage, t.linear_relayed_stage AS relayed, t.gate_status AS gate,
         t.linear_gate_comment_id AS gateCommentId, t.linear_gate_id AS relayedGateId,
         s.branch_name AS branch, s.worktree_path AS wp, s.local_cli_agent_id AS engine
  FROM tasks t JOIN sessions s ON s.id = t.session_id
  WHERE t.project_id = ? AND t.linear_issue_id IS NOT NULL AND t.linear_finalized_at IS NULL`;

function relayRows(db: Database.Database, w: LinearWatchConfig): RelayRow[] {
  return db.prepare(Q_ROWS).all(w.devlogProjectId) as RelayRow[];
}

async function renderWorkpad(deps: RelayDeps, row: RelayRow): Promise<string> {
  const read = deps.readWorkpadFile ?? ((wp: string) => readFile(`${wp}/.devlog/workpad.md`, "utf-8"));
  let agentBody: string | null = null;
  try {
    agentBody = row.wp ? await read(row.wp) : null;
  } catch {
    agentBody = null;
  }
  const state = row.gate ? "In Progress — AWAITING INPUT" : "In Progress";
  return assembleWorkpad({
    engine: (row.engine as EngineId) ?? "claude",
    branch: row.branch ?? "?",
    state,
    stage: row.stage,
    stamp: `${hostname()}:${row.wp ?? "?"}@run`,
    agentBody,
  });
}

export async function relayStages(deps: RelayDeps): Promise<void> {
  const rows = relayRows(deps.db, deps.w).filter(
    (r) => r.cid && r.stage != null && r.stage !== r.relayed,
  );
  for (const row of rows) {
    try {
      await deps.client.updateComment(row.cid!, await renderWorkpad(deps, row));
      deps.db.prepare("UPDATE tasks SET linear_relayed_stage = ?, updated_at = datetime('now') WHERE id = ?").run(row.stage, row.tid);
    } catch (e) {
      console.error("[linear relay] stage row failed", row.iid, e);
    }
  }
}

export async function relayGates(deps: RelayDeps): Promise<void> {
  const rows = relayRows(deps.db, deps.w).filter((r) => r.gate != null);
  for (const row of rows) {
    const gate = parseGateStatus(row.gate);
    if (!gate || gate.id === row.relayedGateId) continue;
    try {
      const commentId = await deps.client.createComment(row.iid, buildGateCommentBody(gate));
      registerRelayComment(deps.db, commentId, row.iid, "gate");
      deps.db.prepare(
        "UPDATE tasks SET linear_gate_comment_id = ?, linear_gate_id = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(commentId, gate.id, row.tid);
      if (row.cid) {
        try {
          await deps.client.updateComment(row.cid, await renderWorkpad(deps, row));
        } catch {
          /* workpad refresh is best-effort */
        }
      }
    } catch (e) {
      console.error("[linear relay] gate row failed", row.iid, e);
    }
  }
}

async function settleGate(
  deps: RelayDeps,
  row: RelayRow,
  receipt: string,
): Promise<void> {
  const receiptId = await deps.client.createComment(row.iid, receipt);
  registerRelayComment(deps.db, receiptId, row.iid, "receipt");
  deps.db.prepare(
    "UPDATE tasks SET linear_gate_comment_id = NULL, updated_at = datetime('now') WHERE id = ?",
  ).run(row.tid);
  if (row.cid) {
    try {
      const fresh = relayRows(deps.db, deps.w).find((r) => r.tid === row.tid);
      if (fresh) await deps.client.updateComment(row.cid, await renderWorkpad(deps, fresh));
    } catch {
      /* best-effort */
    }
  }
}

export async function pollGateReplies(deps: RelayDeps): Promise<void> {
  const rows = relayRows(deps.db, deps.w).filter((r) => r.gateCommentId != null);
  for (const row of rows) {
    try {
      if (row.gate == null) {
        // Resolved on another surface (e.g. DevLog web UI) — close the Linear loop.
        await settleGate(deps, row, buildGateReceiptBody(row.relayedGateId ?? "?", "", "elsewhere"));
        continue;
      }
      const gate = parseGateStatus(row.gate);
      if (!gate) continue;

      const comments = await deps.client.fetchComments(row.iid);
      const gateComment = comments.find((c) => c.id === row.gateCommentId);
      if (!gateComment) continue;
      const reply = comments.find(
        (c) => c.createdAt > gateComment.createdAt && !isRelayComment(deps.db, c.id) && c.body.trim() !== "",
      );
      if (!reply) continue;

      const response = normalizeGateReply(reply.body, gate.options);
      const result = deps.resolveGate(row.sid, response);
      if (result.ok) {
        await settleGate(deps, row, buildGateReceiptBody(gate.id, response, "linear"));
      } else {
        await settleGate(deps, row, buildGateReceiptBody(gate.id, "", "elsewhere"));
      }
    } catch (e) {
      console.error("[linear relay] reply row failed", row.iid, e);
    }
  }
}

export async function relayControlPlane(deps: RelayDeps): Promise<void> {
  await relayStages(deps);
  await relayGates(deps);
  await pollGateReplies(deps);
}
