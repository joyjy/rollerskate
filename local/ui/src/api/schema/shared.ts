import * as v from "valibot";

export const nullableString = v.nullable(v.string());
export const optionalString = v.optional(v.string());
export const stringRecord = v.record(v.string(), v.string());

export const runHumanQuestionSchema = v.object({
  questionId:v.string(),question:v.string(),runVersion:v.number(),
  status:v.union([v.literal("pending"),v.literal("answered"),v.literal("closed"),v.literal("expired"),v.literal("superseded")]),
  expiresAt:v.string(),answerEventId:v.optional(v.string())
});
