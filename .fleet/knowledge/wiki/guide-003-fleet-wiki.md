---
id: "guide-003-fleet-wiki"
title: "Guide - 003 fleet-wiki 사용법"
tags: ["guide", "fleet-wiki", "fleet-wiki-web", "workflow", "onboarding", "current"]
created: "2026-05-07T15:45:43.577Z"
updated: "2026-05-23T14:47:42.640Z"
version: 5
rawSourceRef: "raw/2026-05-23-guide-003-fleet-wiki-source-d740bf60.md"
rawSourceRefs: "[{\"ref\":\"raw/2026-05-07-guide-003-fleet-wiki-source-fc55d1b9.md\"},{\"ref\":\"raw/2026-05-23-guide-003-fleet-wiki-source-d740bf60.md\",\"title\":\"Guide - 003 fleet-wiki 사용법\",\"hash\":\"d740bf60\"}]"
---
# fleet-wiki 사용법

fleet-wiki는 fleet-harness의 **워크스페이스 로컬 마크다운 지식 베이스**다. Admiral과 캐리어가 작업 중 발견한 지식을 체계적으로 축적하고 조회할 수 있다.

> **핵심 원칙**: 모든 쓰기 작업은 **패치 큐**를 거친다. 어떤 도구도 위키 엔트리를 직접 수정하지 않는다. 인간(대원수)이 승인해야만 반영된다.

---

## 5단계 워크플로우

```
[1] 캡처          → [2] 스테이징       → [3] 검토
    세션에서            wiki_ingest /        wiki_patch_queue
    내용 추출           wiki_compile_source  또는 웹 UI

[4] 승인/반려     → [5] 조회
    approve / reject     wiki_orient
    (패치 큐)            wiki_briefing
                         wiki_read / wiki_query
```

---

## 1단계: 캡처

### 슬래시 명령어로 세션 캡처

1. `/fleet:wiki:menu` 입력
2. **세션 캡처** 선택
3. Admiral이 현재 fleet 세션 내용을 분석하여 `wiki_ingest` 호출

### Admiral에게 직접 요청

대화 중 Admiral에게 "이 내용을 wiki에 저장해줘"라고 지시하면 Admiral이 `wiki_ingest`를 호출한다.

---

## 2단계: 스테이징

### `wiki_ingest` — 단일 엔트리 스테이징

```
wiki_ingest(
  id:    "my-entry-id",
  title: "엔트리 제목",
  body:  "마크다운 본문",
  tags:  ["tag1", "tag2"],
  source: "원본 내용 (immutable raw source)"
)
```

- `mode`: `auto` (기본) / `create` / `update`
- 결과: 패치가 `.fleet/knowledge/queue/{patchId}/` 에 대기

### `wiki_compile_source` — 배치 멀티 페이지 인제스트

대량의 단일 소스에서 여러 위키 페이지를 생성할 때 사용한다.

- `mode=preview`: 드라이런(실제 저장 없음)
- `mode=stage`: 동일 `patch_set_id`로 묶어서 큐에 등록 → `approve_set`으로 일괄 승인 가능

---

## 3단계: 검토

### 큐 목록 확인

```
wiki_patch_queue(action="list")
```

### 패치 상세 확인

```
wiki_patch_queue(action="show", patch_id="...")
```

### 웹 UI로 확인

터미널에서 `fleet-wiki`를 실행하면 브라우저가 자동으로 열린다.

```bash
fleet-wiki                             # 기본 (127.0.0.1:3737)
fleet-wiki --port 4000                  # 포트 지정
fleet-wiki --stop                      # 서버 종료
fleet-wiki --help                      # 옵션 안내
```

| 옵션 | 설명 |
|---|---|
| --port | 서버 포트. 미지정 시 3737 기본 |
| --stop | per-user daemon 전체 종료 (SIGTERM → SIGKILL) |
| --help | 옵션·환경변수·예시 출력 |

환경변수 `FLEET_WIKI_PORT`로도 기본값을 설정할 수 있다. daemon은 per-user로 실행되며 여러 워크스페이스를 동시에 제공할 수 있다.

---

## 4단계: 승인 / 반려

### 단일 패치 승인

