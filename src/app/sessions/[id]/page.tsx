"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  isInteractiveSessionStatus,
  SessionChat,
} from "@/components/sessions/session-chat";
import { AgentExecutionBadges } from "@/components/sessions/agent-selector";
import { SessionVcc } from "@/components/sessions/session-vcc";
import { ProcessIndicator } from "@/components/sessions/process-indicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { parseGateStatus } from "@/core/control-plane-state";
import {
  ArrowLeft,
  Square,
  Trash2,
  GitBranch,
  MessageSquare,
  Eye,
} from "lucide-react";
import { cn } from "@/core/dashboard-utils";
import type { Session } from "@/core/types-dashboard";

type DetailTab = "chat" | "observe";

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<DetailTab>("chat");

  useEffect(() => {
    const fetchSession = () => {
      fetch(`/api/sessions/${params.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then(setSession);
    };
    fetchSession();
    const interval = setInterval(fetchSession, 5000);
    return () => clearInterval(interval);
  }, [params.id]);

  const handleKill = async () => {
    await fetch(`/api/sessions/${params.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "kill" }),
    });
  };

  const handleDelete = async () => {
    await fetch(`/api/sessions/${params.id}`, { method: "DELETE" });
    router.push("/sessions");
  };

  if (!session) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-120px)]">
        <div className="flex items-center gap-2 text-muted-foreground">
          <div className="h-4 w-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading session...</span>
        </div>
      </div>
    );
  }

  const isActive = isInteractiveSessionStatus(session.status);
  const gateStatus = parseGateStatus(session.gate_status);
  const isEnded =
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "killed";

  return (
    <div className="flex flex-col h-[calc(100vh-120px)] gap-2">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => router.push("/sessions")}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium truncate">
            {session.prompt?.slice(0, 120) ?? session.id}
          </h2>
          <div className="flex items-center gap-2 mt-0.5">
            <ProcessIndicator
              status={session.status}
              currentStage={session.current_stage}
              gateStatus={gateStatus}
            />
            <span className="text-[10px] text-muted-foreground">
              AI task run
            </span>
            {session.worktree_name && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <GitBranch className="h-3 w-3" />
                <span>{session.worktree_name}</span>
              </div>
            )}
            {session.branch_name && (
              <Badge variant="secondary" className="text-[10px]">
                {session.branch_name}
              </Badge>
            )}
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
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-0.5 bg-muted rounded-md p-0.5">
          <Button
            variant={tab === "chat" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setTab("chat")}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Instruct
          </Button>
          <Button
            variant={tab === "observe" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setTab("observe")}
          >
            <Eye className="h-3.5 w-3.5" />
            Process
          </Button>
        </div>

        <div className="flex items-center gap-1">
          {isActive && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={handleKill}
            >
              <Square className="h-4 w-4" />
            </Button>
          )}
          {isEnded && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Tab content */}
      <div className={cn("flex-1 min-h-0", tab !== "chat" && "hidden")}>
        <SessionChat
          sessionId={params.id}
          isActive={isActive}
          sessionRuntime={session}
        />
      </div>
      <div className={cn("flex-1 min-h-0", tab !== "observe" && "hidden")}>
        <SessionVcc sessionId={params.id} isActive={isActive} />
      </div>
    </div>
  );
}
