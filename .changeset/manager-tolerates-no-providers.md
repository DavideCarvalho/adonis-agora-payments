---
'@adonis-agora/payments': patch
---

An application with no payment providers configured can boot.

`PaymentsManager` threw in its CONSTRUCTOR when the driver map was empty. The provider
resolves the manager during boot — to publish `getPayments()` and to check webhook
verification — so an app with no credentials configured could not start at all. Not "payments
are off": the process exits. The message also named `config/payments.ts` at an app that had
deliberately configured nothing there.

That state is legitimate. An application can ship before it has a gateway, and one with a
"no credentials, subscriptions are simulated" mode runs its whole test suite and local
development that way.

Building an empty manager is now fine; ASKING it for a driver is the error, and `driver()`
says so with its own message rather than `Driver "" is not configured. Available drivers:
(none)` — true, and useless.
