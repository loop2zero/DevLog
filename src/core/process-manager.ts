import { spawn, execFileSync, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as readline from "readline";
import fs from "fs";
import { getDb } from "./db";
import {
  createSystemLogEvent,
  streamManager,
  type SystemLogLevel,
  type ToolCall,
} from "./stream-manager";
import {
  applyControlPlaneEvent,
  parseControlPlaneProtocolText,
  resolveControlPlaneGate,
  type ControlPlaneProtocolEvent,
  type ResolvedControlPlaneGate,
} from "./control-plane-protocol";
import {
  markSessionFailedAndReleaseLinkedTask,
  onSessionExit,
} from "./task-lifecycle";
import {
  buildClaudeProcessEnv,
  DEFAULT_AGENT_MODEL,
  resolveSessionRuntimeAuthConfig,
  resolveStoredSessionRuntimeAuthConfig,
  type SessionRuntimeAuthConfig,
  type SessionRuntimeAuthInput,
} from "./session-runtime-auth";
import { validateProviderRuntimeConfig } from "./api-provider-runtime";
import { runProviderSessionTurn } from "./api-session-runtime";
import {
  DEFAULT_LOCAL_CLI_REASONING,
  LOCAL_CLI_AGENT_DEFINITIONS,
} from "./local-cli-agent-definitions";
import { resolveExecutableOnPath } from "./local-cli-agents";

export function parseClaudeBinaryPath(output: string): string | null {
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("/")) continue;
    if (fs.existsSync(line)) return line;
  }
  return null;
}

function resolveClaudeBinaryPath(): string {
  const candidates: string[] = [];
  try {
    const shell = process.env.SHELL ?? "/bin/zsh";
    const resolved = execFileSync(shell, ["-ilc", "whence -p claude"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const parsed = parseClaudeBinaryPath(resolved);
    if (parsed) candidates.push(parsed);
  } catch {
    // keep fallback candidates
  }

  candidates.push(
    ...(process.env.HOME ? [`${process.env.HOME}/.local/bin/claude`] : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  );

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "claude";
}

// Resolve claude binary path once at module load
let claudeBin = "claude";
claudeBin = resolveClaudeBinaryPath();

// Resolve full user PATH once
let userPath = process.env.PATH ?? "";
try {
  const shell = process.env.SHELL ?? "/bin/zsh";
  userPath = execFileSync(shell, ["-ilc", "echo $PATH"], {
    encoding: "utf-8",
    timeout: 5000,
  }).trim();
} catch {
  // keep default
}

// Read-only tools — auto-approved, no permission prompt needed
const ALLOWED_TOOLS = [
  "Read", "Glob", "Grep",
  "WebSearch", "WebFetch",
];
// Mutating tools (Bash, Write, Edit, NotebookEdit) are NOT pre-authorized.
// When Claude attempts to use them, a permission_request event is emitted
// and the user must approve or deny via the UI.

interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface QueuedMessage {
  message: string;
  runtimeAuthInput?: SessionRuntimeAuthInput;
}

interface StoredSessionRuntimeRow {
  worktree_path: string;
  claude_session_id: string | null;
  session_auth_mode: string | null;
  agent_api_key_env_var: string | null;
  local_cli_agent_id: string | null;
  agent_model: string | null;
  agent_reasoning: string | null;
  agent_api_protocol: string | null;
  agent_api_version: string | null;
  agent_base_url: string | null;
  agent_max_tokens: number | null;
}

type ProcessInputProtocol = "claude-stream-json" | "plain-stdin";
type ProcessOutputProtocol =
  | "claude-stream-json"
  | "json-event-stream"
  | "plain";
type JsonEventParser =
  | "codex"
  | "gemini"
  | "opencode"
  | "cursor-agent"
  | "copilot";

interface LocalCliProcessLaunch {
  ok: true;
  command: string;
  args: string[];
  inputProtocol: ProcessInputProtocol;
  outputProtocol: ProcessOutputProtocol;
  eventParser?: JsonEventParser;
  agentId: string;
  agentName: string;
}

interface GenericStreamState {
  buffer: string;
  codexToolUses: Set<string>;
  openCodeToolUses: Set<string>;
  copilotToolNames: Map<string, string>;
  cursorTextSoFar: string;
}

interface SessionProcess {
  proc: ChildProcess;
  sessionId: string;
  inputProtocol: ProcessInputProtocol;
  outputProtocol: ProcessOutputProtocol;
  eventParser?: JsonEventParser;
  genericStreamState: GenericStreamState;
  isProcessing: boolean;
  paused: boolean;
  lastActivityAt: number;
  textBuffer: string;
  toolCalls: ToolCall[];
  claudeSessionId: string | null;
  pendingPermission: PendingPermission | null;
}

export const WATCHDOG_INTERVAL_MS = 30000;
export const SESSION_UNRESPONSIVE_MS = 3 * 60 * 1000;

export function shouldRestartUnresponsiveSession({
  lastActivityAt,
  now,
  killed,
  paused = false,
}: {
  lastActivityAt: number;
  now: number;
  killed: boolean;
  paused?: boolean;
}): boolean {
  return now - lastActivityAt > SESSION_UNRESPONSIVE_MS && !killed && !paused;
}

export function needsBrowserApiKeyForWatchdogRestart(
  sessionAuthMode: string | null | undefined,
  isProcessing: boolean,
): boolean {
  return isProcessing && sessionAuthMode === "anthropic-api-key";
}

export function buildClaudeProcessArgs(
  runtimeAuthConfig: SessionRuntimeAuthConfig,
  claudeSessionId: string | null,
  allowedTools: string[],
): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
  ];

  if (runtimeAuthConfig.unattended) {
    args.push("--dangerously-skip-permissions");
  }

  if (runtimeAuthConfig.model !== DEFAULT_AGENT_MODEL) {
    args.push("--model", runtimeAuthConfig.model);
  }

  if (runtimeAuthConfig.mode === "local-cli") {
    args.push("--effort", runtimeAuthConfig.reasoning);
  }

  if (runtimeAuthConfig.mode === "anthropic-api-key") {
    args.push("--bare");
  }

  if (claudeSessionId) {
    args.push("--resume", claudeSessionId);
  }

  args.push("--allowedTools", ...allowedTools);

  return args;
}

export type ResolveLocalCliBinary = (agentId: string, bin: string) => string | null;

type LocalCliBinaryResolution =
  | { ok: true; command: string | null }
  | { ok: false; error: string };

export function buildLocalCliProcessLaunch(
  runtimeAuthConfig: SessionRuntimeAuthConfig,
  claudeSessionId: string | null,
  allowedTools: string[],
  cwd: string,
  resolveBin: ResolveLocalCliBinary = resolveLocalCliBinaryPath,
):
  | LocalCliProcessLaunch
  | { ok: false; error: string } {
  if (
    runtimeAuthConfig.mode === "anthropic-api-key" &&
    !runtimeAuthConfig.usesLegacyEnvVar
  ) {
    return {
      ok: false,
      error:
        "API provider mode uses DevLog's direct provider runtime and cannot launch a Local CLI process.",
    };
  }

  if (
    runtimeAuthConfig.usesLegacyEnvVar ||
    runtimeAuthConfig.localCliAgentId === "claude"
  ) {
    const agent = LOCAL_CLI_AGENT_DEFINITIONS.find(
      (candidate) => candidate.id === "claude",
    );
    const resolved = resolveConfiguredLocalCliBinary(
      agent,
      runtimeAuthConfig,
      resolveBin,
    );
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      command: resolved.command ?? claudeBin,
      args: buildClaudeProcessArgs(
        runtimeAuthConfig,
        claudeSessionId,
        allowedTools,
      ),
      inputProtocol: "claude-stream-json",
      outputProtocol: "claude-stream-json",
      agentId: "claude",
      agentName: "Claude Code",
    };
  }

  const agent = LOCAL_CLI_AGENT_DEFINITIONS.find(
    (candidate) => candidate.id === runtimeAuthConfig.localCliAgentId,
  );
  if (!agent) {
    return {
      ok: false,
      error: `Unknown local CLI agent: ${runtimeAuthConfig.localCliAgentId}`,
    };
  }

  const resolved = resolveConfiguredLocalCliBinary(
    agent,
    runtimeAuthConfig,
    resolveBin,
  );
  if (!resolved.ok) return resolved;
  const command = resolved.command;
  if (!command) {
    return {
      ok: false,
      error: `Selected local CLI agent "${agent.name}" (${agent.bin}) is not installed or not on PATH. Open Settings, rescan Local CLI agents, and choose an available CLI.`,
    };
  }

  const args = buildLocalCliAgentArgs(agent.id, runtimeAuthConfig, cwd);
  if (!args) {
    return {
      ok: false,
      error: `Selected local CLI agent "${agent.name}" is detected in the supported registry, but its DevLog runner is still pending.`,
    };
  }

  return {
    ok: true,
    command,
    args: args.args,
    inputProtocol: "plain-stdin",
    outputProtocol: args.outputProtocol,
    eventParser: args.eventParser,
    agentId: agent.id,
    agentName: agent.name,
  };
}

