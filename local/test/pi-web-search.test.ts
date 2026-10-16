import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Bundled Pi extension is loaded as ESM by the provider.
import { createWebSearchTool } from "../resources/agents/pi-exa-search.mjs";

test("Pi Exa tool fixes the provider, bounds input/output and preserves failures", async () => {
  const calls: unknown[] = [];
  const tool = createWebSearchTool(async (name: string, args: unknown, signal: AbortSignal) => {
    calls.push({name, args, signal: signal instanceof AbortSignal});
    return "Source URL: https://example.com\n" + "x".repeat(20_000);
  });
  const result = await tool.execute("test", {query: " docs "});
  assert.deepEqual(calls, [{name: "web_search_exa", args: {query: "docs", numResults: 5, contextMaxCharacters: 16_000}, signal: true}]);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.provider, "exa");
  assert.equal(body.truncated, true);
  assert.equal(body.evidence.length, 16_000);
  for (const args of [{query: ""}, {query: "x".repeat(1001)}, {query: "ok", provider: "all"}]) {
    await assert.rejects(tool.execute("bad", args), /query must/);
  }
  assert.equal(calls.length, 1);
  const failed = createWebSearchTool(async () => {throw new Error("Exa MCP rate limit reached (429)");});
  await assert.rejects(failed.execute("fail", {query: "docs"}), /429/);
  const empty = createWebSearchTool(async () => "");
  await assert.rejects(empty.execute("empty", {query: "docs"}), /no search evidence/);
});
