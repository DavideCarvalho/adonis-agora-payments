---
"@adonis-agora/payments": minor
"@adonis-agora/payments-dashboard": minor
---

The payments console joins the Agora console switcher. It registers itself in the app's `'agora.consoles'` registry (created by whichever console boots first), and its heading becomes a menu to the other Agora consoles the viewer may open, each checked with that console's own `authorize` (300 ms each, in parallel; `ctx.agoraProbe` is `true` while they run). Ctrl/Cmd-K searches every console the viewer may open; payments answers payments (gateway id or reference), customers (gateway id or owner id) and subscriptions (gateway id or reference, opening that subscription), only within the organizations the viewer may see. New routes: `GET <path>/api/consoles` and `GET <path>/api/consoles/search?q=`, behind the console's `authorize`. `registerAgoraConsole` is exported from `@adonis-agora/payments/dashboard` for consoles an app mounts itself. Nothing changes for an app with a single console.
