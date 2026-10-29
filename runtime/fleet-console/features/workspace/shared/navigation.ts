export interface OpenFileRequest {
  readonly objectiveId?: string;
  readonly theaterId: string;
  /**
   * 파일을 품은 Theater를 소유한 사령관. 출처 문맥(Shell 세션·표면 문맥, 창 params)이
   * 아는 경우에만 싣는다 — Theater에서 주인을 추정하지 않는다. 목표 문맥이면 objectiveId만
   * 보내고, 둘 다 모르면 생략해서 서버가 거절하게 한다.
   */
  readonly commodoreId?: string;
  readonly path: string;
  readonly pathKind: "theater-relative" | "absolute";
  readonly line?: number;
  readonly column?: number;
  readonly source: "palette" | "shell" | "agent-terminal" | "agent-chat" | "files" | "other";
}

export type OpenResult = { readonly ok: true } | {
  readonly ok: false;
  readonly reason: "no_handler" | "not_found" | "outside_theater" | "unsupported";
};

export interface ClientNavigateCapability {
  openFile(request: OpenFileRequest): Promise<OpenResult>;
}

/** 전역 Shell의 작업 디렉터리 좌표. Theater는 경로의 경계이지 세션 키가 아니다. */
export interface ShellOpenAtRequest {
  readonly theaterId?: string;
  readonly objectiveId?: string;
  readonly commodoreId?: string;
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
