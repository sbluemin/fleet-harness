# Reading a `gateway_models` payload

The tool returns facts as JSON and stops there: nothing in the payload recommends a model, and every judgement below is the host's to make. Mechanics — call arguments, name spellings, which dispatch field takes which value — belong to the live tool description; this file owns what the numbers and flags mean once a reading is in hand.

## The payload's frame

- **Models sit under the allowance they spend.** `providers` is keyed by provider id, and the window to read against a model is one in the same entry — never a join across entries.
- **The `claude` entry is always present and serves no roster model by design.** It is the allowance an inherited dispatch — one that named no identity — spends, and therefore the baseline any offload is measured against. It can only be spared by naming another identity, never selected.
- **`revision` moves on deliberate edits only** — exposure, catalog, benchmark refresh, spend priority — never on allowance movement. Equal revisions never mean equal quotas; re-read before a later dispatch instead of carrying a reading forward.
- **Absence is never safety.** A derived field is omitted when the reading could not support it, and `status: "unsupported"` means the allowance could not be read at all — not that it is healthy, and not that it is exhausted either.

## Reading an allowance

- **Read every window that binds the model.** Where `constraints.quotaScope` names a pool, the window whose `scope` matches is the binding one; otherwise every non-aggregate window in the entry binds at once — a provider can meter a session clock beside a weekly or monthly one — and the most restrictive verdict among them governs the dispatch, however healthy the other cadences read. A window marked `isAggregate` sums sibling pools — it can read healthy while the model's own pool is spent, so it stays out of headroom math.
- **`pressure` is the verdict, and it outranks arithmetic of your own.** `ok` is usable at any percentage; `elevated` is a reason to rebalance toward a lighter provider, not a prohibition; send nothing to `critical` unless every alternative is worse. Re-deriving risk from the raw figures to overrule the verdict is how a healthy provider gets abandoned.
- **Percentages compare only within one clock.** Break a tie between windows sharing a `cadence` by the lower `usedPercent`, and never compare across cadences — a weekly window at 49% early in its week burns hotter than a monthly one at 78% near its reset. `paceRatio` above 1.0 states that directly: the window is being spent faster than its clock refills it.
- **`recoveryHalfLifeMs` prices the drain** — the average lockout bought by emptying this pool now: weeks for a monthly window, hours for a session one. `projectedExhaustionAt` appears only when a computable average burn lands before the reset, so its absence states "lasts to reset" only while `paceRatio` sits beside it; with no pace figure the absence is the frame rule above — could not tell, never safe.
- **`amounts` are plain counts, never money.**

## Reading quality evidence

Three constraint fields answer three different questions, and none implies another.

- **`benchmark`는 같은 조건의 완전한 자료로 계산한 상대 지표다.** `sources`의 모든 출처와 필수 지표를 갖춘 `cohortSize`개 모델만 `method`에 따라 정규화한다. `sourceScores`는 출처별 상대점수, `score`는 동일 가중 평균이다. 서로 다른 원점수를 직접 평균하거나 다른 cohort·버전의 점수와 비교하지 않는다. 0과 100은 비교 집합의 상대 위치이지 실패율·정확도가 아니다.
- **`effort`가 실제 선택과 같을 때만 해당 benchmark를 적용한다.** 다른 effort의 점수나 무표기 설정을 대신 쓰지 않는다. 현재 노출에 측정된 effort가 없다면 근거도 전달되지 않는다. 출처들이 같은 모델에 동일 effort를 측정했다는 뜻이지, 서로 다른 모델의 max/high가 같은 계산 예산이라는 뜻은 아니다.
- **`capabilityClass`는 공급자의 라인업 주장이다** (`flagship` / `standard` / `light`). 비교 가능한 benchmark가 없는 선택의 사전 근거이며 정량 점수로 변환하지 않는다. 미측정 모델을 상대점수 0으로 취급하거나 측정된 모델보다 자동 열등하다고 판정하지 않는다. 실제 모델이 바뀌는 라우팅 별칭에는 고정 모델 근거가 없다.
- **`routingTieBandPoints` 이내는 한 묶음이다.** 같은 normalized cohort·effort 프로필 사이에서 적용한 뒤 allowance로 선택한다. 이 밴드는 Fleet 정책이지 통계적 유의수준이 아니다. 하네스별 raw tokens/task·steps/task를 합친 효율 숫자를 만들지 않으며, 벤치 비용을 현재 구독의 가격·한도로 대체하지 않는다.
- **`caveat`와 `observedAt`을 함께 읽는다.** 정규화는 과제·하네스 차이를 없애는 인과적 보정이 아니고, 공개 사이트 관측이 실제 Fleet serving 성능이나 공급자 호출 성공을 입증하지도 않는다. 데이터가 부족해 benchmark가 없으면 다른 source의 부분 점수로 빈칸을 채우지 않는다.

## Reading lineage and spend

- **`homolineage` marks a Claude-family model**, derived from the model id alone. It decides independence — shared blind spots with a Claude-based subject — and never cost.
- **The provider entry a model sits under decides cost** — whose subscription the run bills to — and never independence. The two come apart: a Claude-lineage identity billed elsewhere is a legitimate way to move spend and a useless way to buy an independent verdict.
- **`providerPriority` is the user's standing spend order, on the allowance axis only.** Listed providers spend first, in order, everywhere allowance decides. It outranks the pressure forecast, `critical` included — the owner chose to drain that allowance — so leave a listed provider only on observed failure: runs returning empty after a retry. It never lifts an identity across a quality band, and an absent field changes nothing.

## Names

`agentTypes` maps each exposed reasoning rung to the name that selects the identity (`none` when the model has no effort control), and `modelId` is the model as a value for a field that takes a model rather than a name — including matching the session's own model back to the roster. The names are candidate selectors, not proof of registration: they are derived live from the exposure while the agent registry froze at session start, so confirm a name is one this session actually carries before dispatching on it. Which dispatch field takes which spelling is the tool description's contract; take both verbatim from the reading, never reconstructed.

## Gotchas

- **Symptom:** A run on one provider returned nothing at all — no result, no quotable error — while runs elsewhere succeeded.
  **Action:** Read that model's own window: treat `critical` pressure or a percentage near 100 as the explanation and move the work. Do not wait for a message that says exhausted.
  **Why:** There is no exhaustion status. `status` distinguishes reading failures only; a spent pool is visible only in its window's figures, and an empty return after a retry is what exhaustion looks like from here.

- **Symptom:** A provider looked like it had room, but its requests began failing.
  **Action:** Read the window whose `scope` matches the model's `quotaScope`, not the provider's combined figure.
  **Why:** One subscription can bill through separate pools; the `isAggregate` sum reads comfortable while the pool the model draws from is nearly spent.

- **Symptom:** A model just enabled in the Console appears in the reading, but dispatching to it fails with an unknown name.
  **Action:** Select it by `modelId` where the dispatching surface takes a model as a value; a registered *name* for it exists only in a new session.
  **Why:** The tool's own description carries the registration rule — the roster re-reads live while names are frozen at session start — so the gap is a name-registration boundary, not a stale roster and not an unreachable model; `modelId` exists in the payload precisely for this case.
