export type TranscriptKind = "message" | "tool" | "stage" | "file" | "unknown";

export interface TranscriptEvent {
  readonly ref: string;
  readonly timestamp?: string;
  readonly kind: TranscriptKind;
  readonly summary: string;
  readonly targetPath?: string;
  readonly stage?: string;
  readonly offset: number;
}

export interface SessionOutline {
  eventCount: number;
  fileTouchCount: number;
  stages: string[];
  readonly truncated: boolean;
  readonly gaps?: readonly { readonly startOffset: number; readonly endOffset: number; readonly skippedBytes: number }[];
}
export interface AnalystArtifact { id: string; title: string; html: string; createdAt: string; }
export type AnalystEvent =
  | { type: "chunk"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; title: string; status: string }
  | { type: "artifact"; artifact: AnalystArtifact }
  | { type: "complete" }
  | { type: "error"; error: { code: string; message: string } };

export interface TranscriptIndexerOptions { readonly maxReadBytes?: number; }
export interface SessionToolOptions { readonly capturePath: string; readonly cwd: string; readonly onEvent?: (event: AnalystEvent) => void; }
export interface AnalystSessionOptions extends SessionToolOptions {
  /** Console이 서빙 중인 AI gateway의 절대 URL. 호스트만 아는 값이라 주입받는다. */
  readonly baseUrl: string;
  /** 실행할 게이트웨이 모델 id. 사용자가 Console에서 켠 선별 안에 있어야 한다. */
  readonly model: string;
  readonly effort?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly language?: "en" | "ko";
  /**
   * 분석가 CLI를 띄우는 호스트 포트(`ClaudeGatewaySdkOptions.spawnProcess`와 같은 모양). Console은 이 자식을 자기가
   * 소유한 process group에 두려고 넘긴다. 생략하면 SDK가 스스로 띄운다.
   */
  readonly spawnProcess?: (request: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
  }) => import("node:child_process").ChildProcess;
  /**
   * 테스트 seam. 세션이 조립한 생성 인자를 그대로 받는다 — 인자 없이 받으면 조립 자체가 검증
   * 밖으로 나간다. 타입은 구조적으로 두어 이 패키지의 공개 표면이 SDK 타입을 이름으로 끌어오지
   * 않게 한다.
   */
  readonly createSdk?: (options: {
    readonly baseUrl: string;
    readonly models: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
  }) => Promise<import("@fleet-console/agent-runtime/claude").ClaudeGatewaySdk>;
}
