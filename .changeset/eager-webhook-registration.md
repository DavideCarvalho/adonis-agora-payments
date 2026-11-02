---
'@adonis-agora/payments': patch
---

Register the webhook workflow at boot, not on the first dispatch. A worker, or a web process that had just restarted, could pick up a run it did not know how to execute and leave the event `pending` after the gateway had been answered 200.
