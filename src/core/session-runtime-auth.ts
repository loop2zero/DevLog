import {
  API_PROTOCOL_LABELS,
  API_PROTOCOL_OPTIONS,
  DEFAULT_API_PROTOCOL,
  DEFAULT_API_AGENT_MODEL,
  DEFAULT_BASE_URL_BY_PROTOCOL,
  DEFAULT_MODEL_BY_PROTOCOL,
  SUGGESTED_MODELS_BY_PROTOCOL,
  normalizeLocalCliAgentEnv,
  MAX_AGENT_BASE_URL_LENGTH,
  MAX_AGENT_MODEL_ID_LENGTH,
  MAX_AGENT_SETTING_VALUE_LENGTH,
  MAX_ANTHROPIC_API_KEY_LENGTH,
  DEFAULT_API_MAX_TOKENS,
  sanitizeAgentModelId,
  sanitizeApiMaxTokens,
  type ApiProtocol,
} from "./agent-settings";
import {
  DEFAULT_LOCAL_CLI_AGENT_ID,
  DEFAULT_LOCAL_CLI_MODEL,
  DEFAULT_LOCAL_CLI_REASONING,
  LOCAL_CLI_AGENT_DEFINITIONS,
  LOCAL_CLI_AGENT_IDS,
} from "./local-cli-agent-definitions";

export type SessionRuntimeAuthMode = "local-cli" | "anthropic-api-key";
export type LegacySessionRuntimeAuthMode = "backend-oauth" | "agent-api-key";
export type SessionRuntimeAuthModeValue =
  | SessionRuntimeAuthMode
  | LegacySessionRuntimeAuthMode;

export interface SessionRuntimeAuthOption {
  id: SessionRuntimeAuthMode;
  label: string;
  description: string;
}

export interface SessionRuntimeAuthInput {
  session_auth_mode?: string | null;
  agent_api_key_env_var?: string | null;
  local_cli_agent_id?: string | null;
  agent_model?: string | null;
  agent_reasoning?: string | null;
  agent_api_protocol?: string | null;
  agent_api_version?: string | null;
  agent_base_url?: string | null;
  agent_max_tokens?: number | string | null;
  anthropic_api_key?: string | null;
  local_cli_agent_env?: unknown;
  unattended?: boolean;
}

export interface SessionRuntimeAuthConfig {
  mode: SessionRuntimeAuthMode;
  label: string;
  agentApiKeyEnvVar: string | null;
  localCliAgentId: string;
  localCliAgentName: string;
  localCliAgentEnv: Record<string, string>;
  apiProtocol: ApiProtocol;
  apiVersion: string;
  model: string;
  reasoning: string;
  baseUrl: string | null;
  maxTokens: number;
  anthropicApiKey: string | null;
  usesLegacyEnvVar: boolean;
  unattended: boolean;
}

export const DEFAULT_SESSION_AUTH_MODE: SessionRuntimeAuthMode =
  "local-cli";
export const DEFAULT_AGENT_API_KEY_ENV_VAR = "ANTHROPIC_API_KEY";
export const DEFAULT_AGENT_MODEL = DEFAULT_LOCAL_CLI_MODEL.id;

export const SESSION_RUNTIME_AUTH_OPTIONS: SessionRuntimeAuthOption[] = [
  {
    id: "local-cli",
    label: "Local code-agent CLI",
    description: "Use a locally authenticated code-agent CLI.",
  },
  {
    id: "anthropic-api-key",
    label: "API (BYOK)",
    description:
      "Use a browser-stored Anthropic-compatible API key for this agent run.",
  },
];

const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const API_PROTOCOL_IDS = new Set<ApiProtocol>(
  API_PROTOCOL_OPTIONS.map((protocol) => protocol.id),
);
const MODEL_IDS_BY_PROTOCOL = new Map(
  API_PROTOCOL_OPTIONS.map((protocol) => [
    protocol.id,
    new Set(SUGGESTED_MODELS_BY_PROTOCOL[protocol.id]),
  ]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeEnvVarName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || !ENV_VAR_RE.test(trimmed)) {
    return DEFAULT_AGENT_API_KEY_ENV_VAR;
  }
  return trimmed;
}

