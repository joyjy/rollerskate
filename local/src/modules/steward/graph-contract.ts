import { assertSpecCompatibility } from "../spec/registry.js";
import {
  boundedContractValue, contractInteger, contractRecord, contractStringList,
  contractText, exactContractKeys
} from "./contract-codec.js";

export interface RunGraphNode {
  readonly id: string;
  readonly objective: string;
  readonly executor: string;
  readonly needs: readonly string[];
  readonly contextRefs: readonly string[];
  readonly acceptance: readonly string[];
  readonly output: { readonly name: string; readonly format: "markdown" | "json" | "text" };
}

/** Declarative input only; contains no execution state or permission grants. */
export interface RunGraph {
  readonly schemaVersion: "RunGraph@1";
  readonly participants: Readonly<Record<string, string>>;
  readonly limits: {
    readonly maxConcurrency: number;
    readonly maxNodeAttempts: number;
    readonly timeoutSeconds: number;
  };
  readonly nodes: readonly RunGraphNode[];
  readonly resultNode: string;
}

export function assertExecutableGraph(graph: RunGraph): void {
  if (graph.limits.maxNodeAttempts !== 1) throw new Error("DAG execution requires maxNodeAttempts=1");
}

const MAX_NODES = 64;

function identifier(value: unknown, field: string): string {
  const text = contractText(value, field, 64);
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(text)) throw new Error(`${field} must be a letter followed by letters, digits, _ or -`);
  return text;
}

export function parseRunGraph(value: unknown): RunGraph {
  boundedContractValue(value, "graph");
  const graph = contractRecord(value, "RunGraph@1");
  assertSpecCompatibility("spec:rollerskate/run-graph@1", graph.schemaVersion, {kind: "contract"});
  exactContractKeys(graph, ["schemaVersion", "participants", "limits", "nodes", "resultNode"], "RunGraph@1");
  const entries = Object.entries(contractRecord(graph.participants, "graph.participants"));
  if (entries.length < 1 || entries.length > MAX_NODES) throw new Error("graph.participants must contain 1-64 entries");
  const participants = Object.fromEntries(entries.map(([alias, value]) => {
    identifier(alias, "participant alias");
    const ref = contractText(value, `participants.${alias}`, 256);
    if (!/^(agent|principal):[A-Za-z0-9_-]+$/u.test(ref)) throw new Error(`participants.${alias} must be an agent: or principal: reference`);
    return [alias, ref];
  }));
  const limit = contractRecord(graph.limits, "graph.limits");
  exactContractKeys(limit, ["maxConcurrency", "maxNodeAttempts", "timeoutSeconds"], "graph.limits");
  const limits = {
    maxConcurrency: contractInteger(limit.maxConcurrency, "maxConcurrency", 1, MAX_NODES),
    maxNodeAttempts: contractInteger(limit.maxNodeAttempts, "maxNodeAttempts", 1, 10),
    timeoutSeconds: contractInteger(limit.timeoutSeconds, "timeoutSeconds", 1, 86_400)
  };
  if (!Array.isArray(graph.nodes) || graph.nodes.length < 1 || graph.nodes.length > MAX_NODES) {
    throw new Error("graph.nodes must contain 1-64 nodes");
  }
  const nodes: RunGraphNode[] = graph.nodes.map((value, index) => {
    const field = `graph.nodes[${index}]`;
    const node = contractRecord(value, field);
    exactContractKeys(node, ["id", "objective", "executor", "needs", "contextRefs", "acceptance", "output"], field);
    const executor = identifier(node.executor, `${field}.executor`);
    if (!Object.hasOwn(participants, executor)) throw new Error(`${field}.executor references unknown participant: ${executor}`);
    const needs = contractStringList(node.needs, `${field}.needs`, {maximum: MAX_NODES});
    if (new Set(needs).size !== needs.length) throw new Error(`${field}.needs contains duplicate dependencies`);
    const output = contractRecord(node.output, `${field}.output`);
    exactContractKeys(output, ["name", "format"], `${field}.output`);
    if (output.format !== "markdown" && output.format !== "json" && output.format !== "text") {
      throw new Error(`${field}.output.format must be markdown, json or text`);
    }
    return {
      id: identifier(node.id, `${field}.id`), executor, needs,
      objective: contractText(node.objective, `${field}.objective`),
      contextRefs: contractStringList(node.contextRefs, `${field}.contextRefs`),
      acceptance: contractStringList(node.acceptance, `${field}.acceptance`, {minimum: 1}),
      output: {name: identifier(output.name, `${field}.output.name`), format: output.format}
    };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("graph.nodes contains duplicate node IDs");
  for (const node of nodes) {
    for (const dependency of node.needs) {
      if (!byId.has(dependency)) throw new Error(`Node ${node.id} needs unknown node: ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`graph contains a cycle at node: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.needs) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
  const resultNode = identifier(graph.resultNode, "graph.resultNode");
  if (!byId.has(resultNode)) throw new Error(`graph.resultNode references unknown node: ${resultNode}`);
  // Every declared task must contribute to the one Run result.
  visited.clear();
  visit(resultNode);
  if (visited.size !== nodes.length) throw new Error("Every graph node must contribute to resultNode through needs");
  return {schemaVersion: "RunGraph@1", participants, limits, nodes, resultNode};
}
