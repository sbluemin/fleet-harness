/**
 * 모바일 위키 화면의 쌓인 깊이 — 호스트 막대의 `depth`는 화면 전체 스택의 깊이다(그만큼 history 항목이 쌓인다).
 * 검색(깊이 1)에서 연 문서는 깊이 2로 서야 뒤로가 문서 → 검색 → 목록 순서로 한 단씩 내려온다. 목록과 리더 열이
 * 서로를 모르므로 이 번들 안의 값 하나로 잇는다(호스트와 나누지 않는다).
 */
let searchOpen = false;

export function setWikiSearchOpen(open: boolean): void {
  searchOpen = open;
}

/** 리더 열이 막대에 선언할 깊이 — 목록 위 1단, 검색에서 열었으면 1단 더. */
export function wikiReaderDepth(): number {
  return searchOpen ? 2 : 1;
}
