# 모델 벤치마크 갱신 방법론

`CLAUDE.md`의 complete-case 규칙을 실행할 때 읽는다. 모델 제공 여부·context·가격은 `models.json`, 품질 관측과 정규화 근거는 `benchmarks.json`이 소유한다. 벤치마크 미등재는 모델 사용 불가나 성능 0을 뜻하지 않는다.

## 조사 및 채택

1. 현재 카탈로그를 공급자·서비스 티어와 실제 벤더 모델로 구분한다. `providerModelId`/`variantOf`로 입증되는 동일 모델만 연결하고 모델명 유사도만으로 revision·preview·contributor·free·Flash Next를 합치지 않는다. Cursor Auto처럼 실제 모델을 공급자가 고르는 별칭은 고정 모델 성능 필드가 없는 예외다.
2. 기존 출처의 공식 리더보드, 변경 이력, 방법론, 공개 데이터/API, 데이터 재사용 조건을 확인한다. 새 후보는 [OpenEvals](https://huggingface.co/spaces/OpenEvals/find-a-leaderboard) 등으로 찾되 디렉터리 자체를 평가 점수로 취급하지 않는다. 프로젝트 코드의 유지 여부와 공식 평가 결과의 최신성은 별개다.
3. 페이지 갱신일, benchmark release, 모델 출시일, 실제 평가일, 조회일을 구별한다. 인증·유료 호출 없이 가능한 공식 공개 자료를 우선한다. 인증/유료 호출·외부 배포는 별도 권한이 필요하며 HTTP403이나 약관상 수집 금지를 우회하지 않는다.
4. 점수의 측정 주체, 같은 데이터셋/기간, 하네스와 설정, effort/토큰 예산, attempts, fallback·ensemble·추정치 여부를 확인한다. 서로 다른 벤치가 각자 다른 하네스를 쓰는 것은 허용하되 한 출처 안의 비교 조건은 동일해야 한다. 하네스가 모델마다 다른 agent 순위를 모델 단독 품질로 바꾸지 않는다.
5. 비교와 재사용이 가능한 출처만 공통 필수 집합으로 먼저 확정한다. 모든 출처를 강제해 교집합이 없어지면 결과를 임의로 채우거나 조건을 몰래 줄이지 않는다. `sourceAudit`에 채택하지 않은 후보의 정확한 URL과 이유를 기록한다. 기존 출처를 재집계하는 통합지수를 독립 실측으로 추가해 이중 가중하지 않는다.
6. 원자료를 격리 scratchpad에 보관하고 URL·SHA-256·조회일을 기록한다. JSON의 `sources.artifacts`는 그 스냅샷을 식별한다. 공개 자산도 immutable API가 아니므로 다음 조사에서 release 파일·스키마·라이선스를 재확인한다. 데이터 발췌/변형의 출처·라이선스는 소스별로 유지한다.

## 동일 데이터 계약

- `sources`는 정규화에 **모두 필수**인 채택 출처다. `sourceAudit`는 조사했으나 참여하지 않는 출처다. 참여하지 않는 사이트의 수치를 일부 모델에만 추가하지 않는다.
- `models`의 각 항목은 하나의 정확한 모델과 명시된 `effort` 프로필이다. 모든 항목은 동일한 `measurements` source 키와 각 source의 동일한 metric 키를 갖는다. 어떤 필수 값이 없거나 식별이 모호하면 항목 전체를 `excluded`로 옮긴다.
- `measurements.<source>.model`은 원본 행 이름을 보존한다. high·max 같은 설정은 모델마다 지원 의미가 다르므로 이것은 모든 모델의 동일 계산 예산 실험이 아니다. 동일 **모델에 대해서는 출처 간 같은 effort**만 연결하고, 무표기 effort를 default/high/max로 추정하지 않는다.
- 원본에서 non-thinking 여부가 명시된 future cohort는 스키마 계약을 함께 확장해야 한다. 무표기 모델을 비추론 모델로 취급하지 않는다. 한 모델의 다른 effort 값은 해당 프로필의 근거가 아니다.
- `metrics`의 `quality`는 출처당 정확히 하나이며, `context`는 동일하게 확보된 설명용 지표다. `sample-size`는 모든 모델에서 같은 양의 정수여야 하는 과제 수 지표이며, 표본 수가 다르면 제외한다. 비용·토큰·스텝을 품질과 섞지 않는다. 모든 지표는 단위와 좋음의 방향을 명시한다. 0은 실제 관측값일 때만 허용하며 결측 대체값이 아니다.
- `excluded`는 점수가 아니라 제외 사유다. 모델 제공 목록은 유지하고 `benchmarkKey`만 제거한다. `models`와 `excluded`는 겹치면 안 되며, 정규화 모델은 적어도 한 카탈로그 항목이 참조해야 한다. 서비스/문맥 형제는 같은 key를 공유하되 실제 지원하는 effort에만 근거를 노출한다.

## 정규화

현재 방법은 `cohort-min-max`, 출처별 동일 가중치다. source `s`의 품질 원점수 `x(m,s)`와 동일 complete-case 집합 `C`에 대해 다음을 계산한다.

```text
L(s) = min(x(m,s), m ∈ C)
H(s) = max(x(m,s), m ∈ C)

높을수록 좋음: z(m,s) = 100 × (x(m,s) − L(s)) / (H(s) − L(s))
낮을수록 좋음: z(m,s) = 100 × (H(s) − x(m,s)) / (H(s) − L(s))
H(s) = L(s): z(m,s) = 50

sourceScores[s] = round(z(m,s), 6)
score = round(mean(sourceScores), 6)
```

모든 모델은 같은 출처 수와 가중치를 갖는다. 소스 원점수의 0–100 여부와 무관하게 각 소스 안에서 먼저 변환하며, 이 숫자는 **현재 비교 집합 내 상대 위치**다. 0은 최저 상대점이고 실패율 100%가 아니다. 100은 최고 상대점이고 완벽한 모델이 아니다. 여러 과제·하네스의 차이를 없애는 통계적 보정도 아니며, 작은 cohort의 극값에 민감하다. cohort나 평가 버전이 달라진 점수를 시계열상 직접 비교하지 않는다.

`routingTieBandPoints`는 변환된 척도에서의 Fleet 정책이며 통계적 유의수준이 아니다. 기존 2점 정책을 유지하되, 이를 검증된 신뢰구간으로 서술하지 않는다. 원본 효율은 **동일 source의 동일 단위끼리만** 해석하고 서로 다른 하네스의 tokens/task·steps/task를 합산해 효율 순위를 만들지 않는다. 비용은 당시 평가비용이며 현재 공급자 가격·한도·latency가 아니다.

## 2026-09-06 스냅샷

### 참여 출처

| 출처 | 고정 release | 품질 지표 | 동일하게 보존한 설명 지표 |
|---|---|---|---|
| [CursorBench](https://cursor.com/cursorbench) | 3.2 | Score | tokens/task, steps/task, USD/task |
| [LiveBench](https://livebench.ai/#/) | 2026-06-25 | 공식 7분야 평균 | 7개 분야 점수, 입력/출력 tokens/question, USD/question, USD/successful task |

LiveBench raw: [점수](https://livebench.ai/table_2026_06_25.csv), [분야](https://livebench.ai/categories_2026_06_25.json), [비용](https://livebench.ai/cost_2026_06_25.csv). task 점수는 이미 0–100이다. 분야 내부 task 평균 후 **7개 분야 평균**을 계산하며, 23task를 통째로 평균하거나 UI의 선택된 분야 필터를 ingestion에 쓰지 않는다. 새 release의 완전한 task 행과 비용 행만 쓴다. 공개 하네스 안내는 Mini-SWE-Agent/Multi-SWE-Bench이나 최신 release의 실행 commit은 확인되지 않았으므로 특정 commit까지 동일하다고 주장하지 않는다.

LiveBench 사이트는 CC-BY-SA-4.0을 표시한다. `benchmarks.json`의 LiveBench 발췌 및 이를 변형한 데이터는 LiveBench 기여자를 표시하고 같은 조건으로 제공한다. 코드 라이선스로 데이터 이용조건을 덮지 않는다. CursorBench는 공개된 개별 사실의 인용이며 별도 데이터 라이선스가 확인됐다는 뜻은 아니다. 어느 쪽도 문제·답변·전체 실행 로그 재배포 권한을 뜻하지 않는다.

현재 complete-case는 GPT-5.6 Sol/Terra/Luna max, Claude Fable 5 max, Gemini 3.7/3.8 Flash high의 6개다. Claude Opus 5는 LiveBench 비용 원본의 AMPS_Hard 표본이 101개로 다른 모델의 100개와 달라 추가 표본 의미를 확인하기 전까지 제외했다. 이는 낮은 성능이라는 판단이 아니다. 다른 모델은 `excluded`에서 이유를 확인한다. Kimi K2.7 Code에는 양쪽 점수가 있으나 무표기 effort를 자의적으로 채우지 않는다. Fable 5.1과 Sonnet 5의 공식 벤치 결과가 존재하더라도 공급자 catalog identity가 먼저 확인되지 않으면 벤치 갱신만으로 새 모델을 생성하지 않는다.

### 다시 검토할 때의 주의

- Artificial Analysis: [Data Platform Terms](https://artificialanalysiscdn.com/legal/ProDataPlatformTerms.pdf) v1.1(2026-08-19) §§2.4–2.5의 제품 내 데이터 결합/재배포와 모델 선택 guidance 권한이 필요하다. API attribution만으로 해결되지 않는다. `estimated=false`도 no-fallback을 뜻하지 않는다.
- Arena: [약관](https://help.arena.ai/articles/5629909088-terms-of-use) §5의 자동 접근·추출 제한. 별도 허용된 데이터셋을 이용할 때는 그 데이터셋의 라이선스와 최신성을 다시 확인한다.
- Epoch ECI·LLM Stats: 다른 출처·업체 보고를 집계하므로 원점수 출처와 중복을 확인한다. source 하나가 더 생겼다고 독립 증거가 하나 늘어난 것이 아니다.
- Terminal-Bench: 모델별 agent·버전이 다른 제출 순위를 단일 모델 통제 실험으로 만들지 않는다. Vals의 fallback 실행도 별도 시스템이다.
- SWE-rebench HF `leaderboard` dataset은 문제 데이터이며 모델 점수 API가 아니다. SWE-bench 사이트 결과의 NC 조건은 실행 코드 라이선스와 별개다.
- HELM·Open LLM Leaderboard·Aider·EvalPlus 등은 코드나 사이트가 살아 있어도 최신 cohort 점수가 없을 수 있다. 자세한 후보별 상태는 `sourceAudit`가 소유한다.

## 갱신·검증 순서

1. 원자료·출처 계약을 다시 읽고 동일 source/metric/effort 교집합을 확정한다. 불완전한 원자료는 normalized 결과와 섞지 않는다.
2. `benchmarks.json`의 source provenance, `models` 원점수, `normalized`, `excluded`, `sourceAudit`를 함께 갱신한다. `models.json`의 명시적 `benchmarkKey`도 같은 변경에서 맞춘다. 기존 공급자 기능을 제거하는 작업으로 확장하지 않는다.
3. `src/models.ts`의 파서가 동일 matrix, 미지 source/metric, finite 값, 중복·고아 join, 위 산식의 재계산 결과를 검증한다. raw 변경·가중치·멤버 변경은 전체 cohort를 다시 계산하고 내용 기반 스탬프를 바꿔야 한다.
4. Gateway `typecheck`, `test`, `build`를 수행하고 Admiral의 `gateway_models` payload와 판독 지침을 확인한다. 공개 API 경계에서 실제 점수·effort가 전달되는지 검증하며, source 문자열을 pin하는 테스트를 추가하지 않는다.
5. Admiral 지침 원본을 바꿨다면 생성기를 실행하고 해당 테스트·빌드를 확인한다. Console UI를 바꾸지 않았어도 consumer build를 실행한다. UI 동작이 바뀌면 `console-e2e`를 따른다.
6. 결과에는 채택/제외 source, 정규화 모델 수, exact effort, 보간 없음, 데이터가 없는 모델의 처리, 실행하지 않은 검증을 분리해서 기록한다. 외부 추론을 실행하지 않았다면 해당 모델의 실제 공급자 성능을 검증했다고 쓰지 않는다.