export function getSessionRuntimeAuthInputFromPayload(
  payload: unknown,
): SessionRuntimeAuthInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const rawMaxTokens = record.agent_max_tokens;
  return {
    session_auth_mode:
      typeof record.session_auth_mode === "string"
        ? record.session_auth_mode
        : null,
    agent_api_key_env_var:
      typeof record.agent_api_key_env_var === "string"
        ? record.agent_api_key_env_var
        : null,
    local_cli_agent_id:
      typeof record.local_cli_agent_id === "string"
        ? record.local_cli_agent_id
        : null,
    agent_model:
      typeof record.agent_model === "string" ? record.agent_model : null,
    agent_reasoning:
      typeof record.agent_reasoning === "string"
        ? record.agent_reasoning
        : null,
    agent_api_protocol:
      typeof record.agent_api_protocol === "string"
        ? record.agent_api_protocol
        : null,
    agent_api_version:
      typeof record.agent_api_version === "string"
        ? record.agent_api_version
        : null,
    agent_base_url:
      typeof record.agent_base_url === "string"
        ? record.agent_base_url
        : null,
    agent_max_tokens:
      typeof rawMaxTokens === "number" ||
      (typeof rawMaxTokens === "string" &&
        rawMaxTokens.trim() &&
        Number.isFinite(Number(rawMaxTokens.trim())))
        ? rawMaxTokens
        : null,
    anthropic_api_key:
      typeof record.anthropic_api_key === "string"
        ? record.anthropic_api_key
        : null,
    local_cli_agent_env: isRecord(record.local_cli_agent_env)
      ? record.local_cli_agent_env
      : null,
    ...(typeof record.unattended === "boolean"
      ? { unattended: record.unattended }
      : {}),
  };
}

function normalizeRuntimeMode(
  mode: string | null | undefined,
): { mode: SessionRuntimeAuthMode; legacyEnvVar: boolean } {
  if (mode === "anthropic-api-key") {
    return { mode: "anthropic-api-key", legacyEnvVar: false };
  }
  if (mode === "agent-api-key") {
    return { mode: "anthropic-api-key", legacyEnvVar: true };
  }
  return { mode: DEFAULT_SESSION_AUTH_MODE, legacyEnvVar: false };
}

function findLocalCliAgent(agentId: string) {
  return (
    LOCAL_CLI_AGENT_DEFINITIONS.find((agent) => agent.id === agentId) ??
    LOCAL_CLI_AGENT_DEFINITIONS[0]
  );
}

function sanitizeLocalCliAgentId(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && LOCAL_CLI_AGENT_IDS.has(trimmed)
    ? trimmed
    : DEFAULT_LOCAL_CLI_AGENT_ID;
}

function sanitizeApiProtocol(value: string | null | undefined): ApiProtocol {
  const trimmed = value?.trim();
  return trimmed && API_PROTOCOL_IDS.has(trimmed as ApiProtocol)
    ? (trimmed as ApiProtocol)
    : DEFAULT_API_PROTOCOL;
}

function sanitizeApiVersion(value: string | null | undefined): string {
  return value?.trim().slice(0, MAX_AGENT_SETTING_VALUE_LENGTH) ?? "";
}

function sanitizeModel(
  value: string | null | undefined,
  mode: SessionRuntimeAuthMode,
  apiProtocol: ApiProtocol,
  localCliAgentId: string,
  localCliAgentValid: boolean,
): string {
  const trimmed = value?.trim().slice(0, MAX_AGENT_MODEL_ID_LENGTH);
  if (!trimmed) {
    return mode === "anthropic-api-key"
      ? DEFAULT_MODEL_BY_PROTOCOL[apiProtocol] ?? DEFAULT_API_AGENT_MODEL
      : DEFAULT_AGENT_MODEL;
  }

  if (mode === "anthropic-api-key") {
    return MODEL_IDS_BY_PROTOCOL.get(apiProtocol)?.has(trimmed)
      ? trimmed
      : sanitizeAgentModelId(
          trimmed,
          DEFAULT_MODEL_BY_PROTOCOL[apiProtocol] ?? DEFAULT_API_AGENT_MODEL,
        );
  }

  if (!localCliAgentValid) {
    return DEFAULT_AGENT_MODEL;
  }

  const localCliAgent = findLocalCliAgent(localCliAgentId);
  const localModelIds = new Set(localCliAgent.models.map((model) => model.id));
  return localModelIds.has(trimmed)
    ? trimmed
    : sanitizeAgentModelId(trimmed, DEFAULT_AGENT_MODEL);
}

