

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
  /** 그 id 가 지금 있는 사령관인가. 지식은 사령관 UUID 로만 가리키며, 호스트는 Theater 맥락에서 주인을 찾지 않는다. */
  commodoreExists(commodoreId: string): boolean;
  /**
   * 이주 전용 입력: 이 사령관에 대응하는 옛 지식 원본. 아무것도 만들지 않는다. 런타임 위치 해석에는 쓰지 않는다 —
   * 옛 원본은 사령관 이전 시절의 키로 저장되어 있어, 그 대응은 이주 한 번에만 필요하다.
   * resuming은 검증한 기존 저널의 재개에만 사용한다. 여전히 호스트가 확인한 작업 경계 안의 원본이어야 한다.
   */
  legacyKnowledgeSources(commodoreId: string, resuming?: boolean): readonly LegacyKnowledgeSource[];
}
