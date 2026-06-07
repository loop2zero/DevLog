import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBreakdown, renderBreakdownPreview } from "../linear/breakdown";

test("parseBreakdown accepts a valid plan", () => {
  const raw = JSON.stringify({ parentSummary: "why", subIssues: [{ title: "A", description: "da", labels: ["claude"] }] });
  const r = parseBreakdown(raw);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.parentSummary, "why");
    assert.equal(r.plan.subIssues[0].title, "A");
    assert.deepEqual(r.plan.subIssues[0].labels, ["claude"]);
  }
});

test("parseBreakdown defaults a missing labels array to empty", () => {
  const raw = JSON.stringify({ parentSummary: "why", subIssues: [{ title: "A" }] });
  const r = parseBreakdown(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.plan.subIssues[0].labels, []);
});

test("parseBreakdown rejects malformed JSON", () => {
  const r = parseBreakdown("{not json");
  assert.equal(r.ok, false);
});

test("parseBreakdown rejects an empty subIssues array", () => {
  const r = parseBreakdown(JSON.stringify({ parentSummary: "x", subIssues: [] }));
  assert.equal(r.ok, false);
});

test("parseBreakdown rejects a sub-issue with a blank title", () => {
  const r = parseBreakdown(JSON.stringify({ parentSummary: "x", subIssues: [{ title: "  " }] }));
  assert.equal(r.ok, false);
});

test("renderBreakdownPreview numbers subs and shows blockers + labels", () => {
  const out = renderBreakdownPreview({
    parentSummary: "why",
    subIssues: [
      { title: "Ledger", description: "", labels: ["claude"] },
      { title: "API", description: "", labels: ["codex"] },
    ],
  }, "ARC-1");
  assert.match(out, /#1\s+Ledger\s+\[claude\]\s+no blocker, starts first/);
  assert.match(out, /#2\s+API\s+\[codex\]\s+blocked-by #1/);
  assert.match(out, /ARC-1/);
});
