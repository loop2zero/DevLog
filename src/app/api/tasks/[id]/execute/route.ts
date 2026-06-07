import { NextRequest, NextResponse } from "next/server";
import { resolveProjectId } from "@/lib/api-utils";
import { executeTask } from "@/core/task-execution";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;
  const projectId = resolveProjectId(req);
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    // No body means use the default agent execution config.
  }

  const result = await executeTask(taskId, projectId, payload);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { session: result.session, worktree: result.worktree },
    { status: 201 },
  );
}
