# Reading a `gateway_models` payload

The tool returns facts as JSON and stops there: nothing in the payload recommends a model, and every judgement below is the host's to make. Mechanics — call arguments, name spellings, which dispatch field takes which value — belong to the live tool description; this file owns what the numbers and flags mean once a reading is in hand.

## The payload's frame

- **Models sit under the allowance they spend.** `providers` is keyed by provider id, and the window to read against a model is one in the same entry — never a join across entries.
- **The `claude` entry is always present and serves no roster model by design.** It is the allowance an inherited dispatch — one that named no identity — spends, and therefore the baseline any offload is measured against. It can only be spared by naming another identity, never selected.
- **`revision` moves on deliberate edits only** — exposure, catalog, benchmark refresh, spend priority — never on allowance movement. Equal revisions never mean equal quotas; re-read before a later dispatch instead of carrying a reading forward.
- **Absence is never safety.** A derived field is omitted when the reading could not support it, and `status: "unsupported"` means the allowance could not be read at all — not that it is healthy, and not that it is exhausted either.

## Reading an allowance

- **Read the window that belongs to the model.** Where `constraints.quotaScope` names a pool, take the window whose `scope` matches; otherwise the provider's scope-less window. A window marked `isAggregate` sums sibling pools — it can read healthy while the model's own pool is spent, so it stays out of headroom math.
- **`pressure` is the verdict, and it outranks arithmetic of your own.** `ok` is usable at any percentage; `elevated` is a reason to rebalance toward a lighter provider, not a prohibition; send nothing to `critical` unless every alternative is worse. Re-deriving risk from the raw figures to overrule the verdict is how a healthy provider gets abandoned.
- **Percentages compare only within one clock.** Break a tie between windows sharing a `cadence` by the lower `usedPercent`, and never compare across cadences — a weekly window at 49% early in its week burns hotter than a monthly one at 78% near its reset. `paceRatio` above 1.0 states that directly: the window is being spent faster than its clock refills it.
- **`recoveryHalfLifeMs` prices the drain** — the average lockout bought by emptying this pool now: weeks for a monthly window, hours for a session one. `projectedExhaustionAt` appears only when the current burn lands before the reset; its absence means "lasts to reset", not "unknown".
- **`amounts` are plain counts, never money.**

## Reading quality evidence

Three constraint fields answer three different questions, and none implies another.

- **`benchmark` is measured evidence and outranks the claim.** Its figures are third-party measurements about the vendor model; where they exist at the rung you would request, rank by them — a measured `standard` model above the band beats an unmeasured `flagship` claim. The catalog deliberately carries one benchmark source: figures are harness-relative, so a number from anywhere else never orders against them, and a model the source has not measured carries no figures at all.
- **`capabilityClass` is the provider's own lineup positioning** (`flagship` / `standard` / `light`) — the quality prior where no figures exist. It is absent on routing aliases, whose serving model varies per call; an entry with neither figures nor a class takes no judgment seat.
- **Scores within `routingTieBandPoints` are one band, not an ordering.** Within a band prefer the lower `tokensPerTask`, then let allowance decide. The band is Fleet's own conservative routing policy, not a statistic the source published — do not quote it back as one.
- **Read `caveat` before trusting a standout.** It travels with the figures because it changes what they are evidence of — a contaminated score, an unknown serving rung.
- **An effortless identity's rung table is a range, not a menu.** With no effort control, which measured rung the serving path reaches is unknown — read the spread, not the best row. `overall` figures carry no rung at all and compare across identities, never across efforts.

## Reading lineage and spend

- **`homolineage` marks a Claude-family model**, derived from the model id alone. It decides independence — shared blind spots with a Claude-based subject — and never cost.
- **The provider entry a model sits under decides cost** — whose subscription the run bills to — and never independence. The two come apart: a Claude-lineage identity billed elsewhere is a legitimate way to move spend and a useless way to buy an independent verdict.
- **`providerPriority` is the user's standing spend order, on the allowance axis only.** Listed providers spend first, in order, everywhere allowance decides. It outranks the pressure forecast, `critical` included — the owner chose to drain that allowance — so leave a listed provider only on observed failure: runs returning empty after a retry. It never lifts an identity across a quality band, and an absent field changes nothing.

## Names

`agentTypes` maps each reasoning rung this session registered to the name that selects it (`none` when the model has no effort control), and `modelId` is the model as a value for a field that takes a model rather than a name — including matching the session's own model back to the roster. Which dispatch field takes which spelling is the tool description's contract; take both verbatim from the reading, never reconstructed.

## Gotchas

- **Symptom:** A run on one provider returned nothing at all — no result, no quotable error — while runs elsewhere succeeded.
  **Action:** Read that model's own window: treat `critical` pressure or a percentage near 100 as the explanation and move the work. Do not wait for a message that says exhausted.
  **Why:** There is no exhaustion status. `status` distinguishes reading failures only; a spent pool is visible only in its window's figures, and an empty return after a retry is what exhaustion looks like from here.

- **Symptom:** A provider looked like it had room, but its requests began failing.
  **Action:** Read the window whose `scope` matches the model's `quotaScope`, not the provider's combined figure.
  **Why:** One subscription can bill through separate pools; the `isAggregate` sum reads comfortable while the pool the model draws from is nearly spent.

- **Symptom:** A model just enabled in the Console appears in the reading, but dispatching to it fails with an unknown name.
  **Action:** Dispatch only to identities this session registered at startup; reaching the new model needs a new session.
  **Why:** The tool's own description carries the registration rule — the roster re-reads live while names are frozen at session start — so the gap is a registration boundary, not a stale roster.
