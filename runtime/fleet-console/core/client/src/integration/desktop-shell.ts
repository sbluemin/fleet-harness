import { useEffect, useSyncExternalStore } from "react";

/**
 * 창을 들고 있는 셸이 알려 준 "돌아갈 곳". 원격 콘솔이 서빙한 화면은 자기가 아닌 origin을
 * 스스로 알 수 없으므로, 이 값이 없으면 호스트 스위처에는 돌아가는 줄이 서지 않는다.
 *
 * 이 값은 게시한 창에만 되돌아온다. 다른 사람의 화면에 흘러가면 거기서는 그 사람의 기계를
 * 가리키기 때문이다 — 서버가 요청자를 보고 가리므로, 여기서는 읽어 오기만 한다.
 *
 * 답은 두 길로 온다. 화면이 뜨면서 한 번 묻고, 그 뒤 도착하는 게시는 Operation 스트림의
 * `desktop:shell` 이벤트로 밀려온다. 콘솔이 재기동하면 게시는 사라지고 셸이 다시 게시하는데,
 * 그 순간이 화면의 물음보다 늦으면 첫 답은 빈손이다 — 그 뒤늦은 답을 받는 길이 두 번째다.
 */
export interface DesktopShellHome {
  /** 셸이 게시한 집. 셸이 없거나 아직 게시하지 않았으면 null. */
  readonly origin: string | null;
  /** 아직 답을 받지 못했는가. */
  readonly pending: boolean;
  /** 창을 든 Desktop 앱의 버전. 셸이 없거나 옛 Desktop이면 null. */
  readonly desktopVersion: string | null;
}

type Listener = () => void;

/**
 * "아직 모른다"와 "집이 없다"는 다르다. 둘을 하나의 null로 합치면, 답이 오기 전 잠깐 동안
 * 손님 콘솔이 자기가 집인 것처럼 보인다 — 그 사이 사용자가 칩을 누르면 남의 목록이 펼쳐진다.
 */
let snapshot: DesktopShellHome = { origin: null, pending: true, desktopVersion: null };
const listeners = new Set<Listener>();

function publish(next: DesktopShellHome): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot(): DesktopShellHome {
  return snapshot;
}

/**
 * `reloadToken`이 바뀌면 다시 읽는다. 셸의 게시는 창을 띄우는 마감과 경주하므로 첫 읽기가 버전을
 * 놓칠 수 있다 — 그 값이 필요한 화면(도움말 메뉴)은 열릴 때 한 번 더 묻는다.
 */
export function useDesktopHomeOrigin(reloadToken = 0): DesktopShellHome {
  const home = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const controller = new AbortController();
    void fetchDesktopShell(controller.signal)
      .then((shell) => {
        // 스트림이 먼저 실어 온 집을 뒤늦은 빈 답이 지우지 않는다 — 빈 답은 "아직 게시 전"일 수 있다.
        if (shell.origin === null && snapshot.origin !== null) return;
        publish({ ...shell, pending: false });
      })
      // 끊긴 요청은 답이 아니다 — 이 화면은 이미 사라졌거나 곧 다시 묻는다.
      .catch(() => { if (!controller.signal.aborted && snapshot.pending) publish({ origin: null, pending: false, desktopVersion: null }); });
    return () => controller.abort();
  }, [reloadToken]);

  return home;
}

/** 스트림으로 도착한 게시. 빈 게시는 "모른다"이지 "집이 없다"가 아니므로 이미 아는 집을 지우지 않는다. */
export function applyDesktopShellSnapshot(value: unknown): void {
  const leaving = readLeavingGeneration(value);
  if (leaving !== null) void leave(leaving);
  const origin = readHomeOrigin(value);
  if (origin === null) return;
  publish({ origin, pending: false, desktopVersion: readDesktopVersion(value) ?? snapshot.desktopVersion });
}

/** 떠나기 전에 멈춰야 하는 일 하나. 멈춘 뒤에 끝나는 약속을 돌려준다. */
type LeavingParticipant = () => Promise<void>;
const leavingParticipants = new Set<LeavingParticipant>();
/** 이미 답한 가장 최근 세대. 스트림이 다시 붙으며 옛 알림을 되풀이해도 같은 전환에 두 번 멈추지 않는다. */
let answeredLeaving = 0;

/**
 * 셸이 이 화면을 떠나기 전에 멈춰야 하는 일을 등록한다. 알림은 스트림으로만 온다 — 처음 읽는 게시에 남은
 * 알림은 이미 끝난 전환의 것이다. 등록한 쪽이 없어도 답은 간다: 멈출 것이 없다는 것도 답이다.
 */
export function onDesktopLeaving(participant: LeavingParticipant): () => void {
  leavingParticipants.add(participant);
  return () => { leavingParticipants.delete(participant); };
}

/**
 * 떠나도 된다는 답. 셸은 이 창의 렌더러에서 제목을 직접 읽으므로(runtime/fleet-desktop/src/surface-quiesce.ts의
 * 같은 이름), 같은 콘솔을 연 다른 탭이나 다른 창이 대신 답할 수 없다. 옛 답은 지우고 새 답 하나만 둔다.
 */
