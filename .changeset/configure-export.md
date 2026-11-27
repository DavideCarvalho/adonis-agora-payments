---
"@adonis-agora/payments": patch
---

`node ace add @adonis-agora/payments` (and `node ace configure @adonis-agora/payments`) now runs the configure hook: the main entry exports `configure`, which Adonis looks for there. Before, it only warned "the module does not export the configure hook" and published nothing.
