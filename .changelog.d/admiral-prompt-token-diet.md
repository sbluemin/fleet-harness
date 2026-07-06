---
section: Changed
---

- [fleet-admiral] [fleet-carriers] Slimmed the always-injected Admiral system prompt by about 19%: the carrier roster now carries selection and routing metadata only, while per-carrier request-block contracts moved to a new on-demand carrier-contracts skill loaded before the first dispatch of a session.
- [fleet-admiral] Unified duplicated Downward Guard trigger lists into the Protocol Gate as the single source, compressed the Context Confidence and Result Integrity Standing Orders without changing their rules, and moved the cross-carrier feedback pattern table into the frontline protocol skill.
- [fleet-admiral] The Protocol Gate now declares skill loading idempotent per session, so already-loaded skill content is applied without reloading.
- [fleet-carriers] Dispatch requests rejected for missing required request blocks now echo the target carrier's full request-block contract in the error, allowing recomposition without a prior contract lookup.
