---
branch: codex-reading-refit
---

### fleet-console

#### Changed
- Codex reading surfaces now scale document typography to the pane they actually occupy, start with a one-line outline spine that mirrors the current section, and fold long tag rows, so an entry opened in the split pane starts with its body visible instead of a full-screen preamble.
  ko: Codex 읽기 표면이 문서 타이포그래피를 실제 놓인 페인 폭에 맞춰 조절하고, 현재 섹션을 되비추는 한 줄 개요 스파인으로 시작하며, 긴 태그 줄을 접어서, 분할 페인에서 항목을 열면 전주 대신 본문이 바로 보입니다.
- The Codex AI composer dock moved from floating over the document to a fixed row at the reading frame boundary, so it no longer covers the paragraph being read, and its annotation counter appears only when annotations exist.
  ko: Codex AI 컴포저 도크가 문서 위 부유에서 읽기 프레임 경계의 고정 행으로 내려와 읽는 중인 문단을 더 이상 가리지 않으며, 주석 카운터는 주석이 있을 때만 표시됩니다.
- Codex catalog rows read denser: the repeated current status label is gone, the update time sits right-aligned on the title row, exceptional states (draft, deprecated, stale) surface as badges, and tags stay on one line with a +N marker.
  ko: Codex 카탈로그 행이 더 촘촘하게 읽힙니다. 반복되던 current 상태 표기가 사라지고, 갱신 시각이 제목 행 우측에 정렬되며, 예외 상태(초안·폐기·낡음)는 배지로 드러나고, 태그는 +N 표식과 함께 한 줄을 유지합니다.
- Tag chips in a Codex entry header are now buttons that filter the catalog by that tag, and the header timestamp uses the same relative time as the catalog with the absolute date in its tooltip.
  ko: Codex 항목 헤더의 태그 칩이 그 태그로 카탈로그를 거르는 버튼이 되었고, 헤더 시각 표기는 카탈로그와 같은 상대시간을 쓰며 절대 날짜는 툴팁으로 보존됩니다.
