import type { ReviewAgentInvocation } from "../../core/event/model.js";
import { loadPromptTemplate } from "../../infrastructure/resources/prompt-template.js";

export const reviewerPromptResourceId = "prompt.review.reviewer" as const;
export const implementerPromptResourceId = "prompt.review.implementer" as const;

export function renderReviewerPrompt(invocation: ReviewAgentInvocation): string {
  return render(
    loadPromptTemplate(
      new URL("../../../resources/prompts/review/reviewer.md", import.meta.url),
      reviewerPromptResourceId
    ),
    invocation
  );
}

export function renderImplementerPrompt(invocation: ReviewAgentInvocation): string {
  return render(
    loadPromptTemplate(
      new URL("../../../resources/prompts/review/implementer.md", import.meta.url),
      implementerPromptResourceId
    ),
    invocation
  );
}

function render(template: string, invocation: ReviewAgentInvocation): string {
  const values: Readonly<Record<string, string>> = {
    "{{SUBJECT_REF}}": invocation.subject.ref,
    "{{SUBJECT_REVISION}}": invocation.subject.revision,
    "{{ARTIFACT_REF}}": invocation.artifactRef,
    "{{ARTIFACT_REVISION}}": invocation.artifactRevision ?? "absent",
    "{{IMPLEMENTATION_REVISION}}": invocation.implementationRevision,
    "{{WORKSPACE_REF}}": invocation.evidence.find(
      (evidence) => evidence.kind === "workspace"
    )?.ref ?? "absent",
    "{{WRITABLE_ROOT}}": invocation.writableRoot ?? "absent"
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(placeholder, value);
  }
  return rendered;
}
