/**
 * 터미널로 나가는 실패의 공통 형태.
 *
 * 사용자에게 도달하는 실패는 세 조각을 갖는다 — 무슨 일이 있었나(`what`), 왜(`why`),
 * 지금 할 수 있는 일(`next`). 기계 코드나 원시 예외 문자열은 그 자체로 이 셋 중 어느 것도
 * 아니므로 `why` 안에 담기되 문장 대신 근거로만 쓴다.
 */
export interface FailureNotice {
  readonly what: string;
  readonly why: string;
  /** 사용자가 지금 실행하거나 확인할 수 있는 것. 한 줄에 하나씩. */
  readonly next: readonly string[];
}

export function formatFailureNotice(notice: FailureNotice): string {
  const lines = [notice.what, `  Why   ${notice.why}`];
  notice.next.forEach((step, index) => {
    lines.push(`  ${index === 0 ? "Next " : "     "} ${step}`);
  });
  return lines.join("\n");
}

export interface ConsoleLaunchOutcome {
  readonly url: string;
  readonly browserOpened: boolean;
  readonly browserError?: string;
}

/**
 * 데몬은 떴지만 브라우저 실행기가 답하지 않은 경우를 성공과 구분해 말한다. 예전에는 두 경우가
 * 같은 "opened." 한 줄로 나가, 아무것도 뜨지 않은 화면 앞의 사용자에게 주소조차 건네지 않았다.
 */
export function describeConsoleLaunch(successLine: string, outcome: ConsoleLaunchOutcome): string {
  if (outcome.browserOpened) return successLine;
  return formatFailureNotice({
    what: "Fleet Console is running, but no browser opened on this machine.",
    why: outcome.browserError ?? "the browser launcher did not start",
    next: [`Open this address yourself: ${outcome.url}`],
  });
}

export interface DaemonStartFailureInput {
  readonly spawnError: string | null;
  readonly childError: string | null;
  readonly readinessError: string | null;
  readonly probeError: string | null;
  readonly cleanupError: string | null;
  readonly healthyEndpoint: string | null;
  readonly dataDir: string;
  readonly startupTimeoutMs: number;
}

/**
 * 데몬이 뜨지 않았을 때의 문장. 프로세스를 띄우지 못한 것과, 띄웠지만 응답이 없는 것은
 * 사용자가 취할 조치가 서로 다르므로 갈라서 말한다.
 */
export function describeDaemonStartFailure(input: DaemonStartFailureInput): string {
  if (input.healthyEndpoint && input.cleanupError) {
    return formatFailureNotice({
      what: "Fleet Console is running, but startup cleanup failed.",
      why: `another healthy server won startup, but the redundant child could not be stopped — ${input.cleanupError}`,
      next: [
        `Open the running Console: ${input.healthyEndpoint}console/`,
        "Show the current state: fleet console status",
      ],
    });
  }
  if (input.spawnError) {
    return formatFailureNotice({
      what: "Fleet Console server did not start.",
      why: appendCleanup(`the server process could not be spawned — ${input.spawnError}`, input.cleanupError),
      next: [
        "Check that this Node install can run the Console: node --version",
        "Reinstall if the package is incomplete: npm install -g @dotobokuri/fleet-console",
      ],
    });
  }
  const timeout = formatTimeout(input.startupTimeoutMs);
  const reason = input.readinessError
    ? `the readiness check failed — ${input.readinessError}`
    : input.childError
      ? `the server process ended before becoming healthy — ${input.childError}`
      : input.probeError
        ? `it did not become healthy within ${timeout} — ${input.probeError}`
        : `it did not become healthy within ${timeout}`;
  return formatFailureNotice({
    what: "Fleet Console server did not start.",
    why: appendCleanup(reason, input.cleanupError),
    next: [
      `Check that this directory is writable: ${input.dataDir}`,
      "Show the current state: fleet console status",
      "Then try again: fleet console restart",
    ],
  });
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs >= 1_000 && timeoutMs % 1_000 === 0) return `${timeoutMs / 1_000} seconds`;
  return `${timeoutMs} ms`;
}

function appendCleanup(reason: string, cleanupError: string | null): string {
  return cleanupError ? `${reason}; cleanup also failed — ${cleanupError}` : reason;
}
