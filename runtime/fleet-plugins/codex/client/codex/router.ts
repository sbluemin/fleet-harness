// W1 스텁: 라우터는 제거됨 — renderer.ts 링크 href 호환용 최소 익스포트.
// W2에서 onRequest 인터셉터 패턴으로 내부 링크를 처리한다.

export function entryPath(id: string): string {
  return `/entry/${encodeURIComponent(id)}`;
}
