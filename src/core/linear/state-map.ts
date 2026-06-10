import type { EngineId, LinearWatchConfig } from "./types";

export function resolveEngine(labels: string[], w: LinearWatchConfig): EngineId {
  const matched = labels
    .map((l) => w.labelEngineMap[l.trim().toLowerCase()])
    .filter((e): e is EngineId => e === "claude" || e === "codex");
  const unique = [...new Set(matched)];
  if (unique.length === 1) return unique[0];
  return w.defaultEngine; // 0 matches or conflicting -> default
}

export function isTerminal(stateName: string, w: LinearWatchConfig): boolean {
  return w.terminalStates.some((s) => s.toLowerCase() === stateName.trim().toLowerCase());
}

export interface WorkpadParts {
  engine: EngineId;
  branch: string;
  state: string;
  stamp: string;
  stage?: string | null;
  pr?: string | null;
  cost?: string | null;
  agentBody?: string | null;
}

export function assembleWorkpad(p: WorkpadParts): string {
  const header = [
    `## DevLog Workpad`,
    "",
    `\`${p.stamp}\``,
    "",
    `- state: ${p.state}`,
    ...(p.stage ? [`- stage: ${p.stage}`] : []),
    `- engine: ${p.engine}`,
    `- branch: ${p.branch}`,
    ...(p.pr ? [`- PR: ${p.pr}`] : []),
    ...(p.cost ? [`- cost: ${p.cost}`] : []),
  ].join("\n");
  const body = p.agentBody?.trim()
    ? `\n\n---\n\n${p.agentBody.trim()}`
    : `\n\n---\n\n_(agent narrative pending — written to .devlog/workpad.md)_`;
  return header + body;
}
