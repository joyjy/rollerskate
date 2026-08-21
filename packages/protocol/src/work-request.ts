import { z } from "zod";

import { externalRefSchema } from "./connector.js";
import { identifierSchema, timestampSchema } from "./shared.js";

export const workRequestPrincipalRefSchema = z.object({
  kind: z.enum(["human", "agent"]),
  id: identifierSchema
}).strict();

export const workRequestBudgetSchema = z.object({
  maxSteps: z.number().int().min(1).max(1_000),
  maxDepth: z.number().int().min(0).max(100)
}).strict();

export const agentWorkRequestCreateSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestCreate@1"),
  requestId: z.string().trim().min(1).max(256),
  targetAgentId: identifierSchema,
  objective: z.string().trim().min(1).max(16_384),
  contextRefs: z.array(externalRefSchema).max(16),
  workflowRef: z.enum(["review@1", "forum@1"]).optional(),
  requestedBudget: workRequestBudgetSchema.optional(),
  deadlineAt: timestampSchema.optional(),
  requestedGrantRefs: z.array(identifierSchema).max(16),
  resultRoute: z.literal("requester-bounded@1"),
  expiresAt: timestampSchema
}).strict();

export const agentWorkRequestDecisionReceiptSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestDecisionReceipt@1"),
  decision: z.enum(["awaiting-owner", "accepted", "rejected"]),
  policyRevision: z.number().int().positive(),
  statusReason: z.string().trim().min(1).max(1_024),
  admittedWorkflowRef: z.enum(["review@1", "forum@1"]).optional(),
  admittedBudget: workRequestBudgetSchema.optional(),
  admittedGrantRefs: z.array(identifierSchema).max(16).optional(),
  decidedAt: timestampSchema
}).strict().superRefine((value, context) => {
  const admitted = value.admittedWorkflowRef !== undefined ||
    value.admittedBudget !== undefined || value.admittedGrantRefs !== undefined;
  if (value.decision === "accepted" && (
    value.admittedWorkflowRef === undefined ||
    value.admittedBudget === undefined ||
    value.admittedGrantRefs === undefined
  )) {
    context.addIssue({ code: "custom", message: "Accepted decision requires exact admission" });
  }
  if (value.decision !== "accepted" && admitted) {
    context.addIssue({ code: "custom", message: "Non-accepted decision cannot admit authority" });
  }
});

export const agentWorkRequestRunReceiptSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestRunReceipt@1"),
  runId: identifierSchema,
  admittedAt: timestampSchema
}).strict();

export const agentWorkRequestResultSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestResult@1"),
  outcome: z.enum(["succeeded", "failed", "needs-human", "cancelled"]),
  summary: z.string().max(4_096),
  resultRefs: z.array(externalRefSchema).max(16),
  completedAt: timestampSchema
}).strict();

export const agentWorkRequestSchema = agentWorkRequestCreateSchema.omit({
  schemaVersion: true,
  targetAgentId: true
}).extend({
  schemaVersion: z.literal("AgentWorkRequest@1"),
  workRequestId: identifierSchema,
  requesterRef: workRequestPrincipalRefSchema,
  targetAgentRef: workRequestPrincipalRefSchema.extend({ kind: z.literal("agent") }).strict(),
  status: z.enum([
    "received", "awaiting-owner", "accepted", "rejected", "withdrawn",
    "expired", "target-unavailable", "completed"
  ]),
  statusReason: z.string().max(1_024).optional(),
  decisionReceipt: agentWorkRequestDecisionReceiptSchema.optional(),
  runReceipt: agentWorkRequestRunReceiptSchema.optional(),
  result: agentWorkRequestResultSchema.optional(),
  revision: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
}).strict().superRefine((value, context) => {
  const decision = value.decisionReceipt?.decision;
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (value.status === "received" && decision !== undefined) {
    issue("Received work request cannot have a decision receipt");
  }
  if (value.status === "awaiting-owner" && decision !== "awaiting-owner") {
    issue("Awaiting-owner work request requires its matching decision receipt");
  }
  if (value.status === "accepted" && decision !== "accepted") {
    issue("Accepted work request requires its matching decision receipt");
  }
  if (value.status === "rejected" && decision !== "rejected") {
    issue("Rejected work request requires its matching decision receipt");
  }
  if (value.runReceipt !== undefined &&
    value.status !== "accepted" && value.status !== "completed") {
    issue("Run receipt requires an accepted or completed work request");
  }
  if (value.result !== undefined && value.status !== "completed") {
    issue("Work request result requires completed status");
  }
  if (value.status === "completed" && (
    decision !== "accepted" || value.runReceipt === undefined || value.result === undefined
  )) {
    issue("Completed work request requires accepted decision, Run receipt, and result");
  }
});

export const agentWorkRequestListSchema = z.array(agentWorkRequestSchema).max(100);

export const agentWorkRequestWithdrawSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestWithdraw@1"),
  expectedRevision: z.number().int().positive()
}).strict();

export const agentWorkRequestDecisionSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestDecision@1"),
  expectedRevision: z.number().int().positive(),
  receipt: agentWorkRequestDecisionReceiptSchema
}).strict();

export const agentWorkRequestRunAttachSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestRunAttach@1"),
  expectedRevision: z.number().int().positive(),
  receipt: agentWorkRequestRunReceiptSchema
}).strict();

export const agentWorkRequestResultSubmitSchema = z.object({
  schemaVersion: z.literal("AgentWorkRequestResultSubmit@1"),
  expectedRevision: z.number().int().positive(),
  result: agentWorkRequestResultSchema
}).strict();

export const workRequestRouteLeaseSchema = z.object({
  schemaVersion: z.literal("WorkRequestRouteLease@1"),
  routeId: identifierSchema,
  leaseMilliseconds: z.number().int().min(5_000).max(60_000)
}).strict();

export const workRequestRouteReceiptSchema = z.object({
  schemaVersion: z.literal("WorkRequestRouteReceipt@1"),
  routeId: identifierSchema,
  agentId: identifierSchema,
  expiresAt: timestampSchema
}).strict();

export type WorkRequestPrincipalRef = z.infer<typeof workRequestPrincipalRefSchema>;
export type WorkRequestBudget = z.infer<typeof workRequestBudgetSchema>;
export type AgentWorkRequestCreate = z.infer<typeof agentWorkRequestCreateSchema>;
export type AgentWorkRequestDecisionReceipt = z.infer<
  typeof agentWorkRequestDecisionReceiptSchema
>;
export type AgentWorkRequestRunReceipt = z.infer<typeof agentWorkRequestRunReceiptSchema>;
export type AgentWorkRequestResult = z.infer<typeof agentWorkRequestResultSchema>;
export type AgentWorkRequest = z.infer<typeof agentWorkRequestSchema>;
export type AgentWorkRequestWithdraw = z.infer<typeof agentWorkRequestWithdrawSchema>;
export type AgentWorkRequestDecision = z.infer<typeof agentWorkRequestDecisionSchema>;
export type AgentWorkRequestRunAttach = z.infer<typeof agentWorkRequestRunAttachSchema>;
export type AgentWorkRequestResultSubmit = z.infer<typeof agentWorkRequestResultSubmitSchema>;
export type WorkRequestRouteLease = z.infer<typeof workRequestRouteLeaseSchema>;
export type WorkRequestRouteReceipt = z.infer<typeof workRequestRouteReceiptSchema>;