function sanitizeBaseUrl(
  value: string | null | undefined,
  protocol: ApiProtocol,
): string {
  const trimmed = value?.trim().slice(0, MAX_AGENT_BASE_URL_LENGTH);
  if (!trimmed) {
    return DEFAULT_BASE_URL_BY_PROTOCOL[protocol];
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_BASE_URL_BY_PROTOCOL[protocol];
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_BASE_URL_BY_PROTOCOL[protocol];
  }
}

function sanitizeReasoning(
  value: string | null | undefined,
  localCliAgentId: string,
  localCliAgentValid = true,
): string {
  if (!localCliAgentValid) {
    return DEFAULT_LOCAL_CLI_REASONING;
  }
  const localCliAgent = findLocalCliAgent(localCliAgentId);
  const reasoningOptions = localCliAgent.reasoningOptions ?? [
    { id: DEFAULT_LOCAL_CLI_REASONING, label: "Default" },
  ];
  const reasoningIds = new Set(reasoningOptions.map((option) => option.id));
  const trimmed = value?.trim().slice(0, MAX_AGENT_SETTING_VALUE_LENGTH);
  return trimmed && reasoningIds.has(trimmed)
    ? trimmed
    : DEFAULT_LOCAL_CLI_REASONING;
}

function sanitizeApiKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAX_ANTHROPIC_API_KEY_LENGTH) : null;
}

export function resolveSessionRuntimeAuthConfig(
  input: SessionRuntimeAuthInput = {},
): SessionRuntimeAuthConfig {
  const { mode, legacyEnvVar } = normalizeRuntimeMode(input.session_auth_mode);
  const apiProtocol =
    mode === "anthropic-api-key"
      ? sanitizeApiProtocol(input.agent_api_protocol)
      : DEFAULT_API_PROTOCOL;
  const apiVersion =
    mode === "anthropic-api-key"
      ? sanitizeApiVersion(input.agent_api_version)
      : "";
  const localCliAgentId = sanitizeLocalCliAgentId(input.local_cli_agent_id);
  const localCliAgentValid =
    mode !== "local-cli" ||
    !input.local_cli_agent_id ||
    !input.local_cli_agent_id.trim() ||
    input.local_cli_agent_id.trim() === localCliAgentId;
  const localCliAgent = findLocalCliAgent(localCliAgentId);
  const localCliAgentEnv =
    mode === "local-cli"
      ? normalizeLocalCliAgentEnv({
          [localCliAgentId]: isRecord(input.local_cli_agent_env)
            ? input.local_cli_agent_env
            : {},
        })[localCliAgentId] ?? {}
      : {};
  const option =
    SESSION_RUNTIME_AUTH_OPTIONS.find((candidate) => candidate.id === mode) ??
    SESSION_RUNTIME_AUTH_OPTIONS[0];

  return {
    mode,
    label: option.label,
    localCliAgentId,
    localCliAgentName: localCliAgent.name,
    localCliAgentEnv,
    apiProtocol,
    apiVersion,
    model: sanitizeModel(
      input.agent_model,
      mode,
      apiProtocol,
      localCliAgentId,
      localCliAgentValid,
    ),
    reasoning: sanitizeReasoning(
      input.agent_reasoning,
      localCliAgentId,
      localCliAgentValid,
    ),
    baseUrl:
      mode === "anthropic-api-key"
        ? sanitizeBaseUrl(input.agent_base_url, apiProtocol)
        : null,
    maxTokens:
      mode === "anthropic-api-key"
        ? sanitizeApiMaxTokens(input.agent_max_tokens)
        : DEFAULT_API_MAX_TOKENS,
    anthropicApiKey:
      mode === "anthropic-api-key" && !legacyEnvVar
        ? sanitizeApiKey(input.anthropic_api_key)
        : null,
    agentApiKeyEnvVar:
      mode === "anthropic-api-key" && legacyEnvVar
        ? sanitizeEnvVarName(input.agent_api_key_env_var)
        : null,
    usesLegacyEnvVar: legacyEnvVar,
    unattended: input.unattended === true,
  };
}

export function resolveStoredSessionRuntimeAuthConfig(
  stored: SessionRuntimeAuthInput = {},
  transientInput: SessionRuntimeAuthInput = {},
): SessionRuntimeAuthConfig {
  const {
    anthropic_api_key: _storedApiKey,
    local_cli_agent_env: _storedLocalCliEnv,
    ...persistedInput
  } = stored;

  return resolveSessionRuntimeAuthConfig({
    ...persistedInput,
    anthropic_api_key: transientInput.anthropic_api_key,
    local_cli_agent_env: transientInput.local_cli_agent_env,
  });
}

