import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateRunInput } from "../src/application/run/validation.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { parseRunIntent, runIntentDigest } from "../src/modules/steward/admission-contract.js";
import { parseRunGraph } from "../src/modules/steward/graph-contract.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const example = () => JSON.parse(readFileSync(join(repo, "examples/run-dag.json"), "utf8"));

test("DAG format preserves a fan-out/join graph and binds its contents to the intent digest", () => {
  const input = example();
  // Dependencies are by ID, not by array position.
  input.graph.nodes.reverse();
  const parsed = parseRunIntent(input);
  assert.deepEqual(parsed.graph, input.graph);
  assert.deepEqual(parseRunIntent(JSON.parse(JSON.stringify(parsed))), parsed);
  const digest = runIntentDigest(parsed);
  input.graph.nodes[0].objective += "，核验来源";
  assert.notEqual(runIntentDigest(parseRunIntent(input)), digest);
  const validation = validateRunInput(parsed);
  assert.equal(validation.status, "valid");
  assert.equal(validation.execution.status, "requires_preflight");
  delete input.graph;
  assert.equal(validateRunInput(input).execution.status, "requires_preflight");
  assert.equal(parseRunIntent(input).graph, undefined);
});

test("DAG format rejects ambiguous, cyclic, dangling and disconnected work", () => {
  const cases: readonly [string, (graph: any) => void, RegExp][] = [
    ["duplicate ID", g => {g.nodes[1].id = g.nodes[0].id;}, /duplicate node/],
    ["unknown dependency", g => {g.nodes[2].needs.push("missing");}, /unknown node/],
    ["duplicate dependency", g => {g.nodes[2].needs.push("tests");}, /duplicate dependencies/],
    ["self-cycle", g => {g.nodes[0].needs = ["implementation"];}, /cycle/],
    ["cycle", g => {g.nodes[0].needs = ["assessment"];}, /cycle/],
    ["disconnected work", g => {g.nodes[2].needs = ["tests"];}, /contribute/],
    ["missing result", g => {g.resultNode = "missing";}, /resultNode/],
    ["unknown executor", g => {g.nodes[0].executor = "nobody";}, /unknown participant/],
    ["prototype executor", g => {g.nodes[0].executor = "toString";}, /unknown participant/],
    ["invalid reference", g => {g.participants.analyst = "kimi";}, /reference/],
    ["unsupported authority", g => {g.nodes[0].workspace = "/private";}, /unknown field/],
    ["invalid limits", g => {g.limits.maxConcurrency = 0;}, /maxConcurrency/],
    ["unbounded input", g => {g.nodes[0].objective = "x".repeat(32769);}, /bounded JSON/]
  ];
  for (const [name, mutate, error] of cases) {
    const graph = example().graph;
    mutate(graph);
    assert.throws(() => parseRunGraph(graph), error, name);
  }
  for (const conflict of [{workerRef: "agent:kimi"}, {requestedParticipantRefs: ["agent:kimi"]}]) {
    assert.throws(() => parseRunIntent({...example(), ...conflict}), /cannot be combined/);
  }
});

test("CLI validates format offline without creating runtime state", async t => {
  const root = mkdtempSync(join(tmpdir(), "rs-dag-format-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const runtime = join(root, "uninitialized-runtime");
  const file = join(root, "intent.json");
  const input = example();
  writeFileSync(file, JSON.stringify(input));
  let output = "";
  const code = await runLocalApp(repo, ["--runtime", runtime, "run", "validate", file], {}, {write(text) {output += text;}});
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output).intent.graph, input.graph);
  assert.equal(JSON.parse(output).execution.status, "requires_preflight");
  assert.equal(existsSync(runtime), false);
  input.graph.nodes[0].needs = ["assessment"];
  writeFileSync(file, JSON.stringify(input));
  output = "";
  assert.equal(await runLocalApp(repo, ["--runtime", runtime, "run", "validate", file], {}, {write(text) {output += text;}}), 2);
  assert.equal(JSON.parse(output).status, "invalid");
  assert.match(JSON.parse(output).error, /cycle/);
  assert.equal(existsSync(runtime), false);
});
