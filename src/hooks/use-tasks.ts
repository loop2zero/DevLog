"use client";

import { useState, useEffect, useCallback } from "react";
import type { Task, TaskStatus, TaskPriority, Session } from "@/core/types-dashboard";
import type { SessionRuntimeAuthInput } from "@/core/session-runtime-auth";
import type { ChatStreamEvent } from "@/core/stream-manager";

function shouldRefreshTasksForEvent(event: ChatStreamEvent): boolean {
  return (
    event.type === "control_plane_stage" ||
    event.type === "control_plane_gate" ||
    event.type === "control_plane_gate_resolved"
  );
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (res.ok) {
        setTasks(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const interval = setInterval(fetchTasks, 5000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  useEffect(() => {
    const source = new EventSource("/api/devlog/stream");
    source.onmessage = (message) => {
      let event: ChatStreamEvent;
      try {
        event = JSON.parse(message.data) as ChatStreamEvent;
      } catch {
        return;
      }
      if (shouldRefreshTasksForEvent(event)) {
        fetchTasks();
      }
    };

    return () => {
      source.close();
    };
  }, [fetchTasks]);

  const createTask = async (data: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    worktree_name?: string;
    prompt?: string;
  }) => {
    const res = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      await fetchTasks();
      return (await res.json()) as Task;
    }
    return null;
  };

  const updateTask = async (id: string, data: Partial<Task>) => {
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      await fetchTasks();
    }
  };

  const deleteTask = async (id: string) => {
    const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (res.ok) {
      await fetchTasks();
    }
  };

  const reorder = async (
    items: { id: string; status: TaskStatus; sort_order: number }[]
  ) => {
    await fetch("/api/tasks/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    await fetchTasks();
  };

  const tasksByStatus = (status: TaskStatus) =>
    tasks.filter((t) => t.status === status).sort((a, b) => a.sort_order - b.sort_order);

  const executeTask = async (
    id: string,
    agentConfig?: {
      coding_agent_id?: string;
      agent_team_id?: string;
    } & SessionRuntimeAuthInput
  ): Promise<{ session: Session } | null> => {
    const res = await fetch(`/api/tasks/${id}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agentConfig ?? {}),
    });
    if (res.ok) {
      await fetchTasks();
      return await res.json();
    }
    return null;
  };

  return {
    tasks,
    loading,
    createTask,
    updateTask,
    deleteTask,
    reorder,
    executeTask,
    tasksByStatus,
    refresh: fetchTasks,
  };
}
