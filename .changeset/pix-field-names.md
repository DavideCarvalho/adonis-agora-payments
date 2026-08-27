---
'@adonis-agora/payments': minor
---

Rename the Pix fields on `Payment` to say what they actually hold: `pixQrCodeImage` and `pixCode`.

The two old names described the wrong things. `pixQrCode` never held a code — it held a base64 PNG
of the QR image, so `<img src={payment.pixQrCode}>` was the only correct use of a field that read
like a string you could copy. The value the customer *does* copy and paste, the BR Code (EMV
payload), was hidden behind `pixCopiaECola`, a Portuguese name in an otherwise English API.

The normalized `Payment` now exposes:

- `pixQrCodeImage` — base64-encoded PNG of the QR code, for rendering.
- `pixCode` — the BR Code / EMV payload, the copy-paste string.

**Nothing breaks.** `pixQrCode` and `pixCopiaECola` remain on the type as `@deprecated` optional
fields, and every driver (Asaas, Woovi, AbacatePay) populates both the new and the old name with the
same value. Existing code keeps working; move to the new names at your own pace.