function resolveConfiguredLocalCliBinary(
  agent: (typeof LOCAL_CLI_AGENT_DEFINITIONS)[number] | undefined,
  runtimeAuthConfig: SessionRuntimeAuthConfig,
  resolveBin: ResolveLocalCliBinary,
): LocalCliBinaryResolution {
  if (!agent) return { ok: true, command: null };
  const configured =
    agent.binEnvKey && runtimeAuthConfig.localCliAgentEnv[agent.binEnvKey]
      ? runtimeAuthConfig.localCliAgentEnv[agent.binEnvKey].trim()
      : "";
  if (configured) {
    if (fs.existsSync(configured)) {
      return { ok: true, command: configured };
    }
    return {
      ok: false,
      error: `Configured ${agent.name} binary (${agent.binEnvKey}) does not exist: ${configured}. Update it in Settings or clear it to use PATH.`,
    };
  }
  return { ok: true, command: resolveBin(agent.id, agent.bin) };
}

export function validateSessionRuntimeProcessLaunch(
  runtimeAuthConfig: SessionRuntimeAuthConfig,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  resolveBin: ResolveLocalCliBinary = resolveLocalCliBinaryPath,
): { ok: true } | { ok: false; error: string } {
  if (isDirectProviderRuntime(runtimeAuthConfig)) {
    const validated = validateProviderRuntimeConfig(runtimeAuthConfig);
    return validated.ok ? { ok: true } : { ok: false, error: validated.error };
  }

  const launch = buildLocalCliProcessLaunch(
    runtimeAuthConfig,
    null,
    ALLOWED_TOOLS,
    cwd,
    resolveBin,
  );
  if (!launch.ok) return launch;

  const processEnv = buildClaudeProcessEnv(
    { ...env, PATH: env.PATH ?? userPath },
    runtimeAuthConfig,
  );
  if (!processEnv.ok) {
    return { ok: false, error: processEnv.error };
  }

  return { ok: true };
}

function isDirectProviderRuntime(config: SessionRuntimeAuthConfig): boolean {
  return config.mode === "anthropic-api-key" && !config.usesLegacyEnvVar;
}

function resolveLocalCliBinaryPath(agentId: string, bin: string): string | null {
  if (agentId === "claude" && claudeBin !== "claude" && fs.existsSync(claudeBin)) {
    return claudeBin;
  }
  return resolveExecutableOnPath(bin, { pathEnv: userPath });
}

function buildLocalCliAgentArgs(
  agentId: string,
  runtimeAuthConfig: SessionRuntimeAuthConfig,
  cwd: string,
): {
  args: string[];
  outputProtocol: ProcessOutputProtocol;
  eventParser?: JsonEventParser;
} | null {
  const modelArgs =
    runtimeAuthConfig.model !== DEFAULT_AGENT_MODEL
      ? ["--model", runtimeAuthConfig.model]
      : [];

  switch (agentId) {
    case "codex": {
      const args = [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--full-auto",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-C",
        cwd,
        ...modelArgs,
      ];
      if (runtimeAuthConfig.reasoning !== DEFAULT_LOCAL_CLI_REASONING) {
        args.push(
          "-c",
          `model_reasoning_effort="${runtimeAuthConfig.reasoning}"`,
        );
      }
      args.push("-");
      return {
        args,
        outputProtocol: "json-event-stream",
        eventParser: "codex",
      };
    }
    case "gemini":
      return {
        args: [
          "--output-format",
          "stream-json",
          "--skip-trust",
          "--yolo",
          ...modelArgs,
        ],
        outputProtocol: "json-event-stream",
        eventParser: "gemini",
      };
    case "opencode":
      return {
        args: [
          "run",
          "--format",
          "json",
          "--dangerously-skip-permissions",
          ...modelArgs,
          "-",
        ],
        outputProtocol: "json-event-stream",
        eventParser: "opencode",
      };
    case "cursor-agent":
      return {
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--force",
          "--trust",
          "--workspace",
          cwd,
          ...modelArgs,
        ],
        outputProtocol: "json-event-stream",
        eventParser: "cursor-agent",
      };
    case "qwen":
      return {
        args: ["--yolo", ...modelArgs],
        outputProtocol: "plain",
      };
    case "copilot":
      return {
        args: [
          "--allow-all-tools",
          "--output-format",
          "json",
          ...modelArgs,
        ],
        outputProtocol: "json-event-stream",
        eventParser: "copilot",
      };
    default:
      return null;
  }
}

function stringifyStreamValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseMaybeJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyResultContent(value: unknown): string {
  if (isRecord(value)) {
    if (typeof value.content === "string") return value.content;
    if (typeof value.detailedContent === "string") return value.detailedContent;
  }
  return stringifyStreamValue(value);
}

