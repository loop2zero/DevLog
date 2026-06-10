import type Database from "better-sqlite3";
import type { GateStatus } from "../types-dashboard";

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
