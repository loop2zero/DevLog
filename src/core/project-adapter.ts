import fs from "fs";
import path from "path";
import type { DevlogConfig, ProjectConfig } from "./types-project";
import { normalizeWatchConfig, type LinearConfig } from "./linear/types";

const CONFIG_PATH = path.join(process.cwd(), "devlog.config.json");

let _config: DevlogConfig | null = null;

function loadConfig(): DevlogConfig {
  if (_config) return _config;
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  _config = JSON.parse(raw) as DevlogConfig;
  return _config;
}

export function listProjects(): ProjectConfig[] {
  return loadConfig().projects;
}

export function getProject(id: string): ProjectConfig {
  const project = loadConfig().projects.find((p) => p.id === id);
  if (!project) throw new Error(`Project '${id}' not found in devlog.config.json`);
  return project;
}

export function getActiveProject(): ProjectConfig {
  const config = loadConfig();
  return getProject(config.activeProject);
}

export function getRepoRoot(projectId?: string): string {
  const project = projectId ? getProject(projectId) : getActiveProject();
  return project.path;
}

export function setActiveProject(id: string): void {
  const config = loadConfig();
  getProject(id);
  config.activeProject = id;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  _config = config;
}

export function getLinearConfig(): LinearConfig | null {
  const cfg = loadConfig();
  if (!cfg.linear) return null;
  return {
    watch: cfg.linear.watch.map(normalizeWatchConfig),
    pollIntervalMs: cfg.linear.pollIntervalMs ?? 10000,
  };
}
