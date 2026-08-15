/**
 * 부팅이 끝내 실패했을 때 사용자에게 남기는 말.
 *
 * Finder나 트레이로 실행하면 stderr는 어디에도 보이지 않는다 — 창도, 설명도 없이 앱이 사라지면
 * 사용자에게 남는 정보가 없다. 실패 코드를 무슨 일 · 왜 · 지금 할 일 세 조각으로 옮겨,
 * 종료하기 전에 한 번은 말하고 끝낸다.
 */
export interface BootFailureNotice {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export interface BootFailureDialogDependencies {
  readonly showErrorBox: (title: string, content: string) => void;
  readonly exit: (code: number) => void;
  /** 자세한 원인이 적힌 로그 파일의 디렉터리. 사용자가 열어 볼 수 있는 자리다. */
  readonly logDirectory?: string | null;
}

export function describeBootFailure(error: unknown, logDirectory?: string | null): BootFailureNotice {
  const code = error instanceof Error ? error.message : String(error);
  const where = logDirectory ? `\n\nDiagnostic log: ${logDirectory}` : "";
  if (code === "managed_node_engine_unsupported") {
    return {
      title: "Fleet Console Desktop could not start",
      message: "The managed Node runtime does not match what this Console build requires.",
      detail: `Install the latest Fleet Console Desktop release, which ships a matching runtime.${where}`,
    };
  }
  return {
    title: "Fleet Console Desktop could not start",
    message: "Startup stopped before the Console window opened.",
    detail: `Try opening it again. If it keeps failing, reinstall from the latest release.${where}\n\nReported cause: ${code}`,
  };
}

export function showBootFailureAndExit(error: unknown, dependencies: BootFailureDialogDependencies): void {
  const notice = describeBootFailure(error, dependencies.logDirectory ?? null);
  try {
    dependencies.showErrorBox(notice.title, `${notice.message}\n\n${notice.detail}`);
  } catch {
    // 다이얼로그를 띄우지 못하는 상황이라도 종료 처리는 그대로 진행한다.
  } finally {
    dependencies.exit(1);
  }
}
