---
section: Changed
---
- [fleet-console] Redesigned the Codex knowledge panel for the right rail: a compact single-column navigator (search, entry list, Drydock badge, conflicts) replaces the cramped three-pane layout. Selecting an entry opens an inline two-pane split — the document on the left, the navigator still browsable on the right — and an Expand control opens a centered, comfortably wide reading overlay with a table-of-contents rail. The Codex markdown reading style is preserved throughout.
- [fleet-console] Streamlined the Codex backend to four REST resources (search, entry, drydock, conflicts); raw source is now embedded in the entry response and the retired endpoints return 404.
