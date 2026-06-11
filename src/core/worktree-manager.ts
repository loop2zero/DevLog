import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import type { Worktree } from "./types-dashboard";
import { getRepoRoot } from "./project-adapter";

const execFileAsync = promisify(execFile);

async function git(projectId: string | undefined, ...args: string[]): Promise<string> {
  const repoRoot = getRepoRoot(projectId);
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot });
  return stdout;
}

export async function listWorktrees(projectId?: string): Promise<Worktree[]> {
  const raw = await git(projectId, "worktree", "list", "--porcelain");
  const entries: Worktree[] = [];
  let current: Partial<Worktree> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice(9).trim();
      current.name = path.basename(current.path);
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).trim().replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = "(detached)";
    } else if (line === "") {
      if (current.path) {
        entries.push({
          name: current.name!,
          path: current.path,
          branch: current.branch ?? "unknown",
          head: current.head ?? "",
          isMain: entries.length === 0,
        });
      }
      current = {};
    }
  }

  return entries;
}

/**
 * Fetches origin/<baseBranch> so new worktrees start from the remote tip
 * instead of a stale local branch (chained subtasks otherwise conflict on
 * every link). Returns "origin/<baseBranch>" on success; falls back to the
 * local branch when the fetch fails (offline / no remote) so dispatch is
 * never blocked.
 */
export async function resolveWorktreeBase(
  repoRoot: string,
  baseBranch: string
): Promise<string> {
  try {
    await execFileAsync("git", ["fetch", "origin", baseBranch], { cwd: repoRoot });
    await execFileAsync("git", ["rev-parse", "--verify", `origin/${baseBranch}`], {
      cwd: repoRoot,
    });
    return `origin/${baseBranch}`;
  } catch (err) {
    console.warn(
      `[worktree] fetch origin/${baseBranch} failed; falling back to local '${baseBranch}': ${(err as Error).message}`
    );
    return baseBranch;
  }
}

export async function createWorktreeAt(
  repoRoot: string,
  name: string,
  branch: string,
  baseBranch?: string
): Promise<string> {
  const worktreePath = path.join(repoRoot, ".worktrees", name);

  if (baseBranch) {
    const base = await resolveWorktreeBase(repoRoot, baseBranch);
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branch, worktreePath, base],
      { cwd: repoRoot }
    );
  } else {
    await execFileAsync("git", ["worktree", "add", "-b", branch, worktreePath], {
      cwd: repoRoot,
    });
  }

  return worktreePath;
}

export async function createWorktree(
  name: string,
  branch: string,
  baseBranch?: string,
  projectId?: string
): Promise<Worktree> {
  const repoRoot = getRepoRoot(projectId);
  const worktreePath = await createWorktreeAt(repoRoot, name, branch, baseBranch);

  const worktrees = await listWorktrees(projectId);
  const created = worktrees.find((w) => w.path === worktreePath);
  if (!created) throw new Error("Worktree created but not found in list");
  return created;
}

export async function removeWorktree(name: string, projectId?: string): Promise<void> {
  const worktrees = await listWorktrees(projectId);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) throw new Error(`Worktree '${name}' not found`);
  if (wt.isMain) throw new Error("Cannot remove main worktree");

  await git(projectId, "worktree", "remove", wt.path, "--force");
}

export async function getWorktreeDiff(name: string, projectId?: string): Promise<string> {
  const worktrees = await listWorktrees(projectId);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) throw new Error(`Worktree '${name}' not found`);

  const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
    cwd: wt.path,
  });
  return stdout;
}

export async function getWorktreeLog(name: string, projectId?: string): Promise<string> {
  const worktrees = await listWorktrees(projectId);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) throw new Error(`Worktree '${name}' not found`);

  const { stdout } = await execFileAsync(
    "git",
    ["log", "--oneline", "-10"],
    { cwd: wt.path }
  );
  return stdout;
}

export async function getWorktreeFilesChanged(name: string, projectId?: string): Promise<number> {
  const worktrees = await listWorktrees(projectId);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) return 0;

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only"],
      { cwd: wt.path }
    );
    return stdout.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Get the full diff of a worktree's branch against a base branch.
 */
export async function getWorktreeBranchDiff(
  name: string,
  baseBranch: string,
  projectId?: string
): Promise<{ stat: string; diff: string }> {
  const worktrees = await listWorktrees(projectId);
  const wt = worktrees.find((w) => w.name === name);
  if (!wt) throw new Error(`Worktree '${name}' not found`);

  const [statResult, diffResult] = await Promise.all([
    execFileAsync("git", ["diff", `${baseBranch}...HEAD`, "--stat"], {
      cwd: wt.path,
      maxBuffer: 5 * 1024 * 1024,
    }),
    execFileAsync("git", ["diff", `${baseBranch}...HEAD`], {
      cwd: wt.path,
      maxBuffer: 10 * 1024 * 1024,
    }),
  ]);

  return { stat: statResult.stdout, diff: diffResult.stdout };
}
