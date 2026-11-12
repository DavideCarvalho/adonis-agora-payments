---
"@adonis-agora/payments": minor
"@adonis-agora/payments-dashboard": minor
---

A webhook retry from the payments console is now recorded in the activity trail as `webhook.retried`, with who ran it (the console viewer, or `mcp:<caller>` from the dev MCP tools: both paths write the same row), the gateway, and the event's type and previous error. The retry response carries the audit row. The Activity screen can filter retries.
