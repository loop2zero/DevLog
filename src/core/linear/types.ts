export type EngineId = "claude" | "codex";

export interface LinearWatchConfig {
  projectSlugId: string;
  devlogProjectId: string;
  triggerState: string;
  reviewState: string;
  terminalStates: string[];
  defaultEngine: EngineId;
  labelEngineMap: Record<string, EngineId>;
}

export interface LinearConfig {
  watch: LinearWatchConfig[];
  pollIntervalMs: number;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  stateName: string;
  labels: string[];
}

export function normalizeWatchConfig(
  raw: Partial<LinearWatchConfig> & { projectSlugId: string; devlogProjectId: string }
): LinearWatchConfig {
  return {
    projectSlugId: raw.projectSlugId,
    devlogProjectId: raw.devlogProjectId,
    triggerState: raw.triggerState ?? "Todo",
    reviewState: raw.reviewState ?? "In Review",
    terminalStates: raw.terminalStates ?? ["Done", "Canceled", "Cancelled", "Duplicate"],
    defaultEngine: raw.defaultEngine ?? "claude",
    labelEngineMap: Object.fromEntries(
      Object.entries(raw.labelEngineMap ?? { claude: "claude", codex: "codex" }).map(
        ([k, v]) => [k.trim().toLowerCase(), v],
      ),
    ) as Record<string, EngineId>,
  };
}