```
wiki_patch_queue(action="approve", patch_id="...")
```

### 단일 패치 반려

```
wiki_patch_queue(action="reject", patch_id="...", reason="반려 사유")
```

### 패치 세트 일괄 승인 (`wiki_compile_source`로 생성된 경우)

```
wiki_patch_queue(action="approve_set", patch_set_id="...")
```

승인 시: `wiki/{id}.md` 반영 → 인덱스 재빌드 → `archive/`로 이동  
반려 시: 사유 기록 후 `archive/`로 이동

웹 UI(`/w/:ws/queue/:patchId`)에서도 승인/반려할 수 있다.

---

## 5단계: 조회

### Admiral에게 직접 요청

대화 중 Admiral에게 "wiki에서 XXX 찾아줘" 또는 "XXX에 대해 알고 있는 내용 알려줘"라고 요청하면 Admiral이 `wiki_briefing` / `wiki_read` / `wiki_resolve` / `wiki_query` 를 적절히 조합해 관련 내용을 조회한다.

### `wiki_orient` — 워크스페이스 현황 파악

작업 시작 시 한 번 호출해 전체 엔트리 목록, 스키마, 최근 로그, 큐 대기 수를 확인한다.

### `wiki_briefing` — 키워드 검색

```
wiki_briefing(query="검색어", enhanced=true)
```

- 기본: ID/태그/제목/본문 서브스트링 매칭
- `enhanced=true`: BM25 + 별칭/상태/신선도/그래프 부스팅 추가

### `wiki_read` — 전문 읽기

```
wiki_read(ids=["id1", "id2"], mode="full")
```

| mode | 설명 |
|---|---|
| `full` | 전체 본문 |
| `summary` | 요약만 |
| `facts` | 팩트 목록 |
| `diffable` | diff 비교용 포맷 |

### `wiki_resolve` — 컨텍스트 팩 합성

briefing + read + claims를 묶어 LLM 친화적 컨텍스트 팩으로 반환. `compact_json` 또는 `markdown_pack` 포맷 선택 가능.

### `wiki_query` — 인용 기반 질의

```
wiki_query(question="질문", mode="answer")
```

- `mode=answer`: 증거 + 인용 반환 (위키 변경 없음)
- `mode=stage_answer_page`: 좋은 답변을 `wiki/queries/` 아래 새 페이지로 스테이징

---

## 정합성 검사: `wiki_drydock`

위키 전체 lint를 실행한다. 체크 항목:

- 프론트매터 누락 / 링크 오류
- 큐 정합성 · 고아 페이지 · 중복 별칭
- 스테일(stale) · 폐기(deprecated) · 모순(contradiction) 항목

---

## 웹 UI SPA 경로

Per-user daemon은 여러 워크스페이스를 동시에 제공한다. 각 경로는 워크스페이스 ID(`:ws`)를 포함한다.

| 경로 | 설명 |
|---|---|
| `/` | 웰컴 페이지 (expired workspace 리다이렉션 포함) |
| `/w/:ws/` | 워크스페이스 홈 / 인덱스 |
| `/w/:ws/entry/:id` | 위키 엔트리 조회 |
| `/w/:ws/raw/:ref` | Raw source viewer |
| `/w/:ws/queue` | 패치 큐 목록 (Drydock) |
| `/w/:ws/queue/:patchId` | 패치 상세 · 승인 · 반려 |
| `/w/:ws/conflicts` | 충돌 목록 |
| `/w/:ws/conflicts/:id` | 충돌 상세 |
| `/w/:ws/index-md` | 전체 인덱스 마크다운 |
| `/w/:ws/log` | 활동 로그 |

레거시 경로(`/entry/:id`, `/queue` 등)는 MRU(Most Recently Used) 워크스페이스가 있을 경우 해당 워크스페이스 경로로 리다이렉션된다.

> 서버는 127.0.0.1에만 바인드된다. 웹 UI POST 요청은 Origin 헤더 CSRF 보호가 적용된다.

---

## 관련 항목

- [[wiki:guide-001-fleet-harness-overview]] — fleet-harness 전체 소개
- [[wiki:guide-002-carrier-status]] — Carrier Status 사용법