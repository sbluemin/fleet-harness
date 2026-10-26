export interface OpenFileRequest {
  readonly objectiveId?: string;
  readonly theaterId: string;
  readonly path: string;
  readonly pathKind: "theater-relative" | "absolute";
  readonly line?: number;
  readonly column?: number;
  readonly source: "palette" | "shell" | "agent-terminal" | "agent-chat" | "codex" | "files" | "other";
}

export interface OpenWikiEntryRequest {
  readonly theaterId: string;
  readonly entryId: string;
  /**
   * true면 문서를 여는 주소 이동이 history 항목을 새로 쌓지 않는다. 폰 목적지 화면은 루트끼리 옮길 때 history를 늘리지 않으므로
   * (호스트 모바일 뒤로 계약), 다른 목적지에서 위키로 옮겨 가는 쪽이 싣는다. 쌓으면 그 항목이 떠나 온 목적지의 주소를 품고 남아,
   * 뒤로가 그것을 걷으며 주소만 옛 목적지로 돌아간다. 생략하면 쌓는다(데스크톱의 뒤로로 이전 문맥에 돌아간다).
   */
  readonly replace?: boolean;
}

export type OpenResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "no_handler" | "not_found" | "outside_theater" | "unsupported";
};

export interface ClientNavigateCapability {
  openFile(request: OpenFileRequest): Promise<OpenResult>;
  openWikiEntry(request: OpenWikiEntryRequest): Promise<OpenResult>;
}

/** 전역 Shell의 작업 디렉터리 좌표. Theater는 경로의 경계이지 세션 키가 아니다. */
export interface ShellOpenAtRequest {
  readonly theaterId?: string;
  readonly objectiveId?: string;
  readonly path?: string;
}

export type ShellOpenAtResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "busy" | "input_pending" | "read_only" | "not_found" | "outside_theater";
};

export interface ClientShellCapability {
  openAt(request: ShellOpenAtRequest): Promise<ShellOpenAtResult>;
  /**
   * 실행 중인 프로그램을 포함해 현재 Shell 세션을 끝내고 요청 위치에서 새 Shell을 연다.
   * 파괴적 동작이다 — 호출 쪽은 반드시 사용자의 명시적 확인을 받은 뒤에만 부른다.
   */
  restartAt(request: ShellOpenAtRequest): Promise<ShellOpenAtResult>;
}
