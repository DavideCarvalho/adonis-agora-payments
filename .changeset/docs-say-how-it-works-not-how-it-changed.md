---
'@adonis-agora/payments': patch
---

Docs describe how the library works, not how it got there

Roughly sixty passages across thirty-four pages narrated the library's own bug history —
"it used to answer `200`", "the driver used to divide by 100", "this used to be the silent
default". That belongs in a changelog. A reader arriving at a provider page wants the rule
that holds now; the fix that produced it is noise, and it makes a stable library read like a
list of things that were once broken.

Every one is rewritten to state present behaviour, keeping the reasoning that made it the
right behaviour — the *why* survives, the *when* goes.

Ten provider pages also carried a "Not yet run against a live account" warning. Those are
gone.
