// 공개 인터페이스/타입 정의 — fs-store primitive 공개 표면

export type Sensitivity = "normal" | "sensitive";

export interface AtomicWriteOptions {
  /** 파일 생성 모드 (기본값: Sensitivity에 따라 0o600 또는 0o644) */
  readonly mode?: number;
  /** fsync 여부 (기본값: true) */
  readonly fsync?: boolean;
  /** 최대 temp 파일명 충돌 재시도 횟수 (기본값: 10) */
  readonly maxAttempts?: number;
}

export interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface DirectoryLockOwner {
  readonly pid: number;
  readonly hostname: string;
  readonly startedAt: number;
}

export interface DirectoryLockDeps {
  /** advisory lock 디렉터리 경로 */
  readonly lockDir: string;
  /** owner 파일명 (기본값: "owner.json") */
  readonly ownerFileName?: string;
  /** 락 획득 대기 타임아웃 ms (기본값: 5000) */
  readonly timeoutMs?: number;
  /** stale lock 판정 임계 ms (기본값: 30000) */
  readonly staleLockMs?: number;
  /** 재시도 간격 ms (기본값: 25) */
  readonly retryMs?: number;
  /** 현재 시각 provider (테스트 주입용) */
  readonly now?: () => number;
}

export interface DurableJsonStore<T> {
  readonly path: string;
  load(): T;
  save(data: T): void;
  /**
   * 락 안에서 read-mutate-write를 수행한다. mutate가 `undefined`를 반환하면 쓰기를 생략하고
   * 읽어 온 현재 값을 그대로 돌려준다 — 바꿀 것이 없다고 판정한 호출이 파일을 새로 만들거나
   * mtime만 흔들지 않게 하려는 것이다. 판정 자체가 락 안에서 일어나야 하므로 호출자가
   * load 후 분기하는 방식으로는 대체할 수 없다(TOCTOU).
   */
  update(mutate: (current: T) => T | undefined): T;
}

export interface CreateDurableJsonStoreDeps<T> {
  readonly filePath: string;
  /** advisory lock 디렉터리 경로. null이면 락 없이 동작 */
  readonly lockDir: string | null;
  /** owner 파일명 (기본값: "owner.json") */
  readonly lockOwnerFileName?: string;
  /** 데이터 sanitize/검증 함수 */
  readonly sanitize: (value: unknown) => T;
  /** 민감도 필수 — sensitive=0o600+0o700, normal=0o644. 우발적 0644 민감 파일 생성 차단 */
  readonly sensitivity: Sensitivity;
  /** 락 타임아웃 ms */
  readonly timeoutMs?: number;
  /** stale lock 임계 ms */
  readonly staleLockMs?: number;
  /** temp 파일 정리 prefix. 제공 시 락 획득 후 cleanup 수행 */
  readonly tempCleanupPrefix?: string;
  /** temp 파일 최소 수명 ms (기본값: 60000) */
  readonly tempCleanupMinAgeMs?: number;
  /** 현재 시각 provider (테스트 주입용) */
  readonly now?: () => number;
}
