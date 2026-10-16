import * as v from "valibot";
export const workspaceCandidateSchema = v.object({
  ref:v.string(),root:v.string(),branch:v.nullable(v.string()),defaultBranch:v.nullable(v.string()),
  defaultRef:v.nullable(v.string()),baseSha:v.nullable(v.string()),defaultSource:v.nullable(v.string()),
  forkBlocker:v.nullable(v.string()),token:v.string()
});
export const workspaceCandidatesSchema=v.object({schema:v.literal("WorkspaceCandidates@1"),items:v.array(workspaceCandidateSchema),truncated:v.boolean()});
export const workspaceForkSchema=v.object({schema:v.literal("WorkspaceFork@1"),requestId:v.string(),authority:v.string(),
  sourceRoot:v.string(),defaultBranch:v.string(),baseSha:v.string(),root:v.string(),branch:v.string()});
export type WorkspaceCandidate=v.InferOutput<typeof workspaceCandidateSchema>;
