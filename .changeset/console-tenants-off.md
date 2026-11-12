---
"@adonis-agora/payments": patch
---

The payments console no longer gets a 404 on load with tenancy off. `GET <path>/api/tenants` is now always mounted and answers `{ mode: 'off' }` when tenancy is off, the same way telescope's console answers. The audited organization switch (`POST <path>/api/tenants/:id/select`) is still mounted only with tenancy on.
