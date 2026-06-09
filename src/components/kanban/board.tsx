"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { FileText } from "lucide-react";
import { KanbanColumn, KanbanGroupedColumn } from "./column";
import { CreateTaskDialog } from "./create-task-dialog";
import { TaskDetailDialog } from "./task-detail-dialog";
import { useTasks } from "@/hooks/use-tasks";
import { useTaskSessions } from "@/hooks/use-task-sessions";
import { useAgentSettings } from "@/hooks/use-agent-settings";
import type { Task, TaskStatus } from "@/core/types-dashboard";
import type { SessionRuntimeAuthInput } from "@/core/session-runtime-auth";
import { getTaskBoardColumns } from "@/core/task-status-flow";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const COLUMNS = getTaskBoardColumns();

export function KanbanBoard() {
  const { loading, tasksByStatus, createTask, updateTask, deleteTask, reorder, executeTask, refresh } = useTasks();
  const taskSessions = useTaskSessions();
  const { runtimePayload, byokReady, loaded, settingsReady } = useAgentSettings();
  const router = useRouter();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const handleExecuteTask = async (taskId: string) => {
    if (!loaded) {
      return;
    }
    if (!byokReady) {
      router.push("/settings");
      return;
    }
    if (!settingsReady) {
      return;
    }
    const result = await executeTask(taskId, runtimePayload);
    if (result?.session) {
      router.push(`/sessions/${result.session.id}`);
    }
  };

  const handlePauseTask = async (sessionId: string) => {
    await fetch(`/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
    });
  };

  const handleDragEnd = async (result: DropResult) => {
    const { source, destination } = result;
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;

    const destStatus = destination.droppableId as TaskStatus;
    const sourceStatus = source.droppableId as TaskStatus;

    const items: { id: string; status: TaskStatus; sort_order: number }[] = [];

    if (sourceStatus === destStatus) {
      const columnTasks = [...tasksByStatus(sourceStatus)];
      const [moved] = columnTasks.splice(source.index, 1);
      columnTasks.splice(destination.index, 0, moved);
      columnTasks.forEach((t, i) => items.push({ id: t.id, status: destStatus, sort_order: i }));
    } else {
      const sourceTasks = [...tasksByStatus(sourceStatus)];
      const destTasks = [...tasksByStatus(destStatus)];

      const [moved] = sourceTasks.splice(source.index, 1);
      destTasks.splice(destination.index, 0, moved);

      sourceTasks.forEach((t, i) => items.push({ id: t.id, status: sourceStatus, sort_order: i }));
      destTasks.forEach((t, i) => items.push({ id: t.id, status: destStatus, sort_order: i }));
    }

    await reorder(items);
  };

  const handleClickTask = (task: Task) => {
    setSelectedTask(task);
    setDetailOpen(true);
  };

  const handleUpdateTask = async (id: string, data: Partial<Task>) => {
    await updateTask(id, data);
    setSelectedTask((prev) => (prev?.id === id ? { ...prev, ...data } as Task : prev));
  };

  const handleLaunchSession = async (
    task: Task,
    worktreePath: string,
    worktreeName?: string,
    branchName?: string,
    agentConfig?: {
      coding_agent_id: string;
      agent_team_id: string;
    } & SessionRuntimeAuthInput,
    promptOverride?: string,
  ): Promise<{ id: string } | null> => {
    const prompt = promptOverride?.trim() || task.prompt;
    if (!prompt) return null;

    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: task.id,
        worktree_name: worktreeName,
        worktree_path: worktreePath,
        branch_name: branchName,
        prompt,
        ...agentConfig,
      }),
    });

    if (res.ok) {
      const session = await res.json();
      return { id: session.id };
    }
    return null;
  };

  if (loading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-2">
        {COLUMNS.map((column) => (
          <Skeleton key={column.id} className="h-[400px] min-w-[240px] flex-1 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link href="/reports">
            <FileText className="h-4 w-4" />
            Reports
          </Link>
        </Button>
        <CreateTaskDialog onSubmit={createTask} />
      </div>
      <DragDropContext onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-2">
          {COLUMNS.map((column) =>
            column.type === "group" ? (
              <KanbanGroupedColumn
                key={column.id}
                label={column.label}
                sections={column.statuses.map((status) => ({
                  status,
                  tasks: tasksByStatus(status),
                }))}
                taskSessions={taskSessions}
                onDeleteTask={deleteTask}
                onClickTask={handleClickTask}
                onExecuteTask={handleExecuteTask}
                onPauseTask={handlePauseTask}
              />
            ) : (
              <KanbanColumn
                key={column.id}
                status={column.status}
                tasks={tasksByStatus(column.status)}
                taskSessions={taskSessions}
                onDeleteTask={deleteTask}
                onClickTask={handleClickTask}
                onExecuteTask={handleExecuteTask}
                onPauseTask={handlePauseTask}
              />
            ),
          )}
        </div>
      </DragDropContext>

      <TaskDetailDialog
        task={selectedTask}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onUpdate={handleUpdateTask}
        onLaunchSession={handleLaunchSession}
        onRefresh={refresh}
      />
    </div>
  );
}
