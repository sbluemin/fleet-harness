
/** 한 프로젝트 경로에 딸린, 플러그인이 쓸 수 있는 데이터 디렉터리. */
export interface WorkspaceDirectory {
  /** 이 워크스페이스의 데이터가 사는 절대 경로. */
  readonly path: string;
  /** 경로를 정규화해 얻은 안정적인 식별자. 같은 프로젝트는 항상 같은 값이다. */
  readonly id: string;
}


export interface WorkspacePaths {
  /**
   * Fleet 데이터 루트. 호스트 공용 디렉터리(`desktop/`·`computer-use/`)가 사는 자리다.
   * 사용자가 Console에서 고르는 값은 여기가 아니라 `consoleDataDir`에 산다.
   */
  readonly fleetDataDir: string;
  /**
   * 이 Console 인스턴스의 슬롯. 설정·자격증명·워크스페이스처럼 그 인스턴스와 수명을
   * 같이하는 것이 사는 자리이고, 채널·체크아웃·override마다 다르다.
   */
  readonly consoleDataDir: string;
  resolveTheaterPath(theaterId: string): string | null;
  /** Objective 이 아직 없는 Theater 의 플러그인 레코드도 다시 찾는다. */
  listTheaterIds?(): readonly string[];
  canonicalizeTheaterPath(cwd: string): string;
  workspaceHash(canonicalCwd: string): string;
  /**
   * 한 프로젝트 경로의 워크스페이스 디렉터리를 만들어 준다(있으면 그대로).
   *
   * 플러그인이 직접 만들면 이름 규칙과 정체성 파일이 호스트와 갈라져, 같은 프로젝트가
   * 두 디렉터리로 나뉜다.
   */
  ensureWorkspaceDirectory(cwd: string): WorkspaceDirectory;
  /**
   * 디렉터리 단위 배타 실행. 같은 저장소를 두 프로세스가 동시에 옮기는 것을 막는다
   * (마이그레이션·압축처럼 중간 상태가 읽히면 안 되는 작업).
   */
  withDirectoryLock<T>(lockDir: string, objectiveRecord: () => T): T;
}
