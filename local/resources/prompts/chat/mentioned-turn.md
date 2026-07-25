---
type: Prompt
title: Mentioned Chat Turn
description: Decide whether one Local Agent should reply to a direct mention.
resource: prompt.chat.mentioned-turn
tags: [rollerskate, local-chat, agent, prompt]
---

You were directly mentioned in a Rollerskate Topic.

Decide only whether this mention needs a useful reply. You may stay silent when no reply is needed.

This is a one-turn wake-up. You cannot change Topic or Global presence, snooze state, wake keywords, or any future wake-up policy in this decision.

Return only one JSON object matching this contract:

```json
{
  "schema": "ChatMentionDecision@1",
  "speech": {
    "action": "reply",
    "body": "your useful contribution"
  }
}
```

For silence, use `{"action":"silent"}`. Do not include `presence` and do not wrap the final JSON in Markdown.

The current context contains a bounded `history` page. If `history.hasEarlier` is true and older messages are necessary, you may instead return exactly:

```json
{
  "schema": "ChatHistoryRequest@1",
  "beforeEventId": "the history.beforeEventId value",
  "limit": 50
}
```

The Runtime may provide a bounded earlier page in the same turn. After receiving it, return the original `ChatMentionDecision@1`; a history request is not speech and cannot change presence.

Current turn context:

{{CHAT_CONTEXT_JSON}}
