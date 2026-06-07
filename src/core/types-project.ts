export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
}

export interface DevlogConfig {
  projects: ProjectConfig[];
  activeProject: string;
  port: number;
  linear?: {
    watch: Array<{
      projectSlugId: string;
      devlogProjectId: string;
      triggerState?: string;
      reviewState?: string;
      terminalStates?: string[];
      defaultEngine?: "claude" | "codex";
      labelEngineMap?: Record<string, "claude" | "codex">;
    }>;
    pollIntervalMs?: number;
  };
}
