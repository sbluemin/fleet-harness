---
section: Changed
---

- [fleet-console] Reworked Operation status indicators: removed the unused live state, so carrier streaming now shows as running.
- [fleet-console] Recolored Operation status — awaiting is now aurora (teal) and idle is now green, and an idle panel no longer animates its perimeter.
- [fleet-console] An Operation whose agent turn has ended keeps the running indicator while a carrier job is still streaming, then settles to idle once streaming finishes.
- [fleet-console] An Operation raises an alert when it transitions into idle or awaiting.
