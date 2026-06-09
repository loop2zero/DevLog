export type TaskStatus = "todo" | "in_queue" | "in_progress" | "review" | "blocked" | "fail" | "done";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type SessionApiProtocol =
  | "anthropic"
  | "openai"
  | "azure"
  | "google"
  | "ollama"
  | "senseaudio";

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  worktree_name: string | null;
  session_id: string | null;
  sort_order: number;
  prompt: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  blocked_by?: string | null; // JSON array of task ids when status === 'in_queue'
  sandbox_iterations?: number;
  fail_reason?: string | null;
  linear_issue_id?: string | null;
  linear_identifier?: string | null;
  linear_workpad_comment_id?: string | null;
  linear_finalized_at?: string | null;
  current_stage?: string | null;
  gate_status?: string | null; // JSON-encoded GateStatus when a workflow is awaiting input
}

export type SessionStatus =
  | "pending"
  | "running"
  | "idle"
  | "paused"
  | "completed"
  | "failed"
  | "killed";

export interface Session {
  id: string;
  project_id: string;
  task_id: string | null;
  worktree_name: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  pid: number | null;
  status: SessionStatus;
  claude_command: string | null;
  claude_session_id: string | null;
  coding_agent_id: string;
  agent_team_id: string;
  session_auth_mode:
    | "local-cli"
    | "anthropic-api-key"
    | "backend-oauth"
    | "agent-api-key";
  agent_api_key_env_var: string | null;
  local_cli_agent_id: string;
  agent_model: string;
  agent_reasoning: string;
  agent_api_protocol: SessionApiProtocol;
  agent_api_version: string;
  agent_base_url: string;
  agent_max_tokens: number;
  current_stage?: string | null;
  gate_status?: string | null;
  prompt: string | null;
  exit_code: number | null;
  log_path: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface GateStatus {
  id: string;
  question: string;
  options: string[];
  created_at: string;
  stage?: string | null;
}

/** A structured tool call from Claude's response */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** A chat message with structured content */
export interface ChatMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
  cost_usd?: number;
  timestamp: string;
}

export type LockType = "write" | "conflict";

export interface FileLock {
  id: string;
  project_id: string;
  file_path: string;
  worktree_name: string;
  session_id: string | null;
  lock_type: LockType;
  detected_at: string;
  resolved_at: string | null;
}

export interface Worktree {
  name: string;
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  filesChanged?: number;
  activeSessions?: number;
}

export interface LogChunk {
  id: number;
  session_id: string;
  chunk: string;
  stream: "stdout" | "stderr";
  timestamp: string;
}

export interface SSEEvent {
  type: "log" | "status" | "conflict" | "heartbeat";
  session_id?: string;
  data: unknown;
}

export interface ActiveConflict {
  file_path: string;
  worktrees: string[];
  detected_at: string;
}

export interface ChatMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface DevLogStats {
  sessions: number;
  totalCost: number;
  toolCalls: number;
  filesTouched: number;
}
