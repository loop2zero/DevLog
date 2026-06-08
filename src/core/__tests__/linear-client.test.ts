import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient } from "../linear/client";

test("fetchTriggerIssues queries by slugId+state and maps labels", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_url: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issues: { nodes: [ { id: "i1", identifier: "ARC-1", title: "t", description: "d", state: { name: "Todo" }, labels: { nodes: [{ name: "codex" }] } } ] } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  const issues = await c.fetchTriggerIssues("slug123", "Todo");
  assert.deepEqual(captured[0].variables, { slug: "slug123", state: "Todo" });
  assert.deepEqual(issues[0], { id: "i1", identifier: "ARC-1", title: "t", description: "d", stateName: "Todo", labels: ["codex"] });
});

test("updateState sends issueUpdate mutation with vars", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueUpdate: { success: true } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.updateState("i1", "STATEID");
  assert.ok(captured[0].query.includes("issueUpdate"));
  assert.deepEqual(captured[0].variables, { id: "i1", stateId: "STATEID" });
});

test("createComment returns the comment id", async () => {
  const fakeFetch = async () => ({ json: async () => ({ data: { commentCreate: { comment: { id: "c9" } } } }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  assert.equal(await c.createComment("i1", "body"), "c9");
});

test("updateComment sends commentUpdate", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { commentUpdate: { success: true } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.updateComment("c1", "new");
  assert.ok(captured[0].query.includes("commentUpdate"));
  assert.deepEqual(captured[0].variables, { id: "c1", body: "new" });
});

test("gql throws when GraphQL returns errors", async () => {
  const fakeFetch = async () => ({ json: async () => ({ errors: [{ message: "bad" }] }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  await assert.rejects(() => c.fetchTriggerIssues("s", "Todo"));
});

test("fetchWorkflowStates flattens teams→states, dedupes by id, includes type", async () => {
  const fakeData = {
    projects: { nodes: [ { teams: { nodes: [
      { states: { nodes: [{ id: "s1", name: "Todo", type: "unstarted" }, { id: "s2", name: "In Progress", type: "started" }] } },
      { states: { nodes: [{ id: "s2", name: "In Progress", type: "started" }, { id: "s3", name: "Done", type: "completed" }] } },
    ] } } ] },
  };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const states = await c.fetchWorkflowStates("slug123");
  assert.deepEqual(states, [
    { id: "s1", name: "Todo", type: "unstarted" },
    { id: "s2", name: "In Progress", type: "started" },
    { id: "s3", name: "Done", type: "completed" },
  ]);
});

test("createIssue sends issueCreate with input and returns id+identifier", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueCreate: { success: true, issue: { id: "n1", identifier: "ARC-9" } } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  const out = await c.createIssue({ teamId: "t1", title: "Ledger slice", description: "do x", parentId: "p1", labelIds: ["l1"], stateId: "st1" });
  assert.ok(captured[0].query.includes("issueCreate"));
  assert.deepEqual(captured[0].variables.input, { teamId: "t1", title: "Ledger slice", description: "do x", parentId: "p1", labelIds: ["l1"], stateId: "st1" });
  assert.deepEqual(out, { id: "n1", identifier: "ARC-9" });
});

test("createRelation sends issueRelationCreate with blocks type", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueRelationCreate: { success: true } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.createRelation("a", "b", "blocks");
  assert.ok(captured[0].query.includes("issueRelationCreate"));
  assert.deepEqual(captured[0].variables.input, { issueId: "a", relatedIssueId: "b", type: "blocks" });
});

test("updateIssueBody sends issueUpdate with description", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueUpdate: { success: true } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.updateIssueBody("i1", "new body");
  assert.ok(captured[0].query.includes("issueUpdate"));
  assert.deepEqual(captured[0].variables, { id: "i1", desc: "new body" });
});

test("fetchChildIssues returns children with id/title/stateName", async () => {
  const fakeData = { issue: { children: { nodes: [
    { id: "c1", identifier: "ARC-2", title: "Slice", state: { name: "Done" } },
    { id: "c2", identifier: "ARC-3", title: "API", state: { name: "Backlog" } },
  ] } } };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const kids = await c.fetchChildIssues("p1");
  assert.deepEqual(kids, [
    { id: "c1", identifier: "ARC-2", title: "Slice", stateName: "Done" },
    { id: "c2", identifier: "ARC-3", title: "API", stateName: "Backlog" },
  ]);
});

test("fetchTeamAndLabels returns first team id and lowercased label map", async () => {
  const fakeData = { projects: { nodes: [ { id: "proj1", teams: { nodes: [
    { id: "team1", labels: { nodes: [{ id: "l1", name: "claude" }, { id: "l2", name: "Codex" }] } },
  ] } } ] } };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const out = await c.fetchTeamAndLabels("slug123");
  assert.equal(out.teamId, "team1");
  assert.equal(out.projectId, "proj1");
  assert.deepEqual(out.labels, { claude: "l1", codex: "l2" });
});

test("createIssue forwards projectId in the input", async () => {
  const captured: any[] = [];
  const fakeFetch = async (_u: string, init: any) => { captured.push(JSON.parse(init.body)); return { json: async () => ({ data: { issueCreate: { success: true, issue: { id: "n1", identifier: "ARC-9" } } } }) }; };
  const c = new LinearClient("KEY", fakeFetch as any);
  await c.createIssue({ teamId: "t1", title: "x", projectId: "proj1" });
  assert.equal(captured[0].variables.input.projectId, "proj1");
});
