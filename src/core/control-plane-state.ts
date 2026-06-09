import type { GateStatus } from "./types-dashboard";

export function parseGateStatus(
  value: string | null | undefined,
): GateStatus | null {
  if (!value) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const id = readString(parsed.id);
  const question = readString(parsed.question);
  if (!id || !question) return null;

  return {
    id,
    question,
    options: Array.isArray(parsed.options)
      ? parsed.options
          .map((option) => (typeof option === "string" ? option.trim() : ""))
          .filter(Boolean)
      : [],
    created_at: readString(parsed.created_at) ?? "",
    stage: readString(parsed.stage),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
