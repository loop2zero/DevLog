"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Play,
  Save,
  ExternalLink,
  Clock,
  Loader2,
  GitBranch,
  Terminal,
  AlertCircle,
  Send,
} from "lucide-react";
import {
  DEFAULT_AGENT_TEAM_ID,
  DEFAULT_CODING_AGENT_ID,
} from "@/core/agent-presets";
import { AgentSelector } from "@/components/sessions/agent-selector";
import { useAgentSettings } from "@/hooks/use-agent-settings";
import { parseGateStatus } from "@/core/control-plane-state";
import { isTaskExecutableStatus } from "@/core/task-status-flow";
import type { SessionRuntimeAuthInput } from "@/core/session-runtime-auth";
import type { Task, TaskPriority, TaskStatus, Worktree } from "@/core/types-dashboard";
import { cn } from "@/core/dashboard-utils";
import { TaskReviewPanel } from "./task-review-panel";

const PRIORITY_COLORS: Record<string, string> = {
  low: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  medium: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  high: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  in_queue: "Queued",
  in_progress: "In Progress",
  review: "Review",
  blocked: "Blocked",
  fail: "Failed",
  done: "Done",
};

interface TaskDetailDialogProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: (id: string, data: Partial<Task>) => Promise<void>;
  onLaunchSession: (
    task: Task,
    worktreePath: string,
    worktreeName?: string,
    branchName?: string,
    agentConfig?: {
      coding_agent_id: string;
      agent_team_id: string;
    } & SessionRuntimeAuthInput,
    promptOverride?: string,
  ) => Promise<{ id: string } | null>;
  onRefresh?: () => Promise<void>;
}

