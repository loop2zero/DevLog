import type { GateStatus } from "./types-dashboard";

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type SystemLogLevel = "info" | "success" | "warning" | "error";

export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string; is_error?: boolean }
  | { type: "turn_end"; cost_usd?: number; duration_ms?: number; session_id?: string }
  | { type: "error"; message: string }
  | {
      type: "status";
      status: string;
      content?: string;
      pid?: number | null;
      started_at?: string | null;
      ended_at?: string | null;
    }
  | {
      type: "log";
      id?: number;
      stream: "stdout" | "stderr";
      chunk: string;
      timestamp: string;
    }
  | { type: "system_log"; level: SystemLogLevel; prefix?: string; message: string; session_id?: string; timestamp: string }
  | { type: "message"; id?: number; role: "user" | "assistant"; content: string; tool_calls?: ToolCall[] }
  // Interactive session events
  | { type: "permission_request"; tool_name: string; tool_input: Record<string, unknown>; request_id: string }
  | { type: "permission_resolved"; request_id: string; approved: boolean }
  | { type: "message_queued"; content: string; position: number }
  | { type: "queue_drained"; remaining: number }
  | {
      type: "control_plane_stage";
      session_id: string;
      task_id: string | null;
      current_stage: string;
    }
  | {
      type: "control_plane_gate";
      session_id: string;
      task_id: string | null;
      current_stage: string | null;
      gate_status: GateStatus;
    }
  | {
      type: "control_plane_gate_resolved";
      session_id: string;
      task_id: string | null;
      gate_id: string;
      response: string;
    };

export function createSystemLogEvent({
  level,
  prefix,
  message,
  sessionId,
  timestamp = new Date().toISOString(),
}: {
  level: SystemLogLevel;
  prefix?: string;
  message: string;
  sessionId?: string;
  timestamp?: string;
}): ChatStreamEvent {
  return {
    type: "system_log",
    level,
    ...(prefix ? { prefix } : {}),
    message,
    session_id: sessionId,
    timestamp,
  };
}

type Callback = (event: ChatStreamEvent) => void;

class StreamManager {
  private subscribers = new Map<string, Set<Callback>>();

  subscribe(sessionId: string, callback: Callback): () => void {
    if (!this.subscribers.has(sessionId)) {
      this.subscribers.set(sessionId, new Set());
    }
    this.subscribers.get(sessionId)!.add(callback);

    return () => {
      const subs = this.subscribers.get(sessionId);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) {
          this.subscribers.delete(sessionId);
        }
      }
    };
  }

  emit(sessionId: string, event: ChatStreamEvent): void {
    const subs = this.subscribers.get(sessionId);
    if (subs) {
      for (const cb of subs) {
        cb(event);
      }
    }
  }

  hasSubscribers(sessionId: string): boolean {
    return (this.subscribers.get(sessionId)?.size ?? 0) > 0;
  }
}

// Singleton
const globalForStream = globalThis as unknown as { streamManager?: StreamManager };
export const streamManager =
  globalForStream.streamManager ?? (globalForStream.streamManager = new StreamManager());