class ProcessManager {
  private sessions = new Map<string, SessionProcess>();
  private messageQueues = new Map<string, QueuedMessage[]>();
  private providerProcessing = new Set<string>();

  constructor() {
    const watchdog = setInterval(
      () => this.checkHealth(),
      WATCHDOG_INTERVAL_MS
    );
    watchdog.unref?.();
  }

  private emitSystemLog(
    level: SystemLogLevel,
    sessionId: string,
    message: string,
    prefix?: string
  ): void {
    streamManager.emit(
      "global",
      createSystemLogEvent({ level, prefix, sessionId, message })
    );
    streamManager.emit(
      sessionId,
      createSystemLogEvent({ level, prefix, sessionId, message })
    );
  }

  private checkHealth(): void {
    const now = Date.now();
    for (const [sessionId, sp] of this.sessions.entries()) {
      if (
        !shouldRestartUnresponsiveSession({
          lastActivityAt: sp.lastActivityAt,
          now,
          killed: sp.proc.killed,
          paused: sp.paused,
        })
      ) {
        continue;
      }

      const sessionAuthMode = this.getStoredSessionAuthMode(sessionId);
      const cannotRestartWithoutBrowserKey =
        needsBrowserApiKeyForWatchdogRestart(sessionAuthMode, sp.isProcessing);

      if (cannotRestartWithoutBrowserKey) {
        const message =
          "BYOK session became unresponsive and cannot be restarted because DevLog does not store browser-provided API keys. Re-enter the key in Settings and start a new turn.";
        this.emitSystemLog("warning", sessionId, message, "[WATCHDOG]");

        try {
          sp.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        this.sessions.delete(sessionId);

        try {
          const db = getDb();
          markSessionFailedAndReleaseLinkedTask(db, sessionId, message);
        } catch {
          // ignore
        }

        streamManager.emit(sessionId, { type: "error", message });
        streamManager.emit(sessionId, { type: "status", status: "failed" });
        continue;
      }

      this.emitSystemLog(
        "warning",
        sessionId,
        `Session ${sessionId.slice(0, 8)} unresponsive for 3m. Restarting...`,
        "[WATCHDOG]"
      );

      try {
        sp.proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      this.sessions.delete(sessionId);

      try {
        const db = getDb();
        db.prepare(
          "UPDATE sessions SET status = 'idle', pid = NULL WHERE id = ?"
        ).run(sessionId);
      } catch {
        // ignore
      }

      if (sp.isProcessing) {
        this.requeueLastUserMessage(sessionId);
      }
    }
  }

  private getStoredSessionAuthMode(sessionId: string): string | null {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT session_auth_mode FROM sessions WHERE id = ? LIMIT 1")
        .get(sessionId) as { session_auth_mode: string | null } | undefined;
      return row?.session_auth_mode ?? null;
    } catch {
      return null;
    }
  }

  private requeueLastUserMessage(sessionId: string): void {
    try {
      const db = getDb();
      const row = db
        .prepare(
          "SELECT content FROM session_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1"
        )
        .get(sessionId) as { content: string } | undefined;

      if (!row?.content) return;

      const queue = this.messageQueues.get(sessionId) ?? [];
      queue.unshift({ message: row.content });
      this.messageQueues.set(sessionId, queue);
    } catch {
      // ignore
    }
  }

  private sessionExists(sessionId: string): boolean {
    try {
      const db = getDb();
      const row = db
        .prepare("SELECT 1 AS exists_flag FROM sessions WHERE id = ? LIMIT 1")
        .get(sessionId) as { exists_flag: number } | undefined;
      return Boolean(row);
    } catch {
      return false;
    }
  }

  private getStoredSessionRuntimeRow(
    sessionId: string,
  ): StoredSessionRuntimeRow | null {
    try {
      const db = getDb();
      const row = db
        .prepare(
          `SELECT
            worktree_path,
            claude_session_id,
            session_auth_mode,
            agent_api_key_env_var,
            local_cli_agent_id,
            agent_model,
            agent_reasoning,
            agent_api_protocol,
            agent_api_version,
            agent_base_url,
            agent_max_tokens
           FROM sessions
           WHERE id = ?
           LIMIT 1`,
        )
        .get(sessionId) as StoredSessionRuntimeRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  private resolveRuntimeAuthConfigForSession(
    sessionId: string,
    runtimeAuthInput: SessionRuntimeAuthInput = {},
  ): SessionRuntimeAuthConfig | null {
    const session = this.getStoredSessionRuntimeRow(sessionId);
    if (!session) return null;
    return resolveStoredSessionRuntimeAuthConfig(session, runtimeAuthInput);
  }

  /**
   * Ensure a persistent process exists for the session.
   * Spawns `claude -p --input-format stream-json --output-format stream-json`
   * for bidirectional streaming communication.
   *
   * If a process already exists and is alive, returns it.
   * If no process exists, spawns a new one (with --resume if continuing).
   */
  private ensureProcess(
    sessionId: string,
    runtimeAuthInput: SessionRuntimeAuthInput = {},
  ): SessionProcess | null {
    const existing = this.sessions.get(sessionId);
    if (existing && !existing.proc.killed) {
      if (existing.paused) {
        existing.proc.kill("SIGCONT");
        existing.paused = false;
        const db = getDb();
        db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(sessionId);
        streamManager.emit(sessionId, { type: "status", status: "running" });
      }
      return existing;
    }

    // Clean up stale entry
    if (existing) {
      this.sessions.delete(sessionId);
    }

    const db = getDb();
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(
      sessionId,
    ) as StoredSessionRuntimeRow | undefined;

    if (!session) return null;

    // Clean env: remove CLAUDECODE so child doesn't think it's nested
    const { CLAUDECODE: _, ...cleanEnv } = process.env;
    const runtimeAuthConfig = resolveStoredSessionRuntimeAuthConfig(
      session,
      runtimeAuthInput,
    );
    const launch = buildLocalCliProcessLaunch(
      runtimeAuthConfig,
      session.claude_session_id,
      ALLOWED_TOOLS,
      session.worktree_path,
    );
    if (!launch.ok) {
      markSessionFailedAndReleaseLinkedTask(db, sessionId, launch.error);
      streamManager.emit(sessionId, {
        type: "error",
        message: launch.error,
      });
      streamManager.emit(sessionId, { type: "status", status: "failed" });
      this.emitSystemLog("warning", sessionId, launch.error);
      return null;
    }
    const processEnv = buildClaudeProcessEnv(
      { ...cleanEnv, PATH: userPath },
      runtimeAuthConfig,
    );
    if (!processEnv.ok) {
      markSessionFailedAndReleaseLinkedTask(db, sessionId, processEnv.error);
      streamManager.emit(sessionId, {
        type: "error",
        message: processEnv.error,
      });
      streamManager.emit(sessionId, { type: "status", status: "failed" });
      this.emitSystemLog("warning", sessionId, processEnv.error);
      return null;
    }
    const env = processEnv.env;

    const proc = spawn(launch.command, launch.args, {
      cwd: session.worktree_path,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const sp: SessionProcess = {
      proc,
      sessionId,
      inputProtocol: launch.inputProtocol,
      outputProtocol: launch.outputProtocol,
      eventParser: launch.eventParser,
      genericStreamState: {
        buffer: "",
        codexToolUses: new Set(),
        openCodeToolUses: new Set(),
        copilotToolNames: new Map(),
        cursorTextSoFar: "",
      },
      isProcessing: false,
      paused: false,
      lastActivityAt: Date.now(),
      textBuffer: "",
      toolCalls: [],
      claudeSessionId: session.claude_session_id,
      pendingPermission: null,
    };

    this.sessions.set(sessionId, sp);
    this.emitSystemLog(
      "info",
      sessionId,
      `Session ${sessionId.slice(0, 8)} process started with ${launch.agentName}`
    );

    proc.on("error", (err) => {
      this.sessions.delete(sessionId);
      const message = `Failed to start ${launch.agentName} process: ${err.message}`;
      try {
        markSessionFailedAndReleaseLinkedTask(db, sessionId, message);
      } catch {
        // ignore
      }
      streamManager.emit(sessionId, { type: "error", message });
      streamManager.emit(sessionId, { type: "status", status: "failed" });
      this.emitSystemLog("warning", sessionId, message);
    });

    proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") {
        streamManager.emit(sessionId, {
          type: "error",
          message: `Agent stdin error: ${err.message}`,
        });
      }
    });

    // Update session status
    db.prepare(
      "UPDATE sessions SET status = 'running', pid = ? WHERE id = ?"
    ).run(proc.pid, sessionId);
    streamManager.emit(sessionId, { type: "status", status: "running" });

    // Parse stdout according to the selected local CLI protocol.
    if (proc.stdout) {
      if (launch.outputProtocol === "claude-stream-json") {
        const rl = readline.createInterface({ input: proc.stdout });
        rl.on("line", (line) => {
          try {
            const event = JSON.parse(line);
            this.handleStreamEvent(sessionId, sp, event);
          } catch {
            // ignore unparseable lines
          }
        });
      } else {
        proc.stdout.on("data", (chunk: Buffer) => {
          this.handleGenericOutputChunk(sessionId, sp, chunk.toString());
        });
      }
    }

    // Capture stderr for debugging
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          // Log stderr but don't surface as errors unless critical
          let logId: number | undefined;
          const timestamp = new Date().toISOString();
          try {
            const db = getDb();
            const result = db.prepare(
              "INSERT INTO session_logs (session_id, chunk, stream) VALUES (?, ?, 'stderr')"
            ).run(sessionId, text);
            logId = Number(result.lastInsertRowid);
          } catch {
            // ignore
          }
          streamManager.emit(sessionId, {
            type: "log",
            id: logId,
            stream: "stderr",
            chunk: text,
            timestamp,
          });
        }
      });
    }

    // Handle process close after stdout/stderr have flushed.
    proc.on("close", (code) => {
      this.flushGenericOutput(sessionId, sp);
      this.sessions.delete(sessionId);
      this.emitSystemLog(
        code === 0 ? "success" : "warning",
        sessionId,
        `Session ${sessionId.slice(0, 8)} process exited with code ${code ?? "unknown"}`
      );

      // Save any remaining text buffer as assistant message
      const content = sp.textBuffer.trim();
      if (content) {
        try {
          db.prepare(
            "INSERT INTO session_messages (session_id, role, content) VALUES (?, 'assistant', ?)"
          ).run(sessionId, content);
        } catch {
          // ignore
        }
      }

      // If there was a turn in progress, notify about the interruption
      if (sp.isProcessing) {
        streamManager.emit(sessionId, {
          type: "turn_end",
          cost_usd: undefined,
          duration_ms: undefined,
          session_id: sp.claudeSessionId ?? undefined,
        });
      }

      // Update status to idle (can spawn new process for next message)
      const newStatus = "idle";
      let statusUpdated = false;
      try {
        const result = db.prepare(
          "UPDATE sessions SET status = ?, pid = NULL WHERE id = ? AND status NOT IN ('completed', 'failed', 'killed')"
        ).run(newStatus, sessionId);
        statusUpdated = result.changes > 0;
      } catch {
        // ignore
      }

      if (statusUpdated) {
        streamManager.emit(sessionId, { type: "status", status: "idle" });
      }

      // Auto-transition linked task based on session outcome
      onSessionExit(sessionId).catch(() => {
        // non-fatal: task transition failure shouldn't crash the process manager
      });

      // If there are queued messages, spawn new process and continue
      const queue = this.messageQueues.get(sessionId);
      if (queue && queue.length > 0) {
        setTimeout(() => this.processQueue(sessionId), 500);
      }
    });

    return sp;
  }

  /**
   * Send a message to a session.
   * If the session is currently processing a turn, the message is queued
   * and will be sent automatically when the current turn completes.
   */
  async sendMessage(
    sessionId: string,
    message: string,
    runtimeAuthInput?: SessionRuntimeAuthInput,
  ): Promise<void> {
    const runtimeAuthConfig = this.resolveRuntimeAuthConfigForSession(
      sessionId,
      runtimeAuthInput,
    );
    if (!runtimeAuthConfig) {
      streamManager.emit(sessionId, {
        type: "error",
        message: "Session not found",
      });
      return;
    }

    if (isDirectProviderRuntime(runtimeAuthConfig)) {
      await this.sendProviderMessage(sessionId, message, runtimeAuthInput);
      return;
    }

    const sp = this.ensureProcess(sessionId, runtimeAuthInput);
    if (!sp) {
      if (!this.sessionExists(sessionId)) {
        streamManager.emit(sessionId, {
          type: "error",
          message: "Session not found",
        });
      }
      return;
    }

    // If currently processing or waiting for permission, queue the message
    if (sp.isProcessing || sp.pendingPermission) {
      if (!this.messageQueues.has(sessionId)) {
        this.messageQueues.set(sessionId, []);
      }
      const queue = this.messageQueues.get(sessionId)!;
      queue.push({ message, runtimeAuthInput });

      streamManager.emit(sessionId, {
        type: "message_queued",
        content: message,
        position: queue.length,
      });
      return;
    }

    this.writeMessage(sp, message);
  }

  private async sendProviderMessage(
    sessionId: string,
    message: string,
    runtimeAuthInput?: SessionRuntimeAuthInput,
  ): Promise<void> {
    if (this.providerProcessing.has(sessionId)) {
      if (!this.messageQueues.has(sessionId)) {
        this.messageQueues.set(sessionId, []);
      }
      const queue = this.messageQueues.get(sessionId)!;
      queue.push({ message, runtimeAuthInput });
      streamManager.emit(sessionId, {
        type: "message_queued",
        content: message,
        position: queue.length,
      });
      return;
    }

    this.providerProcessing.add(sessionId);
    let ok = false;
    try {
      const result = await runProviderSessionTurn({
        db: getDb(),
        sessionId,
        message,
        runtimeAuthInput,
        emit: (targetSessionId, event) =>
          streamManager.emit(targetSessionId, event),
      });
      ok = result.ok;
      if (!result.ok) {
        this.emitSystemLog("warning", sessionId, result.error);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Provider session failed.";
      try {
        markSessionFailedAndReleaseLinkedTask(getDb(), sessionId, message);
      } catch {
        // ignore
      }
      streamManager.emit(sessionId, { type: "error", message });
      streamManager.emit(sessionId, { type: "status", status: "failed" });
      this.emitSystemLog("warning", sessionId, message);
    } finally {
      this.providerProcessing.delete(sessionId);
      if (ok) {
        setTimeout(() => this.processQueue(sessionId), 200);
      } else {
        this.messageQueues.delete(sessionId);
      }
    }
  }

  /**
   * Write a message directly to the selected local CLI process.
   */
  private writeMessage(sp: SessionProcess, message: string): void {
    const db = getDb();

    // Record user message in DB
    const insertResult = db.prepare(
      "INSERT INTO session_messages (session_id, role, content) VALUES (?, 'user', ?)"
    ).run(sp.sessionId, message);
    const messageId = Number(insertResult.lastInsertRowid);

    // Emit to stream subscribers
    streamManager.emit(sp.sessionId, {
      type: "message",
      id: messageId,
      role: "user",
      content: message,
    });

    // Mark as processing
    sp.isProcessing = true;
    sp.textBuffer = "";
    sp.toolCalls = [];

    streamManager.emit(sp.sessionId, { type: "status", status: "running" });

    if (sp.inputProtocol === "plain-stdin") {
      try {
        if (!sp.proc.stdin || sp.proc.killed) {
          throw new Error("Process stdin unavailable");
        }
        sp.proc.stdin.end(message, "utf8");
      } catch (err) {
        sp.isProcessing = false;
        streamManager.emit(sp.sessionId, {
          type: "error",
          message: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
        });
        streamManager.emit(sp.sessionId, { type: "status", status: "idle" });
      }
      return;
    }

    // Write to stdin in stream-json format
    const inputMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: message },
      session_id: sp.claudeSessionId ?? "default",
      parent_tool_use_id: null,
    });

    try {
      if (!sp.proc.stdin || sp.proc.killed) {
        throw new Error("Process stdin unavailable");
      }
      sp.proc.stdin.write(inputMsg + "\n");
    } catch (err) {
      sp.isProcessing = false;
      streamManager.emit(sp.sessionId, {
        type: "error",
        message: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
      });
      streamManager.emit(sp.sessionId, { type: "status", status: "idle" });
    }
  }

  /**
   * Process the next queued message for a session.
   */
  private processQueue(sessionId: string): void {
    const queue = this.messageQueues.get(sessionId);
    if (!queue || queue.length === 0) return;
    if (this.providerProcessing.has(sessionId)) return;

    const sp = this.sessions.get(sessionId);
    if (sp && sp.isProcessing) return; // Still processing, wait

    const nextMessage = queue.shift()!;

    streamManager.emit(sessionId, {
      type: "queue_drained",
      remaining: queue.length,
    });

    const runtimeAuthConfig = this.resolveRuntimeAuthConfigForSession(
      sessionId,
      nextMessage.runtimeAuthInput,
    );
    if (!runtimeAuthConfig) {
      streamManager.emit(sessionId, {
        type: "error",
        message: "Session not found",
      });
      return;
    }
    if (isDirectProviderRuntime(runtimeAuthConfig)) {
      void this.sendProviderMessage(
        sessionId,
        nextMessage.message,
        nextMessage.runtimeAuthInput,
      );
      return;
    }

    // If we still have a process, write directly. Otherwise, ensureProcess + write.
    if (sp && !sp.proc.killed) {
      this.writeMessage(sp, nextMessage.message);
    } else {
      // Need to spawn a new process (previous one exited)
      const newSp = this.ensureProcess(sessionId, nextMessage.runtimeAuthInput);
      if (newSp) {
        this.writeMessage(newSp, nextMessage.message);
      }
    }
  }

  /**
   * Respond to a permission request.
   * Writes the response to the process's stdin.
   */
  respondToPermission(sessionId: string, approved: boolean, reason?: string): void {
    const sp = this.sessions.get(sessionId);
    if (!sp || !sp.pendingPermission) {
      streamManager.emit(sessionId, {
        type: "error",
        message: "No pending permission request",
      });
      return;
    }

    const requestId = sp.pendingPermission.requestId;

    const response = JSON.stringify({
      type: "permission_response",
      decision: approved ? "approve" : "block",
      reason: reason ?? (approved ? "Approved by user" : "Denied by user"),
    });

    try {
      if (!sp.proc.stdin || sp.proc.killed) {
        throw new Error("Process stdin unavailable");
      }
      sp.proc.stdin.write(response + "\n");
    } catch (err) {
      streamManager.emit(sessionId, {
        type: "error",
        message: `Failed to send permission response: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    sp.pendingPermission = null;

    streamManager.emit(sessionId, {
      type: "permission_resolved",
      request_id: requestId,
      approved,
    });
  }

  resolveGate(
    sessionId: string,
    response: string,
  ): { ok: true } | { ok: false; error: string } {
    const trimmed = response.trim();
    if (!trimmed) {
      return { ok: false, error: "response is required" };
    }

    const db = getDb();
    const resolved = resolveControlPlaneGate(db, sessionId);
    if (!resolved) {
      return { ok: false, error: "no pending gate" };
    }

    const insertResult = db.prepare(
      "INSERT INTO session_messages (session_id, role, content) VALUES (?, 'user', ?)",
    ).run(sessionId, trimmed);
    const messageId = Number(insertResult.lastInsertRowid);

    streamManager.emit(sessionId, {
      type: "message",
      id: messageId,
      role: "user",
      content: trimmed,
    });

    let sp = this.sessions.get(sessionId);
    if (!sp || sp.proc.killed) {
      sp = this.ensureProcess(sessionId) ?? undefined;
    }

    if (sp && !sp.proc.killed) {
      const requestId = sp.pendingPermission?.requestId ?? resolved.gateStatus.id;
      sp.pendingPermission = null;
      if (sp.paused) {
        sp.proc.kill("SIGCONT");
        sp.paused = false;
      }
      sp.isProcessing = true;
      this.writeGateResponse(sp, trimmed);
      streamManager.emit(sessionId, {
        type: "permission_resolved",
        request_id: requestId,
        approved: true,
      });
    }

    db.prepare(
      "UPDATE sessions SET status = 'running' WHERE id = ? AND status = 'paused'",
    ).run(sessionId);

    const resolvedEvent = {
      type: "control_plane_gate_resolved" as const,
      session_id: sessionId,
      task_id: resolved.taskId,
      gate_id: resolved.gateStatus.id,
      response: trimmed,
    };
    streamManager.emit(sessionId, resolvedEvent);
    streamManager.emit("global", resolvedEvent);
    streamManager.emit(sessionId, { type: "status", status: "running" });
    streamManager.emit("global", { type: "status", status: "running" });

    return { ok: true };
  }

  private writeGateResponse(sp: SessionProcess, response: string): void {
    if (!sp.proc.stdin || sp.proc.stdin.destroyed || sp.proc.stdin.writableEnded) {
      this.emitSystemLog(
        "warning",
        sp.sessionId,
        "Gate resolved, but agent stdin is no longer writable.",
      );
      return;
    }

    try {
      if (sp.inputProtocol === "claude-stream-json") {
        const inputMsg = JSON.stringify({
          type: "user",
          message: { role: "user", content: response },
          session_id: sp.claudeSessionId ?? "default",
          parent_tool_use_id: null,
        });
        sp.proc.stdin.write(inputMsg + "\n");
        return;
      }
      sp.proc.stdin.write(response + "\n");
    } catch (err) {
      this.emitSystemLog(
        "warning",
        sp.sessionId,
        `Failed to write gate response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private handleGenericOutputChunk(
    sessionId: string,
    sp: SessionProcess,
    chunk: string,
  ): void {
    sp.lastActivityAt = Date.now();
    if (sp.outputProtocol === "plain") {
      this.emitTextDelta(sessionId, sp, chunk);
      return;
    }

    sp.genericStreamState.buffer += chunk;
    let newlineIndex = sp.genericStreamState.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = sp.genericStreamState.buffer.slice(0, newlineIndex).trim();
      sp.genericStreamState.buffer =
        sp.genericStreamState.buffer.slice(newlineIndex + 1);
      if (line) {
        this.handleGenericJsonLine(sessionId, sp, line);
      }
      newlineIndex = sp.genericStreamState.buffer.indexOf("\n");
    }
  }

  private flushGenericOutput(sessionId: string, sp: SessionProcess): void {
    if (sp.outputProtocol !== "json-event-stream") return;
    const line = sp.genericStreamState.buffer.trim();
    sp.genericStreamState.buffer = "";
    if (line) {
      this.handleGenericJsonLine(sessionId, sp, line);
    }
  }

  private handleGenericJsonLine(
    sessionId: string,
    sp: SessionProcess,
    line: string,
  ): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emitTextDelta(sessionId, sp, `${line}\n`);
      return;
    }

    switch (sp.eventParser) {
      case "codex":
        if (this.handleCodexEvent(sessionId, sp, event)) return;
        break;
      case "gemini":
        if (this.handleGeminiEvent(sessionId, sp, event)) return;
        break;
      case "opencode":
        if (this.handleOpenCodeEvent(sessionId, sp, event)) return;
        break;
      case "cursor-agent":
        if (this.handleCursorEvent(sessionId, sp, event)) return;
        break;
      case "copilot":
        if (this.handleCopilotEvent(sessionId, sp, event)) return;
        break;
    }
  }

  private handleCodexEvent(
    sessionId: string,
    sp: SessionProcess,
    event: Record<string, unknown>,
  ): boolean {
    const type = event.type;
    const item = event.item as Record<string, unknown> | undefined;

    if (type === "thread.started") {
      const codexThreadId = this.getCodexThreadId(event);
      this.emitSystemLog(
        "info",
        sessionId,
        codexThreadId
          ? `Codex thread started: ${codexThreadId}`
          : "Codex thread started",
      );
      return true;
    }

    if (type === "turn.started") {
      this.emitSystemLog("info", sessionId, "Codex turn started");
      return true;
    }

    if (type === "turn.completed") {
      this.emitSystemLog("success", sessionId, "Codex turn completed");
      return true;
    }

    if (
      type === "item.started" &&
      item?.type === "command_execution" &&
      typeof item.id === "string"
    ) {
      if (!sp.genericStreamState.codexToolUses.has(item.id)) {
        sp.genericStreamState.codexToolUses.add(item.id);
        streamManager.emit(sessionId, {
          type: "tool_start",
          name: "Bash",
          input: {
            command: typeof item.command === "string" ? item.command : "",
          },
        });
      }
      return true;
    }

    if (
      type === "item.completed" &&
      item?.type === "command_execution" &&
      typeof item.id === "string"
    ) {
      if (!sp.genericStreamState.codexToolUses.has(item.id)) {
        sp.genericStreamState.codexToolUses.add(item.id);
        streamManager.emit(sessionId, {
          type: "tool_start",
          name: "Bash",
          input: {
            command: typeof item.command === "string" ? item.command : "",
          },
        });
      }
      streamManager.emit(sessionId, {
        type: "tool_result",
        name: "Bash",
        output: stringifyStreamValue(item.aggregated_output ?? ""),
        is_error:
          typeof item.exit_code === "number"
            ? item.exit_code !== 0
            : item.status === "failed",
      });
      return true;
    }

    if (
      type === "item.completed" &&
      item?.type === "agent_message" &&
      typeof item.text === "string"
    ) {
      this.emitTextDelta(sessionId, sp, item.text);
      return true;
    }

    return false;
  }

  private getCodexThreadId(event: Record<string, unknown>): string | null {
    const directId =
      typeof event.thread_id === "string"
        ? event.thread_id
        : typeof event.threadId === "string"
          ? event.threadId
          : typeof event.session_id === "string"
            ? event.session_id
            : null;
    if (directId) return directId;

    const thread = isRecord(event.thread) ? event.thread : null;
    return typeof thread?.id === "string" ? thread.id : null;
  }

  private handleGeminiEvent(
    sessionId: string,
    sp: SessionProcess,
    event: Record<string, unknown>,
  ): boolean {
    if (
      event.type === "message" &&
      event.role === "assistant" &&
      typeof event.content === "string"
    ) {
      this.emitTextDelta(sessionId, sp, event.content);
      return true;
    }
    return event.type === "init" || event.type === "result";
  }

  private handleOpenCodeEvent(
    sessionId: string,
    sp: SessionProcess,
    event: Record<string, unknown>,
  ): boolean {
    const part = event.part as Record<string, unknown> | undefined;
    if (
      event.type === "text" &&
      part &&
      typeof part.text === "string"
    ) {
      this.emitTextDelta(sessionId, sp, part.text);
      return true;
    }

    if (
      event.type === "tool_use" &&
      part &&
      typeof part.tool === "string" &&
      typeof part.callID === "string"
    ) {
      const key = `${event.sessionID ?? "session"}:${part.callID}`;
      const statePart = part.state as Record<string, unknown> | undefined;
      if (!sp.genericStreamState.openCodeToolUses.has(key)) {
        sp.genericStreamState.openCodeToolUses.add(key);
        streamManager.emit(sessionId, {
          type: "tool_start",
          name: part.tool,
          input: parseMaybeJson(statePart?.input),
        });
      }
      if (statePart?.status === "completed") {
        streamManager.emit(sessionId, {
          type: "tool_result",
          name: part.tool,
          output: stringifyStreamValue(statePart.output),
          is_error: false,
        });
      }
      return true;
    }

    return event.type === "step_start" || event.type === "step_finish";
  }

  private handleCursorEvent(
    sessionId: string,
    sp: SessionProcess,
    event: Record<string, unknown>,
  ): boolean {
    if (event.type === "assistant") {
      const message = event.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const text = blocks
        .map((block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
            ? String((block as { text: string }).text)
            : "",
        )
        .join("");
      if (!text) return false;
      const previous = sp.genericStreamState.cursorTextSoFar;
      if (text === previous) return true;
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      sp.genericStreamState.cursorTextSoFar = text;
      this.emitTextDelta(sessionId, sp, delta);
      return true;
    }
    return event.type === "system" || event.type === "result";
  }

  private handleCopilotEvent(
    sessionId: string,
    sp: SessionProcess,
    event: Record<string, unknown>,
  ): boolean {
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "session.tools_updated":
      case "assistant.turn_start":
      case "assistant.reasoning_delta":
        return true;
      case "assistant.message_delta":
        if (typeof data.deltaContent === "string") {
          this.emitTextDelta(sessionId, sp, data.deltaContent);
          return true;
        }
        return false;
      case "tool.execution_start": {
        const toolCallId =
          typeof data.toolCallId === "string" ? data.toolCallId : randomUUID();
        const name =
          typeof data.toolName === "string" && data.toolName.length > 0
            ? data.toolName
            : "Tool";
        sp.genericStreamState.copilotToolNames.set(toolCallId, name);
        streamManager.emit(sessionId, {
          type: "tool_start",
          name,
          input: parseMaybeJson(data.arguments),
        });
        return true;
      }
      case "tool.execution_complete": {
        const toolCallId =
          typeof data.toolCallId === "string" ? data.toolCallId : "";
        streamManager.emit(sessionId, {
          type: "tool_result",
          name:
            sp.genericStreamState.copilotToolNames.get(toolCallId) ?? "Tool",
          output: stringifyResultContent(data.result),
          is_error: data.success === false,
        });
        return true;
      }
      case "result":
      case "user.message":
        return true;
      default:
        return false;
    }
  }

  private emitTextDelta(
    sessionId: string,
    sp: SessionProcess,
    text: string,
  ): void {
    if (!text) return;
    const parsed = parseControlPlaneProtocolText(text);
    for (const event of parsed.events) {
      this.handleControlPlaneEvent(sessionId, event);
    }

    if (!parsed.text) return;
    sp.textBuffer += parsed.text;
    streamManager.emit(sessionId, {
      type: "text_delta",
      text: parsed.text,
    });
  }

  private handleControlPlaneEvent(
    sessionId: string,
    event: ControlPlaneProtocolEvent,
  ): void {
    let applied: ReturnType<typeof applyControlPlaneEvent> = null;
    try {
      applied = applyControlPlaneEvent(getDb(), sessionId, event);
    } catch (error) {
      this.emitSystemLog(
        "warning",
        sessionId,
        `Ignored DevLog control marker: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!applied) return;

    if (event.type === "stage") {
      const streamEvent = {
        type: "control_plane_stage" as const,
        session_id: sessionId,
        task_id: applied.taskId,
        current_stage: event.current_stage,
      };
      streamManager.emit(sessionId, streamEvent);
      streamManager.emit("global", streamEvent);
      return;
    }

    if (applied.gateStatus) {
      const streamEvent = {
        type: "control_plane_gate" as const,
        session_id: sessionId,
        task_id: applied.taskId,
        current_stage: applied.currentStage,
        gate_status: applied.gateStatus,
      };
      streamManager.emit(sessionId, streamEvent);
      streamManager.emit("global", streamEvent);
      this.pauseForControlPlaneGate(sessionId, {
        sessionId,
        taskId: applied.taskId,
        currentStage: applied.currentStage,
        gateStatus: applied.gateStatus,
      });
    }
  }

  private pauseForControlPlaneGate(
    sessionId: string,
    gate: ResolvedControlPlaneGate,
  ): void {
    const toolInput = {
      question: gate.gateStatus.question,
      options: gate.gateStatus.options,
      stage: gate.gateStatus.stage ?? null,
    };
    const sp = this.sessions.get(sessionId);
    if (sp && !sp.proc.killed) {
      sp.pendingPermission = {
        requestId: gate.gateStatus.id,
        toolName: "AskHuman",
        toolInput,
      };
      sp.proc.kill("SIGSTOP");
      sp.paused = true;
      sp.isProcessing = false;
    }

    const db = getDb();
    db.prepare(
      "UPDATE sessions SET status = 'paused' WHERE id = ? AND status NOT IN ('completed', 'failed', 'killed')",
    ).run(sessionId);
    streamManager.emit(sessionId, {
      type: "permission_request",
      tool_name: "AskHuman",
      tool_input: toolInput,
      request_id: gate.gateStatus.id,
    });
    streamManager.emit(sessionId, { type: "status", status: "paused" });
    streamManager.emit("global", { type: "status", status: "paused" });
    this.emitSystemLog(
      "info",
      sessionId,
      `Session ${sessionId.slice(0, 8)} paused for human gate`,
    );
  }

  /**
   * Parse a stream-json event from Claude Code and emit structured chat events.
   * Handles both legacy format and the granular streaming format.
   */
  private handleStreamEvent(
    sessionId: string,
    sp: SessionProcess,
    event: Record<string, unknown>
  ): void {
    sp.lastActivityAt = Date.now();

    const type = event.type as string;
    const subtype = event.subtype as string | undefined;

    // System events — capture session_id
    if (type === "system") {
      if (subtype === "init" && event.session_id) {
        sp.claudeSessionId = event.session_id as string;
        const db = getDb();
        try {
          db.prepare(
            "UPDATE sessions SET claude_session_id = ? WHERE id = ?"
          ).run(sp.claudeSessionId, sessionId);
        } catch {
          // ignore
        }
      }
      return;
    }

    // Rate limit events — skip
    if (type === "rate_limit_event") return;

    // Permission request events
    if (type === "permission_request") {
      const requestId = `perm_${randomUUID()}`;

      sp.pendingPermission = {
        requestId,
        toolName: (event.tool_name as string) ?? (event.name as string) ?? "unknown",
        toolInput: (event.tool_input as Record<string, unknown>) ?? (event.input as Record<string, unknown>) ?? {},
      };

      streamManager.emit(sessionId, {
        type: "permission_request",
        tool_name: sp.pendingPermission.toolName,
        tool_input: sp.pendingPermission.toolInput,
        request_id: requestId,
      });
      return;
    }

    // Wrapped stream events (stream_event wrapper)
    if (type === "stream_event") {
      const inner = event.event as Record<string, unknown> | undefined;
      if (inner) {
        this.handleStreamEvent(sessionId, sp, inner);
      }
      return;
    }

    // Assistant message — extract text and tool_use blocks
    if (type === "assistant") {
      const msg = event.message as {
        content?: Array<{
          type: string;
          text?: string;
          name?: string;
          input?: Record<string, unknown>;
        }>;
      } | undefined;

      if (!msg?.content) return;

      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          this.emitTextDelta(sessionId, sp, block.text);
        } else if (block.type === "tool_use" && block.name) {
          const toolCall: ToolCall = {
            name: block.name,
            input: block.input ?? {},
          };
          sp.toolCalls.push(toolCall);
          streamManager.emit(sessionId, {
            type: "tool_start",
            name: block.name,
            input: block.input ?? {},
          });
        }
      }
      return;
    }

    // Content block delta (granular streaming with --include-partial-messages)
    if (type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === "text_delta" && delta.text) {
        this.emitTextDelta(sessionId, sp, delta.text);
      }
      return;
    }

    // Tool result
    if (type === "tool_result" || type === "tool") {
      const name = (event.name as string) ?? "tool";
      const output = (event.result as string) ?? (event.content as string) ?? "";
      const isError = !!(event.is_error);
      streamManager.emit(sessionId, {
        type: "tool_result",
        name,
        output: typeof output === "string" ? output : JSON.stringify(output),
        is_error: isError,
      });
      return;
    }

    // Result (turn complete)
    if (type === "result") {
      const isError = event.is_error === true;
      const claudeSessionId = event.session_id as string | undefined;
      if (claudeSessionId) {
        sp.claudeSessionId = claudeSessionId;
        const db = getDb();
        try {
          db.prepare(
            "UPDATE sessions SET claude_session_id = ? WHERE id = ?"
          ).run(claudeSessionId, sessionId);
        } catch {
          // ignore
        }
      }

      // Save assistant message
      const content = sp.textBuffer.trim();
      if (content) {
        const db = getDb();
        try {
          db.prepare(
            "INSERT INTO session_messages (session_id, role, content) VALUES (?, 'assistant', ?)"
          ).run(sessionId, content);
        } catch {
          // ignore
        }
      }

      streamManager.emit(sessionId, {
        type: "turn_end",
        cost_usd: event.total_cost_usd as number | undefined,
        duration_ms: event.duration_ms as number | undefined,
        session_id: claudeSessionId,
      });

      // Reset turn state
      sp.isProcessing = false;
      sp.textBuffer = "";
      sp.toolCalls = [];

      // Update status to idle or failed
      const db = getDb();
      try {
        if (isError) {
          markSessionFailedAndReleaseLinkedTask(
            db,
            sessionId,
            "Agent reported an error for this turn.",
          );
        } else {
          db.prepare(
            "UPDATE sessions SET status = 'idle' WHERE id = ? AND status = 'running'"
          ).run(sessionId);
        }
      } catch {
        // ignore
      }

      streamManager.emit(sessionId, {
        type: "status",
        status: isError ? "failed" : "idle",
      });

      // Process next queued message after a brief delay
      if (!isError) {
        setTimeout(() => this.processQueue(sessionId), 200);
      } else {
        this.messageQueues.delete(sessionId);
        try {
          sp.proc.stdin?.end();
        } catch {
          // ignore
        }
        try {
          sp.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      return;
    }
  }

  /** Check if a turn is actively processing */
  isProcessing(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isProcessing ?? false;
  }

  /** Check if there's a pending permission request */
  hasPendingPermission(sessionId: string): boolean {
    return (this.sessions.get(sessionId)?.pendingPermission ?? null) !== null;
  }

  /** Get the number of queued messages */
  getQueueLength(sessionId: string): number {
    return this.messageQueues.get(sessionId)?.length ?? 0;
  }

  /** Kill the active process for a session */
  kill(sessionId: string): boolean {
    const sp = this.sessions.get(sessionId);
    this.emitSystemLog(
      "warning",
      sessionId,
      `Session ${sessionId.slice(0, 8)} kill requested`
    );

    if (sp) {
      // Close stdin gracefully first
      try {
        sp.proc.stdin?.end();
      } catch {
        // ignore
      }
      sp.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.sessions.has(sessionId)) {
          sp.proc.kill("SIGKILL");
        }
      }, 5000);
    }

    // Clear queue
    this.messageQueues.delete(sessionId);

    const db = getDb();
    db.prepare(
      "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?"
    ).run(sessionId);
    streamManager.emit(sessionId, { type: "status", status: "killed" });
    this.emitSystemLog(
      "warning",
      sessionId,
      `Session ${sessionId.slice(0, 8)} killed`
    );

    return true;
  }

  /** Pause the active process for a session without ending the session */
  pause(sessionId: string): boolean {
    const sp = this.sessions.get(sessionId);
    this.emitSystemLog(
      "info",
      sessionId,
      `Session ${sessionId.slice(0, 8)} pause requested`
    );

    if (sp && !sp.proc.killed) {
      sp.proc.kill("SIGSTOP");
      sp.paused = true;
      sp.isProcessing = false;
    }

    const db = getDb();
    db.prepare(
      "UPDATE sessions SET status = 'paused' WHERE id = ? AND status NOT IN ('completed', 'killed')"
    ).run(sessionId);
    streamManager.emit(sessionId, { type: "status", status: "paused" });
    this.emitSystemLog(
      "info",
      sessionId,
      `Session ${sessionId.slice(0, 8)} paused`
    );

    return true;
  }

  /** End a session (mark completed, no more turns) */
  endSession(sessionId: string): void {
    this.emitSystemLog(
      "info",
      sessionId,
      `Session ${sessionId.slice(0, 8)} completion requested`
    );
    this.kill(sessionId);
    const db = getDb();
    db.prepare(
      "UPDATE sessions SET status = 'completed', ended_at = datetime('now') WHERE id = ?"
    ).run(sessionId);
    streamManager.emit(sessionId, { type: "status", status: "completed" });
    this.emitSystemLog(
      "success",
      sessionId,
      `Session ${sessionId.slice(0, 8)} completed`
    );
  }

  killAll(): void {
    for (const [sessionId] of this.sessions) {
      this.kill(sessionId);
    }
  }

  getRunningCount(): number {
    return this.sessions.size;
  }
}

// Singleton
const globalForProcess = globalThis as unknown as { processManager?: ProcessManager };
export const processManager =
  globalForProcess.processManager ??
  (globalForProcess.processManager = new ProcessManager());
