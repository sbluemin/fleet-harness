# 모델 벤치마크 갱신 방법론

`CLAUDE.md`의 단일 출처 규칙을 실행할 때 읽는다. 모델 제공 여부·context·가격은 `models.json`, 품질 근거는 `benchmarks.json`이 소유한다. 벤치마크 미등재는 모델 사용 불가나 성능 0을 뜻하지 않는다.

## 출처 정책

- 채택 출처는 [LLM Stats](https://llm-stats.com/) 하나다(2026-09-23 소유자 결정). 이전의 CursorBench·LiveBench 다중 출처 complete-case 코호트는 고정 release에 현세대 모델 행이 없어 2개 모델만 남았기 때문에 폐기했다. 다른 출처의 수치를 일부 모델에만 섞지 않는다.
- 공개 웹 페이지에 게시된 값을 옮긴다. LLM Stats [이용약관](https://llm-stats.com/terms)은 상업 목적을 포함한 복사·수정·재게시를 허용하고, 사용자에게 보이는 곳에 llm-stats.com 출처와 링크를 표시하는 것만 요구한다. Console 설정의 위임 라우팅 도움말이 그 표시를 소유한다. API(`api.zeroeval.com`)는 무료·Builder 등급에서 재배포를 금지하므로 수집에 쓰지 않는다.
- 봇 확인이나 접근 제한을 우회하지 않는다. 약관이 바뀌면 채택 여부부터 다시 판단한다.
- 새 후보 출처는 `sourceAudit`에 정확한 URL과 채택하지 않은 이유를 남긴다. Artificial Analysis는 웹사이트 이용약관 §2.2(d)가 수동 전사를 포함한 복제·재배포를 금지하므로 서면 허락 전에는 포함하지 않는다.

## 지표

LLM Stats는 공개 벤치마크와 승인된 커뮤니티 평가를 모델 단위 등급(평균 μ, 불확실성 σ)으로 결합하고, 증거가 적을수록 보수적인 `conservative = μ − 3σ`를 게시한다. `benchmarks.json`은 그 게시값을 가공 없이 보존한다.

| 키 | 페이지 표기 | 원본 지수 | 역할 |
|---|---|---|---|
| `score` | LLM Stats Score | `general` | 품질(라우팅 비교 기준) |
| `reasoning` | Reasoning | `reasoning` | 분야 |
| `coding` | Coding | `code` | 분야 |
| `agents` | Agent | `agents` | 분야 |

- 네 지표는 모든 채택 모델에 모두 있어야 한다. 하나라도 비면 점수를 채우지 않고 `excluded`로 옮긴다.
- 값은 LLM Stats 전체 모집단 위의 같은 척도이므로 Fleet이 cohort 안에서 다시 정규화하지 않는다. 카탈로그 멤버가 바뀌어도 다른 모델의 점수는 변하지 않는다.
- 이 점수의 한계를 소비처에 그대로 전달한다. 산식·가중치가 공개되지 않았고, 업체 보고치와 LLM Stats 자체 검증치가 섞여 있으며, effort를 구분하지 않는다. 새로 출시돼 평가 수가 적은 모델은 σ가 커서 보수적 점수가 낮게 나온다.
- `tieBandPoints`(2)는 Fleet의 라우팅 정책이며 통계적 유의수준이 아니다.

## 등급 재분류

점수가 있는 모델의 `capabilityClass`는 LLM Stats Score 구간이 정한다(`policy.capabilityClassBands`). 현재 구간은 52 이상 `flagship`, 46 이상 `standard`, 그 미만 `light`다. 46은 Claude Sonnet 5(47.90)와 DeepSeek-V4-Flash-Vision-Exp(45.07) 사이, 즉 2026-09-23 코호트에서 tie band(2점)를 넘는 유일한 중간 간격이다. 52는 tie band 안에 놓여 통계적 경계가 아니며, 판단 좌석을 여러 공급자에 나눌 수 있도록 고른 Fleet 정책이다. 게시 점수는 보수적 값이라 평가 수가 적은 신규 모델이 낮게 분류될 수 있으므로, 갱신 때 등급이 함께 바뀐다.

- 파서는 점수가 있는 카탈로그 항목의 등급이 구간과 다르면 로드를 거부한다. 점수를 갱신하면 `models.json`의 등급도 같은 변경에서 맞춘다.
- 점수가 없는 모델만 공급자 라인업 위치 규칙(`architecture-reference.md`)을 따른다.
- 구간을 바꾸면 전체 카탈로그 등급이 바뀌므로 라우팅 영향과 함께 결정하고, 구간 숫자를 적은 Console 설정의 등급 툴팁도 같은 변경에서 맞춘다.

## 모델 식별

- `models`의 키는 LLM Stats model id(`/models/<id>` 경로)다. 카탈로그는 명시적 `benchmarkKey`로만 연결하며 이름 유사도로 자동 매칭하지 않는다.
- 같은 벤더 모델의 서비스 티어·context 형제와 contributor 같은 서빙 경로는 같은 키를 공유한다. revision이 다를 수 있는 행이 둘 이상이고 공급자 모델이 어느 쪽인지 입증되지 않으면 고르지 않고 제외한다(예: DeepSeek-V4-Pro 0813/Max).
- 카탈로그의 정확한 세대만 연결한다. 예를 들어 Claude `opus`가 `claude-opus-5`라면 Opus 5.5 행을 쓰지 않는다.
- 근거는 모델 단위라 effort와 무관하게 모든 effort에 같은 값으로 노출한다. 라우팅은 이 점수로 모델을 비교하고 effort 선택에는 쓰지 않는다. Cursor Auto 같은 라우팅 별칭은 키를 갖지 않는다.

## 갱신·검증 순서

1. `https://llm-stats.com/` 페이지를 저장하고 URL·SHA-256·조회일을 기록한다. 페이지에 임베드된 지수에서 대상 모델의 네 `conservative` 값을 읽고, 페이지 표의 표기값과 일치하는지 대조한다.
2. `benchmarks.json`의 `source`(조회일, 방법론 버전, artifact), `models`, `excluded`, `sourceAudit`를 함께 갱신한다. 카탈로그에서 빠진 모델의 항목은 지운다. `models.json`의 `benchmarkKey`도 같은 변경에서 맞춘다.
3. `src/models.ts`의 파서가 고정 지표 집합, 0–100 범위, 제외 목록과의 중복, 알 수 없는 키, 참조되지 않는 고아 항목을 검증한다. 파일 내용이 바뀌면 `GATEWAY_BENCHMARKS_STAMP`가 자동으로 바뀐다.
4. Gateway `typecheck`, `test`, `build`를 수행하고, 빌드 결과의 공개 API에서 실제 점수가 노출되는지 확인한다. 출처 문자열을 고정하는 테스트는 추가하지 않는다.
5. Console consumer build를 실행한다. UI 동작이 바뀌면 `console-e2e`를 따른다.
6. 결과에는 채택·제외 모델, 식별 판단, 실행하지 않은 검증을 분리해서 기록한다.
