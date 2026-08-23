---
branch: codex-refit
---

### fleet-console

#### Added
- Codex reading deck: expanding a wiki document now anchors it over the canvas as a non-modal work surface with a left outline, a reading-width column, and the catalog kept alive in the rail.
  ko: Codex 리딩 덱 — 위키 문서를 확대하면 캔버스 위 비모달 작업면으로 정박하며, 좌측 아웃라인·읽기 폭 본문·레일 카탈로그 병존을 제공합니다.
- Codex drydock review now shows a rendered diff against the current document with a changes-only toggle, and queue rows carry the proposer and a line diffstat.
  ko: Codex 드라이독 검토가 현행 문서 대비 렌더 diff(변경만 토글 포함)를 보여주고, 대기열 행에 제안자와 라인 diffstat이 표시됩니다.
- Codex drydock queue gained a decided-history segment, so approved and rejected patches stay reviewable after the decision.
  ko: Codex 드라이독 대기열에 결정 이력 세그먼트가 생겨 승인·반려된 패치를 결정 후에도 다시 볼 수 있습니다.
- Codex wiki links now open a hover preview card, and each document lists the entries that reference it as backlinks.
  ko: Codex 위키 링크에 호버 미리보기 카드가 붙고, 각 문서가 자신을 참조하는 항목을 백링크로 보여줍니다.

#### Changed
- Codex patch approval controls moved into a sticky decision dock at the top of the review, so the evidence and the decision stay on one screen.
  ko: Codex 패치 승인 컨트롤이 검토 상단의 고정 결정 독으로 옮겨져 근거와 결정 수단이 한 화면에 머뭅니다.
- Codex navigator condensed its health sentence into an always-visible status chip with a conflict-count badge, and groups entries by freshness with drafts and retired entries set apart.
  ko: Codex 내비게이터의 헬스 문장이 상시 노출 상태 칩·충돌 배지로 응축되고, 목록이 신선도 그룹(초안·폐기 분리)으로 정리됩니다.
- Codex conflict detail now renders a block comparison of the current and proposed texts instead of two stacked full copies.
  ko: Codex 충돌 상세가 전문 두 벌 나열 대신 현행·제안 블록 비교로 렌더됩니다.

#### Fixed
- Codex search excerpts no longer start mid-word and collapse line breaks into single spaces.
  ko: Codex 검색 발췌가 단어 중간에서 시작하지 않고 줄바꿈을 단일 공백으로 접습니다.
