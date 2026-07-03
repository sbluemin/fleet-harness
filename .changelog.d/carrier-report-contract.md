---
section: Changed
---

- [fleet-carriers] Carriers now wrap their final output in a `<report>` block; `carrier_jobs(format:"full")` extracts and returns only that block, falling back to the full archive when absent, and a new `format:"raw"` option returns the unprocessed archive for debugging.
- [fleet-carriers] Removed redundant echo fields (`action`, `format`, `summary_available`) from `carrier_jobs` responses, and removed derived fields (`attribution`, `available`, `statLine`) from the workspace-changes DTO to reduce response payload size.
