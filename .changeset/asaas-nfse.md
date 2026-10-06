---
"@adonis-agora/payments": minor
---

**Asaas NFS-e provider fixed** (`invoice.asaas()`); it could not schedule a valid note before.

- **Recipient:** sends the Asaas charge as `payment` (when the charge went through Asaas) or the Asaas customer id as `customer` (new `customer.gatewayId`, `cus_…`). It used to send the CPF/CNPJ in `customer`, which Asaas rejects. With neither id, `emit` throws.
- **Required fields:** sends `effectiveDate` (default: today in Brasília), `deductions` (default 0), `observations` and the full `taxes` object (`retainIss`, `iss`, `pis`, `cofins`, `csll`, `inss`, `ir`, plus `nbsCode` and any other key given). Retentions default to none; a missing `tax.iss` throws instead of being sent as 0. `municipalServiceId` / `municipalServiceName` are new optional `service` fields; `cityServiceCode` (or `code`) goes as `municipalServiceCode`. The non-existent `serviceCode` is no longer sent.
- **No more customer data in free text:** the customer's name and e-mail no longer go into `description`/`notes`, and `metadata` no longer goes into `observations`. `serviceDescription` and `observations` carry what you passed.
- **Idempotency:** new `externalReference`; with it, `emit` returns the live note (not cancelled, not `ERROR`) already under that reference instead of scheduling a second one.
- **Response mapping** follows the documented `InvoiceGetResponseDTO`: `number`, `pdfUrl`, and the statuses `SCHEDULED`/`SYNCHRONIZED` → `pending`, `AUTHORIZED`/`PROCESSING_CANCELLATION`/`CANCELLATION_DENIED` → `issued`, `CANCELED` → `canceled`, `ERROR` → `failed`.
- **Webhooks:** the Asaas payments driver maps `INVOICE_*` to `nfse.created|updated|synchronized|authorized|failed|cancellation_processing|canceled|cancellation_denied`, with the note on `event.data` (`gatewayId`, `status`, `providerStatus`, `number`, `pdfUrl`, `xmlUrl`, `paymentId`, `customerId`, `externalReference`, `statusDescription`…).

**Contract:** `InvoiceProvider` gains `cancel(invoiceId, options?: { reason?, providerOnly? })` (Asaas: `POST /invoices/{id}/cancel`, `providerOnly` = `cancelOnlyOnAsaas`; the other built-in providers throw "not supported"). A custom `InvoiceProvider` must add the method. `InvoiceEmitInput` and `InvoiceOptions` gain the optional `effectiveDate`, `deductions`, `observations`, `externalReference`, `customer.gatewayId`, `service.municipalServiceId` and `service.municipalServiceName`; `tax` is now typed as `InvoiceTaxes` (still open to other keys).
