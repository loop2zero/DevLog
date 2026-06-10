import { test } from "node:test";
import assert from "node:assert/strict";
import { LinearClient } from "../linear/client";

function fakeFetch(data: unknown): { fn: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fn = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body));
    return { json: async () => ({ data }) } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

test("fetchComments returns id/body/createdAt for an issue", async () => {
  const { fn, calls } = fakeFetch({
    issue: { comments: { nodes: [
      { id: "cm1", body: "workpad", createdAt: "2026-06-10T01:00:00.000Z" },
      { id: "cm2", body: "Approve", createdAt: "2026-06-10T02:00:00.000Z" },
    ] } },
  });
  const client = new LinearClient("key", fn);
  const comments = await client.fetchComments("issue-1");
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[1], { id: "cm2", body: "Approve", createdAt: "2026-06-10T02:00:00.000Z" });
  assert.match(calls[0].query, /comments/);
  assert.equal(calls[0].variables.id, "issue-1");
});

test("fetchComments returns [] when the issue is unreadable", async () => {
  const { fn } = fakeFetch({ issue: null });
  const client = new LinearClient("key", fn);
  assert.deepEqual(await client.fetchComments("gone"), []);
});
