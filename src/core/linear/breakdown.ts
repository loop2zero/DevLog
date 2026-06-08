export interface SubIssueSpec {
  title: string;
  description: string;
  labels: string[];
}

export interface BreakdownPlan {
  parentSummary: string;
  parentIdentifier?: string;
  subIssues: SubIssueSpec[];
}

export type ParseResult = { ok: true; plan: BreakdownPlan } | { ok: false; error: string };

export function parseBreakdown(raw: string): ParseResult {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "breakdown.json is not valid JSON" };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "breakdown.json must be an object" };
  if (!Array.isArray(data.subIssues) || data.subIssues.length === 0) {
    return { ok: false, error: "breakdown.json needs a non-empty subIssues array" };
  }
  const subIssues: SubIssueSpec[] = [];
  for (let i = 0; i < data.subIssues.length; i++) {
    const s = data.subIssues[i];
    if (!s || typeof s.title !== "string" || s.title.trim() === "") {
      return { ok: false, error: `subIssues[${i}] has a missing or blank title` };
    }
    subIssues.push({
      title: s.title.trim(),
      description: typeof s.description === "string" ? s.description : "",
      labels: Array.isArray(s.labels) ? s.labels.filter((l: unknown): l is string => typeof l === "string") : [],
    });
  }
  const seenTitles = new Set<string>();
  for (const s of subIssues) {
    const k = s.title.trim().toLowerCase();
    if (seenTitles.has(k)) return { ok: false, error: `duplicate sub-issue title: "${s.title}"` };
    seenTitles.add(k);
  }
  return {
    ok: true,
    plan: {
      parentSummary: typeof data.parentSummary === "string" ? data.parentSummary : "",
      parentIdentifier: typeof data.parentIdentifier === "string" ? data.parentIdentifier : undefined,
      subIssues,
    },
  };
}

export function renderBreakdownPreview(plan: BreakdownPlan, parentIdentifier?: string): string {
  const head = `Requirement${parentIdentifier ? ` ${parentIdentifier}` : ""}  →  ${plan.subIssues.length} sub-issues proposed (order = dependency)`;
  const lines = plan.subIssues.map((s, i) => {
    const labels = s.labels.length ? `[${s.labels.join(",")}]` : "[default]";
    const blocker = i === 0 ? "no blocker, starts first" : `blocked-by #${i}`;
    return `#${i + 1}  ${s.title}  ${labels}  ${blocker}`;
  });
  return [head, "", ...lines, "", `parent body = decomposition rationale`].join("\n");
}