export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onUpdate,
  onLaunchSession,
  onRefresh,
}: TaskDetailDialogProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState("");
  const [codingAgentId, setCodingAgentId] = useState(DEFAULT_CODING_AGENT_ID);
  const [agentTeamId, setAgentTeamId] = useState(DEFAULT_AGENT_TEAM_ID);
  const [gateResponse, setGateResponse] = useState("");
  const [resolvingGate, setResolvingGate] = useState(false);
  const [resolvedGateId, setResolvedGateId] = useState<string | null>(null);
  const { settings, runtimePayload, byokReady, loaded, settingsReady } =
    useAgentSettings();

  // Reset form when task changes
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? "");
      setPriority(task.priority);
      setPrompt(task.prompt ?? "");
      setEditing(false);
      setGateResponse("");
      setResolvingGate(false);
      setResolvedGateId(null);
    }
  }, [task]);

  // Load worktrees when dialog opens (for launching session)
  useEffect(() => {
    if (open) {
      fetch("/api/worktrees")
        .then((r) => (r.ok ? r.json() : []))
        .then((wts: Worktree[]) => {
          setWorktrees(wts);
          const main = wts.find((w: Worktree) => w.isMain);
          if (main) setSelectedWorktree(main.name);
          else if (wts.length > 0) setSelectedWorktree(wts[0].name);
        });
    }
  }, [open]);

  if (!task) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(task.id, {
        title: title.trim(),
        description: description.trim() || null,
        priority,
        prompt: prompt.trim() || null,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleLaunch = async () => {
    if (!settingsReady) return;

    const taskPrompt = prompt.trim() || task.prompt;
    if (!taskPrompt) return;

    const wt = worktrees.find((w) => w.name === selectedWorktree);
    const mainWt = worktrees.find((w) => w.isMain);
    const worktreePath = wt?.path ?? mainWt?.path;
    if (!worktreePath) return;

    setLaunching(true);
    try {
      const session = await onLaunchSession(
        task,
        worktreePath,
        wt?.name,
        wt?.branch,
        {
          coding_agent_id: codingAgentId,
          agent_team_id: agentTeamId,
          ...runtimePayload,
        },
        taskPrompt,
      );
      if (session?.id) {
        onOpenChange(false);
        router.push(`/sessions/${session.id}`);
      }
    } finally {
      setLaunching(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    return new Date(dateStr).toLocaleString();
  };
  const canLaunchSession = isTaskExecutableStatus(task.status);
  const parsedGateStatus = parseGateStatus(task.gate_status);
  const gateStatus =
    parsedGateStatus?.id === resolvedGateId ? null : parsedGateStatus;
  const currentStage = task.current_stage ?? gateStatus?.stage ?? null;

  const handleResolveGate = async (response: string) => {
    const trimmed = response.trim();
    if (!task.session_id || !gateStatus || !trimmed) return;

    setResolvingGate(true);
    try {
      const res = await fetch(`/api/sessions/${task.session_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve_gate", response: trimmed }),
      });
      if (!res.ok) return;
      setResolvedGateId(gateStatus.id);
      setGateResponse("");
      await onRefresh?.();
    } finally {
      setResolvingGate(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[580px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={cn("text-[10px] px-1.5 py-0", PRIORITY_COLORS[task.priority])}
            >
              {task.priority}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {STATUS_LABELS[task.status]}
            </Badge>
            <DialogTitle className="sr-only">Task Detail</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          {editing ? (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Title</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="text-base font-medium"
              />
            </div>
          ) : (
            <h2
              className="text-base font-medium cursor-pointer hover:text-primary transition-colors"
              onClick={() => setEditing(true)}
            >
              {task.title}
            </h2>
          )}

          {/* Description */}
          {editing ? (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Task description..."
                rows={3}
                className="resize-none"
              />
            </div>
          ) : (
            <div
              className="cursor-pointer hover:bg-muted/50 rounded-md p-2 -m-2 transition-colors"
              onClick={() => setEditing(true)}
            >
              {task.description ? (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {task.description}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic">
                  Click to add description...
                </p>
              )}
            </div>
          )}

          {/* Priority (edit mode) */}
          {editing && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Prompt */}
          {editing ? (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Agent Prompt</Label>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Prompt for the selected coding agent..."
                rows={4}
                className="resize-none font-mono text-xs"
              />
            </div>
          ) : task.prompt ? (
            <div
              className="cursor-pointer hover:bg-muted/50 rounded-md p-2 -m-2 transition-colors"
              onClick={() => setEditing(true)}
            >
              <Label className="text-xs text-muted-foreground mb-1 block">Prompt</Label>
              <p className="text-xs font-mono bg-muted/30 rounded p-2 whitespace-pre-wrap">
                {task.prompt}
              </p>
            </div>
          ) : null}

          {/* Edit actions */}
          {editing && (
            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={!title.trim() || saving} size="sm">
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1" />
                )}
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTitle(task.title);
                  setDescription(task.description ?? "");
                  setPriority(task.priority);
                  setPrompt(task.prompt ?? "");
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          )}

          {!editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)} className="text-xs text-muted-foreground">
              Edit task...
            </Button>
          )}

          {task.status === "fail" && task.fail_reason && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-pre-wrap">{task.fail_reason}</span>
            </div>
          )}

          {currentStage && (
            <div className="rounded-md border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
              {currentStage}
            </div>
          )}

          {gateStatus && (
            <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                <div className="min-w-0 space-y-1">
                  <Badge
                    variant="outline"
                    className="border-amber-500/40 bg-background/70 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                  >
                    needs-input
                  </Badge>
                  <p className="text-sm font-medium leading-snug">
                    {gateStatus.question}
                  </p>
                </div>
              </div>
              {gateStatus.options.length > 0 ? (
                <div className="flex flex-wrap gap-2 pl-6">
                  {gateStatus.options.map((option) => (
                    <Button
                      key={option}
                      size="xs"
                      disabled={resolvingGate || !task.session_id}
                      onClick={() => handleResolveGate(option)}
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              ) : (
                <div className="flex gap-2 pl-6">
                  <Input
                    value={gateResponse}
                    onChange={(event) => setGateResponse(event.target.value)}
                    disabled={resolvingGate || !task.session_id}
                    className="h-8 text-xs"
                  />
                  <Button
                    size="icon-sm"
                    disabled={resolvingGate || !task.session_id || !gateResponse.trim()}
                    onClick={() => handleResolveGate(gateResponse)}
                    aria-label="Resolve gate"
                  >
                    {resolvingGate ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Metadata */}
          <div className="border-t pt-3 space-y-2">
            {task.worktree_name && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <GitBranch className="h-3 w-3" />
                <span>{task.worktree_name}</span>
              </div>
            )}
            {task.session_id && (
              <div className="flex items-center gap-1.5 text-xs">
                <Terminal className="h-3 w-3 text-muted-foreground" />
                <button
                  className="text-primary hover:underline"
                  onClick={() => {
                    onOpenChange(false);
                    router.push(`/sessions/${task.session_id}`);
                  }}
                >
                  View session
                  <ExternalLink className="h-2.5 w-2.5 ml-0.5 inline" />
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Created {formatDate(task.created_at)}</span>
            </div>
            {task.completed_at && (
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>Completed {formatDate(task.completed_at)}</span>
              </div>
            )}
          </div>

          {/* Launch session */}
          {canLaunchSession && (
            <div className="border-t pt-3 space-y-3">
              <Label className="text-xs text-muted-foreground">Launch Session from Task</Label>
              {worktrees.length > 1 && (
                <Select value={selectedWorktree} onValueChange={setSelectedWorktree}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select worktree" />
                  </SelectTrigger>
                  <SelectContent>
                    {worktrees.map((wt) => (
                      <SelectItem key={wt.name} value={wt.name}>
                        {wt.name}
                        <span className="ml-1.5 text-muted-foreground">({wt.branch})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <AgentSelector
                codingAgentId={codingAgentId}
                agentTeamId={agentTeamId}
                runtimeSettings={settings}
                onCodingAgentChange={setCodingAgentId}
                onAgentTeamChange={setAgentTeamId}
              />
              <Button
                onClick={handleLaunch}
                disabled={
                  launching || !(prompt.trim() || task.prompt) || !settingsReady
                }
                size="sm"
                className="w-full"
              >
                {launching ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    Launching...
                  </>
                ) : !loaded ? (
                  <>Loading Settings...</>
                ) : !byokReady ? (
                  <>Add API key in Settings</>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5 mr-1" />
                    Launch Session
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Review panel (when task is in review or blocked) */}
          {(task.status === "review" || task.status === "blocked") && (
            <TaskReviewPanel task={task} onUpdate={onUpdate} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
