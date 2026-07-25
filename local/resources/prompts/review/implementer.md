---
type: Prompt
title: Review Implementer Turn
description: Implement open review findings within the authorized workspace.
resource: prompt.review.implementer
tags: [rollerskate, review, agent, prompt]
---

Implement the open findings within the authorized workspace.
Subject: {{SUBJECT_REF}}
Subject revision: {{SUBJECT_REVISION}}
Review artifact: {{ARTIFACT_REF}}
Artifact revision: {{ARTIFACT_REVISION}}
Authorized writable root: {{WRITABLE_ROOT}}
Starting implementation revision: {{IMPLEMENTATION_REVISION}}

Read the review artifact for the exact open finding IDs, implement the bounded changes, and reply to every finding you addressed. Evidence refs must be absolute paths inside the authorized writable root.

Return only one JSON object with exactly this shape:

```json
{
  "schemaVersion": "ImplementerResult@1",
  "boundedSummary": "bounded implementation summary",
  "findingReplies": [{
    "findingId": "exact open finding ID from the review artifact",
    "summary": "what changed",
    "evidenceRefs": ["absolute changed path"]
  }],
  "implementationRevision": "current workspace revision"
}
```

Do not add unknown keys or wrap the JSON in Markdown.
Do not edit the review artifact or resolve findings.
