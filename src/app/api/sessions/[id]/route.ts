import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/core/db";
import { processManager } from "@/core/process-manager";
import { getSessionRuntimeAuthInputFromPayload } from "@/core/session-runtime-auth";
import type { Session } from "@/core/types-dashboard";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as Session | undefined;

  if (!session) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(session);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const { action, message, response, approved, reason } = body as {
    action?: "send" | "kill" | "pause" | "end" | "respond_permission" | "resolve_gate";
    message?: string;
    response?: string;
    approved?: boolean;
    reason?: string;
  };

  if (!action) {
    return NextResponse.json({ error: "action is required" }, { status: 400 });
  }

  switch (action) {
    case "send":
      if (!message?.trim()) {
        return NextResponse.json({ error: "message is required" }, { status: 400 });
      }
      // No longer blocking on active turns — messages are queued automatically
      processManager.sendMessage(
        id,
        message.trim(),
        getSessionRuntimeAuthInputFromPayload(body),
      );
      break;

    case "respond_permission":
      if (typeof approved !== "boolean") {
        return NextResponse.json({ error: "approved (boolean) is required" }, { status: 400 });
      }
      if (!processManager.hasPendingPermission(id)) {
        return NextResponse.json({ error: "no pending permission request" }, { status: 409 });
      }
      processManager.respondToPermission(id, approved, reason);
      break;

    case "resolve_gate": {
      const gateResponse = response ?? message;
      if (!gateResponse?.trim()) {
        return NextResponse.json({ error: "response is required" }, { status: 400 });
      }
      const result = processManager.resolveGate(id, gateResponse.trim());
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 409 });
      }
      break;
    }

    case "kill":
      processManager.kill(id);
      break;

    case "pause":
      processManager.pause(id);
      break;

    case "end":
      processManager.endSession(id);
      break;

    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }

  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(id) as Session;

  return NextResponse.json({
    ...session,
    is_processing: processManager.isProcessing(id),
    has_pending_permission: processManager.hasPendingPermission(id),
    queue_length: processManager.getQueueLength(id),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  processManager.kill(id);

  db.prepare("DELETE FROM session_logs WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(id);
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);

  if (result.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
