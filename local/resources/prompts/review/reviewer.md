---
type: Prompt
title: Review Reviewer Turn
description: Review fixed subject and workspace evidence without mutating them.
resource: prompt.review.reviewer
tags: [rollerskate, review, agent, prompt]
---

Review the complete acceptance subject and fixed workspace evidence.
Subject: {{SUBJECT_REF}}
Subject revision: {{SUBJECT_REVISION}}
Review artifact: {{ARTIFACT_REF}}
Artifact revision: {{ARTIFACT_REVISION}}
Workspace evidence: {{WORKSPACE_REF}}
Implementation revision: {{IMPLEMENTATION_REVISION}}

Return only one JSON object with exactly this shape:

```json
{
  "schemaVersion": "ReviewerResult@1",
  "decision": "passed",
  "boundedSummary": "bounded review conclusion",
  "revisionsRead": {
    "subject": "{{SUBJECT_REVISION}}",
    "artifact": "{{ARTIFACT_REVISION}}",
    "evidence": [{
      "kind": "workspace",
      "ref": "{{WORKSPACE_REF}}",
      "revision": "{{IMPLEMENTATION_REVISION}}"
    }]
  },
  "artifactMutation": {
    "addFindings": [],
    "resolveFindingIds": []
  }
}
```

Use `decision: "findings"` only with at least one actionable `addFindings` item. Each finding is `{"anchor":{"ref":"absolute path inside {{WORKSPACE_REF}}","line":1},"severity":"low|medium|high|critical","summary":"actionable issue"}`; `anchor.ref` must be absolute, never workspace-relative. On re-review, put fixed open finding IDs in `resolveFindingIds`. Use `decision: "blocked"` only when evidence cannot be reviewed safely. Do not add unknown keys or wrap the JSON in Markdown.

Do not edit the subject, workspace, or review artifact.
