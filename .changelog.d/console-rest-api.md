---
section: Changed
---

- [fleet-console] All console backend routes are now served under a unified `/api/v1` prefix, with settings consolidated under `/api/v1/settings/*` and updates under `/api/v1/updates/*`.
- [fleet-console] Carrier settings now accept partial updates through a single `PATCH /api/v1/settings/carriers/:id` endpoint, replacing the four separate single-field mutation routes.