export function buildSessionRuntimeAuthInstructions(
  config: SessionRuntimeAuthConfig,
): string {
  if (config.usesLegacyEnvVar) {
    return `Runtime execution: ${API_PROTOCOL_LABELS[config.apiProtocol]} key from backend env ${config.agentApiKeyEnvVar}; model ${config.model}; base URL ${config.baseUrl ?? DEFAULT_BASE_URL_BY_PROTOCOL[config.apiProtocol]}; max output ${config.maxTokens} tokens.`;
  }

  if (config.mode === "anthropic-api-key") {
    const versionText = config.apiVersion
      ? `; API version ${config.apiVersion}`
      : "";
    return `Runtime execution: API (BYOK, ${API_PROTOCOL_LABELS[config.apiProtocol]}); model ${config.model}; base URL ${config.baseUrl ?? DEFAULT_BASE_URL_BY_PROTOCOL[config.apiProtocol]}${versionText}; max output ${config.maxTokens} tokens. The API key is provided transiently from the browser and is not stored by DevLog.`;
  }

  const modelText =
    config.model === DEFAULT_LOCAL_CLI_MODEL.id
      ? "model from CLI config"
      : `model ${config.model}`;
  const reasoningText =
    config.reasoning === DEFAULT_LOCAL_CLI_REASONING
      ? ""
      : `; reasoning ${config.reasoning}`;
  return `Runtime execution: Local code-agent CLI (${config.localCliAgentName}); ${modelText}${reasoningText}.`;
}

export function getPersistedSessionBaseUrl(
  config: SessionRuntimeAuthConfig,
): string {
  return config.baseUrl ?? DEFAULT_BASE_URL_BY_PROTOCOL[config.apiProtocol];
}

export function buildClaudeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  config: SessionRuntimeAuthConfig,
):
  | { ok: true; env: NodeJS.ProcessEnv; error?: never }
  | { ok: false; env: NodeJS.ProcessEnv; error: string } {
  if (config.mode === "local-cli") {
    const env = {
      ...baseEnv,
      ...config.localCliAgentEnv,
    };
    if (config.localCliAgentId === "claude") {
      stripUnlessCustomBaseUrl(env, "ANTHROPIC_BASE_URL", [
        "ANTHROPIC_API_KEY",
      ]);
    }
    if (config.localCliAgentId === "codex") {
      stripUnlessCustomBaseUrl(env, "OPENAI_BASE_URL", [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
      ]);
    }
    return { ok: true, env };
  }

  if (!config.usesLegacyEnvVar) {
    if (config.apiProtocol !== "anthropic") {
      return {
        ok: false,
        env: baseEnv,
        error: `${API_PROTOCOL_LABELS[config.apiProtocol]} must use DevLog's direct provider runtime, not the Claude CLI environment bridge.`,
      };
    }
    if (!config.anthropicApiKey) {
      return {
        ok: false,
        env: baseEnv,
        error:
          "Anthropic API key is required for BYOK execution. Add it in Settings on this browser.",
      };
    }

    return {
      ok: true,
      env: {
        ...baseEnv,
        ANTHROPIC_API_KEY: config.anthropicApiKey,
        ...(config.baseUrl ? { ANTHROPIC_BASE_URL: config.baseUrl } : {}),
      },
    };
  }

  const envVar = config.agentApiKeyEnvVar ?? DEFAULT_AGENT_API_KEY_ENV_VAR;
  const key = baseEnv[envVar];
  if (!key) {
    return {
      ok: false,
      env: baseEnv,
      error: `Selected agent API key env var '${envVar}' is not set on the backend.`,
    };
  }

  return {
    ok: true,
    env: {
      ...baseEnv,
      ANTHROPIC_API_KEY: key,
    },
  };
}

function stripUnlessCustomBaseUrl(
  env: NodeJS.ProcessEnv,
  baseUrlKey: string,
  secretKeys: readonly string[],
): void {
  const baseUrlKeyUpper = baseUrlKey.toUpperCase();
  const hasCustomBaseUrl = Object.keys(env).some(
    (key) =>
      key.toUpperCase() === baseUrlKeyUpper &&
      typeof env[key] === "string" &&
      env[key]?.trim() !== "",
  );
  if (hasCustomBaseUrl) return;

  const secretKeysUpper = new Set(secretKeys.map((key) => key.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (secretKeysUpper.has(key.toUpperCase())) {
      delete env[key];
    }
  }
}
