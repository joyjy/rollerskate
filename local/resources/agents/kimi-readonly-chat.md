---
name: rollerskate-readonly-chat
description: Read-only Rollerskate Agent turns that return the host-requested contract
tools:
  - Read
  - Grep
  - Glob
---

${base_prompt}

Operate read-only. Do not modify files or execute commands. Follow the Rollerskate prompt and return only its requested result contract.
