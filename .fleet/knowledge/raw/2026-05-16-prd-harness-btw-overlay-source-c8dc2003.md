---
id: "prd-harness-btw-overlay-source"
created: "2026-05-16T02:16:50.338Z"
sourceType: "inline"
title: "BTW Overlay 정찰 + 모델 선택기 보강 검증 노트"
tags: ["harness", "btw", "overlay", "ephemeral", "model-selector"]
contentHash: "c8dc2003"
---
## /btw Overlay — 사실 노트

### 정의
By The Way의 약자. 호스트 채팅 세션 JSONL을 오염시키지 않고 독립 ACP one-shot 풀에서 다중 턴 질의를 수행하는 ephemeral overlay 슬래시 커맨드.

### 핵심 동작
- Editor 영역을 카드형 overlay로 일시 점유 (메시지 영역은 보존).
- 입력은 draft line, Enter로 전송, 스트리밍으로 응답 표시.
- 직전 대화 컨텍스트를 메모리상 한도(최대 10턴/16KB) 안에서 다음 질의에 자동 포함.
- Esc로 오버레이 종료 시 호스트 세션에 0bytes 잔존.

### 모델 선택기
- Ctrl+L로 드롭다운 오픈, ↑↓/PgUp/PgDn/Home/End로 탐색, Enter로 확정, Esc로 닫기.
- ←→로 reasoning effort 조정.
- 드롭다운 열린 상태에서 타이핑 시 즉시 substring 검색 (provider/모델명/모델 ID 대상, 대소문자 무시).
- Esc 이중 의미: 검색어가 있으면 검색어만 비움, 없으면 드롭다운 닫음.

### 모델 선택기 변경 배경
이전에는 표시 가능 모델이 8개로 하드캡되었고, 페이지 점프 키도 검색 기능도 없어 다수 provider 환경에서 뒷쪽 모델 접근이 사실상 불가능했음. 본 PRD는 스크롤 뷰포트(7행 슬라이딩 윈도우 + cutoff 인디케이터), substring 실시간 검색, 페이지/에지 점프 키, 검색 결과 빈 상태 안내까지 포함한 보강을 요구사항으로 확정.

### UX 가드
- 검색 결과 0건 시 (no matches) 안내, ↑↓/Enter 비활성.
- 현재 위치/총 개수 인디케이터 (선택Index/전체개수).
- 상단 검색어 행에 backspace로 한 글자 삭제 가능.
