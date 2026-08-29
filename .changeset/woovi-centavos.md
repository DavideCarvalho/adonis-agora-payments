---
'@adonis-agora/payments': patch
---

**Woovi charges were being created for one hundredth of their amount.**

OpenPix documents `value` as *"o valor em centavos da cobrança Pix"* — the same integer minor unit
this package uses everywhere. The driver ran `toDecimal()` over it on the way out and
`fromDecimal()` on the way back, so `charge({ amount: 1990 })` sent `value: 19.9` and the gateway
created a **20 centavo** charge. The same conversion ran on `createCheckout` and
`createSubscription`, and in reverse when reading a charge or a webhook back — so a R$19,90 payment
was also *reported* as 20 centavos, which is why the two halves agreed with each other and the tests
agreed with both.

Nothing is converted at this boundary now. The neighbouring Brazilian drivers are genuinely the
other way round — Asaas and AbacatePay work in decimal reais and still convert — so the driver and
its page now say which is which rather than leaving it to look like an inconsistency.

The unit is pinned by tests in both directions, and the old tests that asserted the converted figure
were wrong in exactly the way the code was.

**If you are live on Woovi, check your charges.** Anything created through this driver was for 1/100
of the intended amount; the library cannot repair a charge the gateway already settled.
