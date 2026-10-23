
/** 화면 맥락을 사령관으로 푼 결과. 맥락 자체를 모르면 `unknown_context`, 사령관을 만들 수 없으면 `unavailable`. */
export type KnowledgeOwnerResult =
  | { readonly ok: true; readonly commodoreId: string }
  | { readonly ok: false; readonly reason: "unknown_context" | "unavailable" };


/** 옛 위치에 남은 지식 원본 하나 — 사령관 지식으로 한 번 옮길 때만 쓴다. */
export interface LegacyKnowledgeSource {
  /** 옛 지식 디렉터리의 절대 경로(`…/knowledge`). */
  readonly path: string;
  /** 진단 문구에 쓰는 짧은 이름. 경로를 싣지 않는다. */
  readonly label: string;
}


export interface KnowledgeHost {
  /** 사령관 id → 그 사령관의 지식 root(`<consoleDataDir>/commodore/{id}/knowledge`). 모르는 id·손상된 엔티티면 null. 부작용 없음. */
  root(commodoreId: string): string | null;
  /** 존재하는 사령관 id 전부. 기동 이주가 순회한다. */
  ids(): readonly string[];
  /**
   * 사람이 지금 보는 화면 맥락(그 화면이 고른 맥락 id)의 사령관. 사령관이 아직 없으면 호스트가 발급해 연결한다.
   * 맥락과 사령관의 대응은 호스트만 안다 — 플러그인은 맥락 id를 해석하지 않는다.
   */
  commodoreForContext(contextId: string): KnowledgeOwnerResult;
  /**
   * 이주 전용 입력: 이 사령관에 대응하는 옛 지식 원본. 아무것도 만들지 않는다. 런타임 위치 해석에는 쓰지 않는다 —
   * 옛 원본은 사령관 이전 시절의 키로 저장되어 있어, 그 대응은 이주 한 번에만 필요하다.
   */
  legacyKnowledgeSources(commodoreId: string): readonly LegacyKnowledgeSource[];
}
