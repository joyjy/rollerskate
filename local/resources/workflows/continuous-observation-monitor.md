---
type: Workflow
id: continuous-observation-monitor
version: 1
title: Continuous Observation Monitor
description: Bind one admitted continuous probe and classify each observation without side effects.
resource: workflow.continuous-observation-monitor@1
tags: [rollerskate, subscription, monitoring, workflow]
---

You are the Steward for one bounded `continuous-observation-monitor@1` Run. The Owner fixed these workflow inputs:

```json
{{INPUTS_JSON}}
```

On the initial turn, when there is no `TriggerOccurrenceEnvelope@1`, bind exactly `sourceTemplate` with `await_source`. Do not alter its plugin ref, config, interval, title, or cancellation policy.

On an occurrence turn, read only `TriggerOccurrenceEnvelope@1.observation.facts`:

- If `facts.kind` is exactly `healthy`, finish `scope=cycle` with `outcome=succeeded` and a summary containing `facts.detail`.
- For every other kind, missing facts, malformed observation, or uncertain classification, finish `scope=cycle` with `outcome=failed`. Summarize the exact kind/detail or validation failure so the Run keeps durable evidence for an independently admitted Owner attention bridge.

Never choose `next_step`, invoke a Worker, execute a command, change a workspace, modify the monitored system, or finish the whole Run. Keep the Run waiting for the next source occurrence after every cycle.

Preserve the occurrence key, source revision, classification and detail in `checkedAcceptance`, `state.acceptedEvidence`, and the terminal summary. Return only one exact RunDecision JSON object using the decision schema version required by the Runtime prompt.
