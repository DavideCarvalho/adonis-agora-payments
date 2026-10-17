---
"@adonis-agora/payments": minor
---

Support stripe-node 23. Its default API version (`2026-09-30.endive`) removed `payment_method_types` from PaymentIntent creation in favour of `allowed_payment_method_types`, and the Stripe driver used the old field to hold a charge to its method (Pix stays Pix): on stripe 23 every charge that named a method would have sent a parameter the API no longer takes. The driver now reads `Stripe.API_VERSION` from the SDK the app installed and sends `allowed_payment_method_types` from 2026-09-30 on, `payment_method_types` before it, so stripe 17 through 23 all work. The `stripe` peer range now includes `^23.0.0`.
