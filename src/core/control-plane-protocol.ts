import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { GateStatus } from "./types-dashboard";

export type ControlPlaneProtocolEvent =
  | { type: "stage"; current_stage: string }
  | { type: "gate"; question: string; options: string[]; stage?: string };

export interface ParsedControlPlaneText {
  text: string;
  events: ControlPlaneProtocolEvent[];
}

export interface AppliedControlPlaneEvent {
  sessionId: string;
  taskId: string | null;
  currentStage: string | null;
  gateStatus: GateStatus | null;
}

export interface ResolvedControlPlaneGate {
  sessionId: string;
  taskId: string | null;
  currentStage: string | null;
  gateStatus: GateStatus;
}

const MARKER_PATTERN = /^\s*\[DEVLOG_(STAGE|GATE)\]\s+(.+?)\s*$/;

export function parseControlPlaneProtocolText(
  text: string,
): ParsedControlPlaneText {
  const visibleLines: string[] = [];
  const events: ControlPlaneProtocolEvent[] = [];

  for (const line of text.split(/\r?\n/)) {
    const marker = MARKER_PATTERN.exec(line);
    if (!marker) {
      visibleLines.push(line);
      continue;
    }

    const event = parseProtocolMarker(marker[1], marker[2]);
    if (!event) {
      visibleLines.push(line);
      continue;
    }

    events.push(event);
  }

  return {
    text: trimProtocolLineGaps(visibleLines.join("\n")),
    events,
  };
}

export function applyControlPlaneEvent(
  db: Database.Database,
  sessionId: string,
  event: ControlPlaneProtocolEvent,
  opts: {
    now?: () => Date;
    createId?: () => string;
  } = {},
): AppliedControlPlaneEvent | null {
  const session = db
    .prepare("SELECT task_id, current_stage FROM sessions WHERE id = ? LIMIT 1")
    .get(sessionId) as
    | { task_id: string | null; current_stage: string | null }
    | undefined;

  if (!session) return null;

  if (event.type === "stage") {
    db.prepare("UPDATE sessions SET current_stage = ? WHERE id = ?").run(
      event.current_stage,
      sessionId,
    );
    if (session.task_id) {
      db.prepare(
        "UPDATE tasks SET current_stage = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(event.current_stage, session.task_id);
    }
    return {
      sessionId,
      taskId: session.task_id,
      currentStage: event.current_stage,
      gateStatus: null,
    };
  }

  const currentStage = event.stage ?? session.current_stage ?? null;
  const gateStatus: GateStatus = {
    id: opts.createId?.() ?? `gate_${randomUUID()}`,
    question: event.question,
    options: event.options,
    created_at: (opts.now?.() ?? new Date()).toISOString(),
    stage: currentStage,
  };
  const serializedGate = JSON.stringify(gateStatus);

  db.prepare(
    "UPDATE sessions SET current_stage = ?, gate_status = ? WHERE id = ?",
  ).run(currentStage, serializedGate, sessionId);
  if (session.task_id) {
    db.prepare(
      "UPDATE tasks SET current_stage = ?, gate_status = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(currentStage, serializedGate, session.task_id);
  }

  return {
    sessionId,
    taskId: session.task_id,
    currentStage,
    gateStatus,
  };
}

export function resolveControlPlaneGate(
  db: Database.Database,
  sessionId: string,
): ResolvedControlPlaneGate | null {
  const session = db
    .prepare("SELECT task_id, current_stage, gate_status FROM sessions WHERE id = ? LIMIT 1")
    .get(sessionId) as
    | { task_id: string | null; current_stage: string | null; gate_status: string | null }
    | undefined;

  if (!session?.gate_status) return null;
  const gateStatus = parseGateStatus(session.gate_status);
  if (!gateStatus) return null;

  db.prepare("UPDATE sessions SET gate_status = NULL WHERE id = ?").run(sessionId);
  if (session.task_id) {
    db.prepare(
      "UPDATE tasks SET gate_status = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(session.task_id);
  }

  return {
    sessionId,
    taskId: session.task_id,
    currentStage: session.current_stage,
    gateStatus,
  };
}

function parseProtocolMarker(
  markerType: string,
  rawJson: string,
): ControlPlaneProtocolEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;

  if (markerType === "STAGE") {
    const stage = readNonEmptyString(payload.current_stage) ?? readNonEmptyString(payload.stage);
    if (!stage) return null;
    const desc = readNonEmptyString(payload.desc) ?? readNonEmptyString(payload.description);
    return {
      type: "stage",
      current_stage: desc ? `${stage} · ${desc}` : stage,
    };
  }

  if (markerType === "GATE") {
    const question = readNonEmptyString(payload.question);
    if (!question) return null;
    const stage = readStageDisplay(payload);
    return {
      type: "gate",
      question,
      options: readOptions(payload.options),
      ...(stage ? { stage } : {}),
    };
  }

  return null;
}

function readStageDisplay(payload: Record<string, unknown>): string | null {
  const stage = readNonEmptyString(payload.current_stage) ?? readNonEmptyString(payload.stage);
  if (!stage) return null;
  const desc = readNonEmptyString(payload.desc) ?? readNonEmptyString(payload.description);
  return desc ? `${stage} · ${desc}` : stage;
}

function readOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((option) => (typeof option === "string" ? option.trim() : ""))
    .filter(Boolean);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimProtocolLineGaps(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

function parseGateStatus(value: string): GateStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const id = readNonEmptyString(parsed.id);
  const question = readNonEmptyString(parsed.question);
  if (!id || !question) return null;

  return {
    id,
    question,
    options: readOptions(parsed.options),
    created_at: readNonEmptyString(parsed.created_at) ?? new Date(0).toISOString(),
    stage: readNonEmptyString(parsed.stage),
  };
}
