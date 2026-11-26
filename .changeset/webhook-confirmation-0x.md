---
"@adonis-agora/payments": minor
---

Security: webhooks from gateways that do not sign their deliveries are now confirmed with the gateway before anything is recorded (GHSA-r5jh-7wh2-ffjh, backported to 0.x).

- InfinitePay: every delivery is confirmed with `payment_check` using the driver's own `handle`, and the event (amount, method, paid state) is built from the gateway's answer. A delivery the gateway does not confirm as paid is refused with `400` and no ledger row.
- Efí: every `pix` entry is read back with `GET /v2/pix/:e2eid` over the driver's mTLS credentials and the event is built from that answer. An entry Efí does not know refuses the delivery.
- Mollie (classic flow, no `webhookSecret`): no body field is trusted. `tr_` ids are read back as payments and `chb_` ids as chargebacks; event and ledger ids come from Mollie's answer. Anything else unsigned is refused; set `webhookSecret` (`MOLLIE_WEBHOOK_SECRET`) for signed next-gen events.
- Mercado Pago: the ledger id is derived from the signed `data.id` and the fetched state, an `x-signature` `ts` more than 5 minutes off is refused, a chargeback's payment comes from the case lookup, subscription charges (`subscription_authorized_payment`) are read through `/authorized_payments/{id}`, and topics the driver does not look up are acknowledged without recording anything. Rows recorded under the previous id format are still matched, so redeliveries are not processed twice.
- Gateway ids are URL-encoded in REST paths of these drivers.

Upgrade notes: InfinitePay's and Efí's `parseWebhook` is now async and throws on unconfirmed deliveries (only affects code that calls it directly). Both drivers, and Mollie without a `webhookSecret`, now report `webhookVerification: 'confirmed'`. No configuration is needed.
