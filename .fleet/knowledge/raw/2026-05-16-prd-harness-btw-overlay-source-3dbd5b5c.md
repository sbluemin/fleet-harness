---
id: "prd-harness-btw-overlay-source"
created: "2026-05-16T03:03:47.224Z"
sourceType: "inline"
title: "BTW Overlay 정찰 + 모델 선택기 보강 검증 노트"
tags: ["harness", "btw", "overlay", "ephemeral", "model-selector"]
contentHash: "3dbd5b5c"
---
### /btw Ephemeral Overlay 정찰 보고 요약

**1. 개념 및 시나리오**
- `/btw`는 호스트 세션을 오염시키지 않는 독립적인 일시적 쿼리 오버레이임.
- 에디터를 일시적으로 교체하며, 최대 10턴(16KB)의 멀티 턴 대화를 지원함.
- `Esc` 키로 종료 시 대화 내용은 저장되지 않음.

**2. 모델 선택기(Model Selector) 개선 사항 (현재 브랜치)**
- **스크롤**: 기존 8개 하드캡을 제거하고 7행 뷰포트 기반 스크롤 도입.
- **검색**: 실시간 Substring 검색(필터링) 및 첫 매치 자동 포커스 기능 추가.
- **이동**: PgUp/PgDn(7행), Home/End(에지) 이동 키 지원.
- **UI**: 상단 컷오프 인디케이터 및 `(현재/전체)` 상태 표시 추가.
- **지능형 Esc**: 쿼리 텍스트가 있으면 쿼리 삭제, 없으면 드롭다운 닫기.

**3. 기술적 특이사항**
- `fleet:btw:adhoc` 전용 poolKey 사용.
- Pi TUI 위젯이 아닌 오버레이 내부에서 직접 텍스트 렌더링 수행.
