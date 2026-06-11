import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktreeAt, resolveWorktreeBase } from "../worktree-manager";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "test@devlog.local");
  git(dir, "config", "user.name", "DevLog Test");
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content);
  git(dir, "add", name);
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

/**
 * Builds: a bare "remote", a "local" clone whose origin/main is BEHIND the
 * remote (a second clone pushed a newer commit). Mirrors the dispatcher
 * scenario where chained subtasks merge remotely while the local default
 * branch never advances.
 */
function makeStaleLocalRepo(root: string): { local: string; remoteTip: string } {
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { encoding: "utf8" });

  const local = join(root, "local");
  execFileSync("git", ["clone", remote, local], { encoding: "utf8" });
  git(local, "config", "user.email", "test@devlog.local");
  git(local, "config", "user.name", "DevLog Test");
  commitFile(local, "a.txt", "a", "commit A");
  git(local, "push", "origin", "main");

  const writer = join(root, "writer");
  execFileSync("git", ["clone", remote, writer], { encoding: "utf8" });
  git(writer, "config", "user.email", "test@devlog.local");
  git(writer, "config", "user.name", "DevLog Test");
  const remoteTip = commitFile(writer, "b.txt", "b", "commit B (remote ahead)");
  git(writer, "push", "origin", "main");

  return { local, remoteTip };
}

test("resolveWorktreeBase fetches and returns origin/<branch> when a remote exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "devlog-worktree-fetch-"));
  try {
    const { local, remoteTip } = makeStaleLocalRepo(root);

    const base = await resolveWorktreeBase(local, "main");

    assert.equal(base, "origin/main");
    // The fetch must have advanced origin/main to the remote tip.
    assert.equal(git(local, "rev-parse", "origin/main"), remoteTip);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveWorktreeBase falls back to the local branch when fetch fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "devlog-worktree-nofetch-"));
  try {
    const local = join(root, "local");
    execFileSync("mkdir", ["-p", local]);
    initRepo(local);
    commitFile(local, "a.txt", "a", "commit A");
    // No remote configured at all — fetch must fail, dispatch must not block.
    const base = await resolveWorktreeBase(local, "main");
    assert.equal(base, "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createWorktreeAt bases the new branch on origin/<defaultBranch>, not the stale local branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "devlog-worktree-create-"));
  try {
    const { local, remoteTip } = makeStaleLocalRepo(root);
    const localTip = git(local, "rev-parse", "main");
    assert.notEqual(localTip, remoteTip, "precondition: local main must be stale");

    const worktreePath = await createWorktreeAt(local, "wt-fresh", "task/fresh", "main");

    assert.equal(git(worktreePath, "rev-parse", "HEAD"), remoteTip);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createWorktreeAt still creates the worktree from the local base when fetch fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "devlog-worktree-degraded-"));
  try {
    const local = join(root, "local");
    execFileSync("mkdir", ["-p", local]);
    initRepo(local);
    const localTip = commitFile(local, "a.txt", "a", "commit A");

    const worktreePath = await createWorktreeAt(local, "wt-degraded", "task/degraded", "main");

    assert.equal(git(worktreePath, "rev-parse", "HEAD"), localTip);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
