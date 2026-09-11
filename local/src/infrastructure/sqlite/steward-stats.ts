import type { DatabaseSync } from "node:sqlite";

interface GroupRow {
  agentId: string;
  policyDigest: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  needsHuman: number;
  inProgress: number;
  fallbackRuns: number;
  durationSamples: number;
  meanDurationMs: number | null;
}

// Read existing admitted identity and receipts; no independent metrics projection.
export function readStewardStats(database: DatabaseSync, policyDigest?: string) {
  const groups = database.prepare(`
    WITH fallbacks AS (
      SELECT DISTINCT json_extract(receipt_json, '$.runId') AS run_id
      FROM executions
      WHERE json_extract(receipt_json, '$.schema') = 'StewardOrchestratorDecisionReceipt@1'
        AND json_extract(receipt_json, '$.outcome') = 'rejected_manual_fallback'
    ), finishes AS (
      SELECT run_id, MAX(accepted_at) AS finished_at FROM agent_run_decisions
      WHERE json_extract(decision_json, '$.action') = 'finish'
        AND COALESCE(json_extract(decision_json, '$.finish.scope'), 'run') = 'run'
      GROUP BY run_id
    )
    SELECT r.steward_agent_id AS agentId,
      json_extract(r.orchestrator_binding_json, '$.selection.policyDigest') AS policyDigest,
      COUNT(*) AS runs,
      SUM(r.status = 'succeeded') AS succeeded,
      SUM(r.status = 'failed') AS failed,
      SUM(r.status = 'cancelled') AS cancelled,
      SUM(r.status = 'needs_human') AS needsHuman,
      SUM(r.status NOT IN ('succeeded', 'failed', 'cancelled', 'needs_human')) AS inProgress,
      SUM(f.run_id IS NOT NULL) AS fallbackRuns,
      COUNT(CASE WHEN r.status IN ('succeeded', 'failed', 'cancelled')
        THEN COALESCE(r.cancelled_at, t.finished_at) END) AS durationSamples,
      AVG(CASE WHEN r.status IN ('succeeded', 'failed', 'cancelled') THEN
        (julianday(COALESCE(r.cancelled_at, t.finished_at)) - julianday(r.created_at)) * 86400000 END) AS meanDurationMs
    FROM agent_runs r LEFT JOIN fallbacks f ON f.run_id = r.run_id
      LEFT JOIN finishes t ON t.run_id = r.run_id
    WHERE json_extract(r.orchestrator_binding_json, '$.orchestratorRef.kind') = 'agent'
      AND (? IS NULL OR json_extract(r.orchestrator_binding_json, '$.selection.policyDigest') = ?)
    GROUP BY r.steward_agent_id, policyDigest ORDER BY policyDigest, agentId
  `).all(policyDigest ?? null, policyDigest ?? null) as unknown as GroupRow[];
  return groups.map((group) => ({ ...group,
    successRate: group.succeeded + group.failed + group.cancelled === 0 ? null
      : group.succeeded / (group.succeeded + group.failed + group.cancelled),
    fallbackRate: group.fallbackRuns / group.runs,
    meanDurationMs: group.meanDurationMs === null ? null : Math.round(group.meanDurationMs)
  }));
}
