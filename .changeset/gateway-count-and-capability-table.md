---
'@adonis-agora/payments': patch
---

Say how many gateways ship, and put the gaps in the table

The package advertised four gateways — Stripe, AbacatePay, Asaas and Woovi — while eighteen
shipped. The count was written on four surfaces nobody edits when a driver lands (two npm
descriptions, two docs descriptions), and ten drivers had never reached the npm keywords, so
the package was unfindable by the name of the gateway it already supported.

`driver_registry.spec.ts` now fails when a description stops matching the number of drivers on
disk, and when a driver is missing from the keywords.

The providers comparison table gained the three columns a reader was going to the source for:

- **Charge** — `server` or `checkout only`. Four gateways (InfinitePay, Lemon Squeezy, Paddle,
  Polar) throw on `charge()` and collect through their own hosted page; that difference outranks
  every other column and was documented nowhere near the table.
- **Disputes** — true on Stripe alone.
- **Webhook auth** — false on Efí and InfinitePay, whose gateways sign nothing.

All three are generated from the drivers and gated by the same spec. A new **When it is a dash**
section turns each gap into the route through it — the one the driver's own error message names.
