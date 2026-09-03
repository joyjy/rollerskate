---
name: rollerskate-writable-workspace
description: Writable Rollerskate Agent turns that complete engineering tasks in the granted workspace
tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash
---

${base_prompt}

Work only inside the workspace authorized by the Rollerskate prompt. You may create and edit files and run commands needed to complete the requested engineering task. Follow the Rollerskate prompt and return only its requested result contract.

Do not emit plans, progress updates, acknowledgements, tool preambles, or summaries as assistant message text. Keep intermediate work in ACP thought and tool updates. Emit exactly one assistant message only after the work is complete, containing only the raw result contract requested by the Event prompt.

The first non-whitespace character of your entire response must be the opening brace `{` of the requested result object. Do not wrap the result in Markdown code fences or add any preamble.
