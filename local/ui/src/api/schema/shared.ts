import * as v from "valibot";

export const nullableString = v.nullable(v.string());
export const optionalString = v.optional(v.string());
export const stringRecord = v.record(v.string(), v.string());

export const runHumanQuestionSchema = v.object({
  questionId:v.string(),question:v.string(),runVersion:v.number(),
  status:v.union([v.literal("pending"),v.literal("answered"),v.literal("closed"),v.literal("expired"),v.literal("superseded")]),
  expiresAt:v.string(),answerEventId:v.optional(v.string())
});

export const runInterventionSchema = v.object({
  schemaVersion: v.literal("RunIntervention@1"),
  kind: v.literal("manual_fallback"),
  runId: v.string(),
  runVersion: v.number(),
  requestEventId: v.string(),
  resultExecutionId: v.string(),
  reason: v.string(),
  allowedActions: v.array(v.union([
    v.literal("retry_orchestrator"),
    v.literal("decide"),
    v.literal("cancel")
  ]))
});
