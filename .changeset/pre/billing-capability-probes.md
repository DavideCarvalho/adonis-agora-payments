---
'@adonis-agora/payments': patch
---

The billing store's "is this table/column installed?" probes no longer skip dispute, audit and ledger writes silently. They used a catalog lookup that only saw the connection's current schema, so a model with a qualified `static table` (or one living in another schema) read as "not installed" and its rows were never written. The probe now queries through the model itself, resolving the table exactly as the write does. When something really is missing: with `autoCreateSchema` on the write fails with an error naming the table (the model points somewhere the DDL did not create); with it off the write is skipped as before, with a warning logged once per process.
