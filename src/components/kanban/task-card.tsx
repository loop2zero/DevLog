"use client";

import { useRouter } from "next/navigation";
import { Draggable } from "@hello-pangea/dnd";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Trash2, GitBranch, Terminal, ChevronRight, Pause, Play, AlertCircle, Milestone } from "lucide-react";
import { canExecuteTaskFromCard, canPauseTaskFromCard } from "./task-card-actions";
import { isActiveSessionStatus } from "@/core/task-readiness";
import { parseGateStatus } from "@/core/control-plane-state";
import type { Task, Session } from "@/core/types-dashboard";
import { cn } from "@/core/dashboard-utils";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  medium: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
};

const SESSION_DOT: Record<string, string> = {
  running: "bg-green-500 animate-pulse",
  idle: "bg-blue-400",
  pending: "bg-yellow-400",
  paused: "bg-yellow-500",
  completed: "bg-slate-400",
  failed: "bg-red-500",
  killed: "bg-red-400",
};

interface TaskCardProps {
  task: Task;
  index: number;
  session?: Session;
  onDelete: (id: string) => void;
  onClick: (task: Task) => void;
  onExecute?: (id: string) => void;
  onPause?: (sessionId: string) => void;
}

export function TaskCard({ task, index, session, onDelete, onClick, onExecute, onPause }: TaskCardProps) {
  const router = useRouter();
  const isLive = isActiveSessionStatus(session?.status);
  const canExecute = !!onExecute && canExecuteTaskFromCard(task, session);
  const canPause = !!onPause && canPauseTaskFromCard(task, session);
  const gateStatus = parseGateStatus(task.gate_status ?? session?.gate_status);
  const currentStage = task.current_stage ?? session?.current_stage ?? null;

  return (
    <Draggable draggableId={task.id} index={index}>
      {(provided, snapshot) => (
        <Card
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={cn(
            "p-3 space-y-2 cursor-grab active:cursor-grabbing hover:border-primary/30 transition-colors",
            snapshot.isDragging && "ring-2 ring-primary shadow-lg"
          )}
          onClick={() => onClick(task)}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-medium leading-tight flex-1">
              {task.title}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
              {canExecute && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-green-600 hover:text-green-500"
                  onClick={(e) => {
                    e.stopPropagation();
                    onExecute(task.id);
                  }}
                  title="Launch agent"
                >
                  <Play className="h-3 w-3" />
                </Button>
              )}
              {canPause && session && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-amber-500 hover:text-amber-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPause(session.id);
                  }}
                  title="Pause session"
                >
                  <Pause className="h-3 w-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(task.id);
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            </div>
          </div>
          {task.description && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {task.description}
            </p>
          )}
          {currentStage && (
            <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Milestone className="h-3 w-3 shrink-0 text-primary/70" />
              <span className="truncate">{currentStage}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {gateStatus && (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
              >
                <AlertCircle className="h-2.5 w-2.5" />
                needs-input
              </Badge>
            )}
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0", PRIORITY_COLORS[task.priority])}
            >
              {task.priority}
            </Badge>
            {task.worktree_name && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5">
                <GitBranch className="h-2.5 w-2.5" />
                {task.worktree_name}
              </Badge>
            )}
            {session && isLive && (
              <button
                className="flex items-center gap-1 rounded-sm px-1.5 py-0 border text-[10px] bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  router.push(`/sessions/${session.id}`);
                }}
                title={`${session.status} · ${dayjs(session.started_at).fromNow(true)}`}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    SESSION_DOT[session.status] ?? "bg-slate-400"
                  )}
                />
                <Terminal className="h-2.5 w-2.5" />
                {dayjs(session.started_at).fromNow(true)}
              </button>
            )}
            {!isLive && task.session_id && !session && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5">
                <Terminal className="h-2.5 w-2.5" />
                session
              </Badge>
            )}
            {task.prompt && !task.session_id && !session && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground border-dashed">
                has prompt
              </Badge>
            )}
          </div>
        </Card>
      )}
    </Draggable>
  );
}