export const DESKTOP_LEAVING_ACK_MARK = "\u2064";
const LEAVING_ACK = new RegExp(`${DESKTOP_LEAVING_ACK_MARK}\\d+${DESKTOP_LEAVING_ACK_MARK}`, "gu");

async function leave(generation: number): Promise<void> {
  if (!isDesktopShell() || generation <= answeredLeaving) return;
  answeredLeaving = generation;
  const outcomes = await Promise.allSettled([...leavingParticipants].map((participant) => participant()));
  // 하나라도 멈췄는지 모르면 답하지 않는다 — 셸은 답이 없으면 떠나지 않는다.
  if (outcomes.some((outcome) => outcome.status === "rejected") || generation !== answeredLeaving) return;
  document.title = `${document.title.replace(LEAVING_ACK, "")}${DESKTOP_LEAVING_ACK_MARK}${generation}${DESKTOP_LEAVING_ACK_MARK}`;
}

function readLeavingGeneration(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const surface = (value as Record<string, unknown>).surface;
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) return null;
  const entry = surface as Record<string, unknown>;
  return entry.phase === "leaving" && typeof entry.generation === "number" && Number.isSafeInteger(entry.generation) && entry.generation > 0
    ? entry.generation
    : null;
}

async function fetchDesktopShell(signal?: AbortSignal): Promise<Pick<DesktopShellHome, "origin" | "desktopVersion">> {
  const response = await fetch("/api/v1/desktop/shell", { signal });
  if (!response.ok) return { origin: null, desktopVersion: null };
  const body: unknown = await response.json();
  return { origin: readHomeOrigin(body), desktopVersion: readDesktopVersion(body) };
}

function readDesktopVersion(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>).version;
  return typeof entry === "string" && entry.length > 0 ? entry : null;
}

function readHomeOrigin(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = (value as Record<string, unknown>).homeOrigin;
  if (typeof entry !== "string") return null;
  try {
    return new URL(entry).origin === entry ? entry : null;
  } catch {
    return null;
  }
}

/**
 * 이 창을 Fleet Desktop이 들고 있는가.
 *
 * 원격 콘솔로 건너가는 일은 셸의 인증서 배관을 거쳐야 성립한다. 브라우저 단독으로 그 주소에
 * 항해하면 자체서명 인증서에 막히거나 세션이 없어 401이고, 그 순간 사용자는 멀쩡히 쓰던
 * 로컬 콘솔에서 튕겨 나간다 — 그래서 셸이 없으면 그 동작을 내주지 않는다.
 */
export function isDesktopShell(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
}

/**
 * 이 화면이 본문을 그렸다는 제목 표식. 콘솔을 건너가는 동안 Desktop은 떠나는 화면의 스냅샷을 덮어 두고,
 * 새 화면의 제목이 이 문자로 끝나면 덮개를 걷는다(runtime/fleet-desktop/src/switch-veil.ts의 같은 이름).
 * 문서가 셸에게 말하는 길이 IPC 없이 이것뿐이라 제목을 빌린다 — 보이지 않는 문자라 글자는 늘지 않는다.
 */
export const CONSOLE_READY_TITLE_MARK = "\u2063";
/**
 * 캔버스 본문(월드). 모드 스위치(`[data-canvas-mode]`)는 본문보다 한 프레임 먼저 서므로 그것을 기준으로 삼으면
 * 표식 직후 한 프레임이 빈 셸로 칠해진다(실측).
 */
const CANVAS_BODY_SELECTOR = ".console-shell .operations-canvas-world";

/**
 * 데이터가 섰고(`ready`), 캔버스 화면이라면 그 본문이 DOM에 선 뒤 두 프레임을 기다려 표식을 단다.
 * 데이터만 보고 달면 캔버스가 서기 전에 덮개가 걷혀 빈 셸이 비친다. 한 문서에 한 번이면 된다.
 */
export function useConsoleReadyTitleMark(ready: boolean, awaitCanvas: boolean): void {
  useEffect(() => {
    if (!ready || !isDesktopShell() || document.title.includes(CONSOLE_READY_TITLE_MARK)) return;
    let frame = 0;
    let cancelled = false;
    const mark = (): void => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!cancelled && !document.title.includes(CONSOLE_READY_TITLE_MARK)) document.title = `${document.title}${CONSOLE_READY_TITLE_MARK}`;
        });
      });
    };
    const bodyPresent = (): boolean => !awaitCanvas || document.querySelector(CANVAS_BODY_SELECTOR) !== null;
    if (bodyPresent()) {
      mark();
      return () => { cancelled = true; cancelAnimationFrame(frame); };
    }
    const observer = new MutationObserver(() => {
      if (!bodyPresent()) return;
      observer.disconnect();
      mark();
    });
    observer.observe(document.body, { subtree: true, childList: true });
    return () => { cancelled = true; observer.disconnect(); cancelAnimationFrame(frame); };
  }, [ready, awaitCanvas]);
}
