"use client";

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProcessIndicator } from "./process-indicator";
import { AgentExecutionBadges } from "./agent-selector";
import {
  Square,
  Trash2,
  GitBranch,
  MessageSquare,
  Clock,
} from "lucide-react";
import { parseGateStatus } from "@/core/control-plane-state";
import { isActiveSessionStatus } from "@/core/task-readiness";
import type { Session } from "@/core/types-dashboard";

interface SessionCardProps {
  session: Session;
  onControl: (id: string, action: "kill" | "end") => void;
  onDelete: (id: string) => void;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function SessionCard({
  session,
  onControl,
  onDelete,
}: SessionCardProps) {
  const isActive = isActiveSessionStatus(session.status);
  const gateStatus = parseGateStatus(session.gate_status);

  return (
    <Card className="group hover:border-primary/30 transition-colors">
      <CardContent className="p-4 space-y-3">
        {/* Top row: status + time */}
        <div className="flex items-center justify-between">
          <ProcessIndicator
            status={session.status}
            currentStage={session.current_stage}
            gateStatus={gateStatus}
          />
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{timeAgo(session.started_at)}</span>
          </div>
        </div>

        {/* Prompt as title - clickable to open session */}
        <Link href={`/sessions/${session.id}`} className="block">
          <p className="text-sm font-medium leading-snug hover:underline cursor-pointer line-clamp-2">
            {session.prompt || session.id.slice(0, 16)}
          </p>
        </Link>

        {/* Branch info */}
        {session.worktree_name && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            <span className="truncate">{session.worktree_name}</span>
            {session.branch_name && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {session.branch_name}
              </Badge>
            )}
          </div>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
            <AgentExecutionBadges
              codingAgentId={session.coding_agent_id}
              agentTeamId={session.agent_team_id}
              sessionAuthMode={session.session_auth_mode}
              agentApiKeyEnvVar={session.agent_api_key_env_var}
              localCliAgentId={session.local_cli_agent_id}
              agentModel={session.agent_model}
              agentReasoning={session.agent_reasoning}
              agentApiProtocol={session.agent_api_protocol}
              agentApiVersion={session.agent_api_version}
              agentBaseUrl={session.agent_base_url}
              agentMaxTokens={session.agent_max_tokens}
            />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-1">
          <Link
            href={`/sessions/${session.id}`}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <MessageSquare className="h-3 w-3" />
            <span>Open task run</span>
          </Link>
          <div className="flex items-center gap-0.5">
            {isActive && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive"
                onClick={() => onControl(session.id, "kill")}
              >
                <Square className="h-3 w-3" />
              </Button>
            )}
            {!isActive && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(session.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
