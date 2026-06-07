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

test("fetchWorkflowStates flattens teams→states and dedupes by id", async () => {
  const fakeData = {
    projects: {
      nodes: [
        {
          teams: {
            nodes: [
              { states: { nodes: [{ id: "s1", name: "Todo" }, { id: "s2", name: "In Progress" }] } },
              { states: { nodes: [{ id: "s2", name: "In Progress" }, { id: "s3", name: "Done" }] } },
            ],
          },
        },
      ],
    },
  };
  const fakeFetch = async () => ({ json: async () => ({ data: fakeData }) });
  const c = new LinearClient("KEY", fakeFetch as any);
  const states = await c.fetchWorkflowStates("slug123");
  assert.deepEqual(states, [
    { id: "s1", name: "Todo" },
    { id: "s2", name: "In Progress" },
    { id: "s3", name: "Done" },
  ]);
});
