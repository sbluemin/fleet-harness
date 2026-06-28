---
section: Changed
---
- [fleet-console] Codex API consolidated from 14 endpoints to 4 REST resources: `GET /api/search` (full index when query is empty, briefingQuery otherwise), `GET /api/entry/:id` (with optional `?include=raw` to embed raw source content inline), `GET|POST /api/drydock[/:id[/decision]]` replacing the former queue actions surface, and `GET /api/conflicts[/:id]` unchanged; all deprecated paths (`/api/health`, `/api/workspaces`, `/api/index`, `/api/index-md`, `/api/log`, `/api/raw`, `/api/queue*`) now return 404/405.
