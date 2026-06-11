# Workpad — ARC-108: dispatcher 开 worktree 前先 fetch 远端默认分支

## 问题

`createWorktree`(`src/core/worktree-manager.ts`)基于**本地** defaultBranch 切新分支,从不 `git fetch`。
链式子任务每合并一环,远端 main 前进一次,下一环的 worktree 必然基于陈旧基底 → PR 必冲突
(实测:ARC-104 PR #10 workpad add/add 冲突;ARC-105 PR #11 三文件冲突)。

## 方案

最小改动,全部收在 `worktree-manager.ts`,公共 API(`createWorktree` 签名)不变:

1. `resolveWorktreeBase(repoRoot, baseBranch)` — `git fetch origin <baseBranch>` +
   `rev-parse --verify origin/<baseBranch>`,成功返回 `origin/<baseBranch>`;任一步失败
   (离线 / 无 remote)打 `console.warn` 降级返回本地 `baseBranch`,不阻塞派发。
2. `createWorktreeAt(repoRoot, name, branch, baseBranch?)` — repo-root 级的 worktree 创建,
   有 baseBranch 时先过 `resolveWorktreeBase`。抽出这层是为了单测不依赖
   `devlog.config.json`(`getRepoRoot` 走 cwd 配置,测试无法注入)。
3. `createWorktree` 保持原签名,委托给 `createWorktreeAt(getRepoRoot(projectId), …)`。
   `task-execution.ts` 零改动。

## TDD 过程

- 先写 `src/core/__tests__/worktree-manager.test.ts`(node:test + tsx,跟随既有风格),
  4 个用例,跑出 import 失败(函数不存在)→ 红。
- 测试夹具:bare remote + 两个 clone,writer clone 推进远端,local clone 保持陈旧,
  复现"本地基底落后远端"的派发场景。
- 实现后 4/4 绿。

## 验证证据

- 有远端:`createWorktreeAt` 产出的 worktree `HEAD` == 远端 tip(≠ 陈旧本地 tip,前置断言保证)✅
- 无远端:fetch 失败仍创建 worktree,基底为本地 tip(降级 + warn 日志)✅
- `bun run typecheck` ✅;`TZ=Asia/Shanghai bun run test` → 350 pass / 0 fail ✅
