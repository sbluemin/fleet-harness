const STATUS_DETAIL_MAX_LENGTH = 120;
const STATUS_DETAIL_REPORT_DELAY_MS = 500;
const STATUS_DETAIL_ROLLING_LIMIT = 4_096;

interface StatusDetailReporterOptions {
  readonly report: (detail: string) => void;
  readonly delayMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface TerminalStatusDetailReporter {
  readonly push: (data: Uint8Array | string) => void;
  readonly flush: () => void;
  readonly dispose: () => void;
}

export function extractStatusDetail(value: string): string | null {
  const stripped = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:P|X|\^|_)[\s\S]*?\x1b\\/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
  const lines = stripped.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const detail = lines.at(-1);
  if (!detail) return null;
  return detail.slice(0, STATUS_DETAIL_MAX_LENGTH).trim();
}

export function extractMeaningfulStatusDetail(value: string): string | null {
  const lines = value.replace(/\r/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const detail = extractStatusDetail(lines[index] ?? "");
    if (detail && isMeaningfulStatusDetail(detail)) return detail;
  }
  return null;
}

function isMeaningfulStatusDetail(detail: string): boolean {
  if ([...detail].length < 3) return false;
  const semantic = detail.replace(/[\s\p{P}\p{S}\p{M}]/gu, "");
  if (semantic.length < 3) return false;
  const progressOnly = /^[\s\d.,%/|\\()[\]{}<>:=+\-▁▂▃▄▅▆▇█░▒▓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/u.test(detail)
    && /[%▁▂▃▄▅▆▇█░▒▓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(detail);
  return !progressOnly;
}

export function createTerminalStatusDetailReporter(options: StatusDetailReporterOptions): TerminalStatusDetailReporter {
  const decoder = new TextDecoder();
  const delayMs = options.delayMs ?? STATUS_DETAIL_REPORT_DELAY_MS;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let rolling = "";
  let pending: string | null = null;
  let lastReported: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const flush = () => {
    cancelTimer();
    if (disposed || !pending || pending === lastReported) return;
    lastReported = pending;
    options.report(pending);
  };
  // trailing throttle — 활성 타이머는 리셋하지 않는다. push마다 타이머를 재시작하면(디바운스)
  // 연속 출력 동안 보고가 굶어 스트리밍 중에는 tail이 영영 안 갱신된다.
  const schedule = () => {
    if (disposed || timer !== null || !pending || pending === lastReported) return;
    timer = setTimer(flush, delayMs);
  };

  return {
    push: (data) => {
      if (disposed) return;
      const chunk = typeof data === "string" ? data : decoder.decode(data, { stream: true });
      rolling = `${rolling}${chunk}`.slice(-STATUS_DETAIL_ROLLING_LIMIT);
      const detail = extractMeaningfulStatusDetail(rolling);
      if (!detail) return;
      pending = detail;
      schedule();
    },
    flush,
    dispose: () => {
      disposed = true;
      cancelTimer();
    },
  };
}
