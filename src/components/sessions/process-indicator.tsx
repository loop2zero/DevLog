"use client";

import { AlertCircle, Milestone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/core/dashboard-utils";
import type { GateStatus, SessionStatus } from "@/core/types-dashboard";

const STATUS_CONFIG: Record<SessionStatus, { color: string; label: string; pulse: boolean }> = {
  pending: { color: "bg-yellow-500", label: "Pending", pulse: true },
  running: { color: "bg-green-500", label: "Working", pulse: true },
  idle: { color: "bg-blue-500", label: "Ready", pulse: false },
  paused: { color: "bg-yellow-500", label: "Paused", pulse: false },
  completed: { color: "bg-gray-500", label: "Completed", pulse: false },
  failed: { color: "bg-red-500", label: "Failed", pulse: false },
  killed: { color: "bg-red-500", label: "Stopped", pulse: false },
};

interface ProcessIndicatorProps {
  status: SessionStatus;
  currentStage?: string | null;
  gateStatus?: GateStatus | null;
  className?: string;
}

export function ProcessIndicator({
  status,
  currentStage,
  gateStatus,
  className,
}: ProcessIndicatorProps) {
  const config = STATUS_CONFIG[status];

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="relative flex h-2 w-2 shrink-0">
          {config.pulse && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping",
                config.color
              )}
            />
          )}
          <span
            className={cn("relative inline-flex h-2 w-2 rounded-full", config.color)}
          />
        </span>
        <span className="text-xs text-muted-foreground">{config.label}</span>
        {gateStatus && (
          <Badge
            variant="outline"
            className="border-amber-500/40 bg-amber-500/15 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-300"
          >
            <AlertCircle className="h-2.5 w-2.5" />
            needs-input
          </Badge>
        )}
      </div>
      {currentStage && (
        <div className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Milestone className="h-3 w-3 shrink-0 text-primary/70" />
          <span className="truncate">{currentStage}</span>
        </div>
      )}
    </div>
  );
}
