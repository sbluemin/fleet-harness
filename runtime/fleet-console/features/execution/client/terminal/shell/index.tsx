import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { ClientConsoleStateCapability, PersistentComponentContext } from "@fleet-console/sdk/plugin";
import type { ShellOpenAtRequest as ShellCwdHint } from "@fleet-console/sdk/navigation";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";

import { getT } from "../../agent/i18n/index.js";
import { openShellLink, useShellLinkChoice } from "../../agent/link-open.js";
import { notifySharedFallback } from "../../../../browser/client/browser-shared-fallback.js";
import { useBrowserEngine } from "../../../../browser/client/browser-panel-store.js";
import { gestureFromEvent, openInDefaultOsBrowser } from "@fleet-console/link/core";
import { TerminalSurface, type TerminalCarryOver, type TerminalExitInfo } from "../shared/index.js";
import type { TerminalFileLinks } from "../shared/terminal-file-links.js";
import { DEFAULT_SHELL_KEY, endShellSession, getShellSessionSnapshot, readShellSession, useShellSession } from "./shell-session-store.js";
import { requestShellOpenAt, requestShellRestartAt } from "@fleet-console/sdk/navigation/browser";
import "./shell.css";

/**
 * Shell은 Operation이 아니라 대화마다 하나씩 붙는 Console 표면이다.
 *
 * 그래서 durable state에 남지 않고 캡션도 없다 — 칸 머리가 이름을 말하고 닫기를 준다. 어느 Shell 인지는 칸이 놓인
 * 대화(`ctx.conversation.key`)가 정하고, 대화가 없는 자리(폰 배치)는 Console 기본 Shell 을 쓴다. PTY 세션 키는 서버가
 * 그 키에서 짓는다 — 클라이언트는 식별자를 지어내지 않는다.
 */
const SHELL_SURFACE_ID = "shell";
const SHELL_TICKET_PATH = "/api/v1/shell/ticket";
const SHELL_WS_PATH = "/api/v1/terminal/ws";
/** 셀 실측 전의 80열 예산. 마운트 뒤에는 TerminalSurface의 실제 셀 폭으로 갱신한다. */
const SHELL_MIN_PANE_WIDTH = 660;

interface ShellMountState {
  readonly key: string;
  /** 칸이 대화에 놓여 있는가 — 그때만 칸을 닫는 것이 Shell 을 끝낸다(폰의 도구 시트는 치우기만 한다). */
  readonly conversationScoped: boolean;
  readonly cwdHint?: ShellCwdHint;
  /** 이 Shell 이 처음 선 작업 위치(Theater 상대). 대화의 작업 위치가 이것과 달라지면 칸이 한 줄로 알린다. */
  readonly launchedAt: string | null;
  readonly target: HTMLElement | null;
  readonly context: ExpandedSurfaceContext;
}

let shellMounts: ReadonlyMap<string, ShellMountState> = new Map();
const shellMountListeners = new Set<() => void>();
const shellHosts = new Map<string, { readonly host: HTMLDivElement; readonly parking: HTMLDivElement }>();
let lastViewedTheaterId: string | null = null;

/** Shell 첫 열기가 붙잡을 "지금 보는 대화의 Theater" 출처 — 코어가 주입한다(features는 코어를 import하지 않는다). */
export interface ShellViewedTheaterPort {
  readonly get: () => string | null;
  readonly subscribe: (listener: () => void) => () => void;
}

/** 지금 보는 대화의 Theater를 관찰하되 Shell을 옮기지는 않는다. 대화가 없는 자리의 첫 열기에서만 이 좌표를 붙잡는다. */
export function connectShellLaunchContext(state: ClientConsoleStateCapability, viewed: ShellViewedTheaterPort): () => void {
  const update = () => {
    const current = viewed.get();
    if (current !== null) lastViewedTheaterId = current;
    if (!state.getTheaters().some((item) => item.id === lastViewedTheaterId)) lastViewedTheaterId = null;
  };
  update();
  const unsubscribe = viewed.subscribe(update);
  return () => { unsubscribe(); lastViewedTheaterId = null; };
}

function shellKeyOf(context: ExpandedSurfaceContext): string {
  return context.conversation?.key ?? DEFAULT_SHELL_KEY;
}

function publishShellMount(key: string, next: ShellMountState | null): void {
  const current = shellMounts.get(key) ?? null;
  if (current === next) return;
  const map = new Map(shellMounts);
  if (next === null) map.delete(key);
  else map.set(key, next);
  shellMounts = map;
  for (const listener of shellMountListeners) listener();
}

function subscribeShellMount(listener: () => void): () => void {
  shellMountListeners.add(listener);
  return () => shellMountListeners.delete(listener);
}

/**
 * Shell 하나의 상주 자리 — 터미널이 portal 되는 그릇과, 칸이 사라진 동안 그 그릇을 받아 두는 주차장. 주차장은 Shell 마다
 * 따로다: 하나를 함께 쓰면 한 Shell 을 주차할 때의 크기가 다른 Shell 의 xterm 맞춤을 흔든다.
 */
function shellHostFor(key: string): { readonly host: HTMLDivElement; readonly parking: HTMLDivElement } {
  let entry = shellHosts.get(key);
  if (entry) return entry;
  const host = document.createElement("div");
  host.className = "global-shell-persistent-host";
  // 셸 링크는 자체 2행 카드로 처리한다 — 문서 수준 라우터가 가로채지 않는다.
  host.setAttribute("data-fleet-link", "self");
  const parking = document.createElement("div");
  parking.className = "global-shell-parking";
  parking.setAttribute("aria-hidden", "true");
  parking.inert = true;
  document.body.append(parking);
  parking.append(host);
  entry = { host, parking };
  shellHosts.set(key, entry);
  return entry;
}

function disposeShellHost(key: string): void {
  const entry = shellHosts.get(key);
  if (!entry) return;
  shellHosts.delete(key);
  entry.host.remove();
  entry.parking.remove();
}

/** 이 칸이 처음 Shell 을 세울 자리 — 대화의 작업 위치, 대화가 없으면 표면 params·마지막으로 본 Theater 의 루트. */
function launchHintOf(context: ExpandedSurfaceContext): ShellCwdHint | undefined {
  const location = context.conversation?.location;
  if (location) return location.relative === "" ? { theaterId: location.theaterId } : { theaterId: location.theaterId, path: location.relative };
  const theaterId = context.params.cwdTheaterId ?? lastViewedTheaterId;
  return theaterId ? { theaterId } : undefined;
}

function attachShellMount(target: HTMLElement, context: ExpandedSurfaceContext): void {
  const key = shellKeyOf(context);
  const current = shellMounts.get(key) ?? null;
  if (current?.target && current.target !== target && current.context.instanceId !== context.instanceId) {
    // 한 대화의 Shell 은 하나다. 범용 표면 API의 split 요청으로 둘째 칸이 들어와도 기존 터미널을 빼앗지 않고 새 칸만 즉시 거둔다.
    context.close();
    return;
  }
  // 같은 인스턴스의 새 target layout effect가 이전 target cleanup보다 먼저 올 수 있다. 이 시점에
  // DOM을 바로 옮겨 두면 뒤늦은 cleanup은 target 불일치로 무시되고 0×0 주차장을 거치지 않는다.
  const { host } = shellHostFor(key);
  if (host.parentElement !== target) target.append(host);
  // 이 Shell 의 상태를 아직 모르면 읽어 둔다 — 새로고침 뒤 이미 살아 있는 Shell 은 바뀌기 전까지 push 가 오지 않는다.
  if (getShellSessionSnapshot(key) === null) void readShellSession(key);
  const hint = current ? current.cwdHint : launchHintOf(context);
  publishShellMount(key, {
    key,
    conversationScoped: context.conversation !== undefined,
    ...(hint ? { cwdHint: hint } : {}),
    launchedAt: current ? current.launchedAt : context.conversation?.location.relative ?? null,
    target,
    context,
  });
}

function updateShellMount(target: HTMLElement, context: ExpandedSurfaceContext): void {
  const key = shellKeyOf(context);
  const current = shellMounts.get(key);
  if (!current || current.target !== target) return;
  publishShellMount(key, { ...current, target, context });
}

function detachShellMount(target: HTMLElement, context: ExpandedSurfaceContext): void {
  const key = shellKeyOf(context);
  const current = shellMounts.get(key);
  if (!current || current.target !== target) return;
  // 칸이 사라지는 것은(다른 대화로 옮겨 감·칸을 옮김) 터미널을 끝내는 것이 아니다. 마지막 가시 크기를 주차장에 보존하고
  // DOM을 지금 옮긴다 — target이 React 커밋에서 제거된 뒤 effect가 돌면 host도 함께 detached되어 ResizeObserver와 포커스
  // 의미가 흔들린다.
  const entry = shellHosts.get(key);
  if (entry) {
    const rect = entry.host.getBoundingClientRect();
    if (rect.width > 0) entry.parking.style.width = `${rect.width}px`;
    if (rect.height > 0) entry.parking.style.height = `${rect.height}px`;
    entry.parking.append(entry.host);
  }
  publishShellMount(key, { ...current, target: null });
}

/** 칸 인스턴스 id → 그 칸의 Shell. 닫힘 통보는 대화 문맥 없이 오므로 여기서 찾는다. */
function mountOfInstance(instanceId: string): ShellMountState | null {
  for (const mount of shellMounts.values()) if (mount.context.instanceId === instanceId) return mount;
  return null;
}

/**
 * 대화의 칸을 닫는 것은 그 대화의 Shell 을 **끝내는** 것이다(사람의 결정). 돌고 있는 명령이 있으면 칸이 한 번 묻는다
 * (`confirmClose`). 폰의 도구 시트에서 치우는 것은 끝내는 것이 아니다 — 거기서는 셸 안의 `exit`가 끝낸다.
 */
export const shellSurface: ExpandedSurfaceDescriptor = {
  id: SHELL_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("terminal.kind.shell"),
  minPaneWidth: SHELL_MIN_PANE_WIDTH,
  render: (ctx) => React.createElement(ShellSurfaceBody, { ctx }),
  // 명령이 돌고 있는지는 닫는 그 순간 서버에 묻는다 — 서버는 어느 길(키·붙여넣기·IME·프로그램 입력)로 들어간 줄이든 실행된 것을
  // 알고, 프롬프트로 돌아올 때만 알리므로 브라우저의 스냅숏은 늦을 수 있다. 읽지 못하면 모르는 것이니 한 번 묻는다.
  confirmClose: async (closed) => {
    const mount = mountOfInstance(closed.instanceId);
    if (!mount?.conversationScoped) return null;
    const session = await readShellSession(mount.key) ?? getShellSessionSnapshot(mount.key);
    if (session !== null && (!session.open || session.atPrompt)) return null;
    return (locale) => getT(locale)("terminal.shell.closeBusy");
  },
  onClose: (closed) => {
    const mount = mountOfInstance(closed.instanceId);
    if (!mount?.conversationScoped) return;
    publishShellMount(mount.key, null);
    disposeShellHost(mount.key);
    void endShellSession(mount.key);
  },
};

/**
 * Shell 본문은 터미널을 직접 소유하지 않고 상주 호스트가 들어설 자리만 내준다.
 * 칸이 사라져도 상주 호스트의 portal container는 주차장으로 이동할 뿐 unmount되지 않는다.
 */
function ShellSurfaceBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const targetRef = React.useRef<HTMLDivElement>(null);
  // 이 칸의 Shell 은 처음 선 대화의 것이다 — 주차·되돌림은 늘 그 키로 한다(대화가 바뀌는 렌더에서 문맥이 먼저 바뀌어도 새지 않게).
  const mountedCtxRef = React.useRef(ctx);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    attachShellMount(target, mountedCtxRef.current);
    return () => detachShellMount(target, mountedCtxRef.current);
    // target DOM의 수명만 소유한다. ctx 갱신은 아래 effect가 같은 target에 따로 흘린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target || shellKeyOf(ctx) !== shellKeyOf(mountedCtxRef.current)) return;
    mountedCtxRef.current = ctx;
    updateShellMount(target, ctx);
  }, [ctx]);

  return (
    <div className="global-shell-surface">
      <ShellLocationNotice ctx={ctx} />
      <div ref={targetRef} className="global-shell-mount" />
    </div>
  );
}

/**
 * 대화의 작업 위치가 이 Shell 이 선 자리와 달라졌을 때의 한 줄 — 이미 연 Shell 은 그대로 두고(반쯤 친 명령이 다른 저장소에서
 * 돌지 않게) 사람이 고르면 새 위치로 옮긴다. 프롬프트가 비어 있으면 `cd`, 명령이 돌고 있으면 그 Shell 을 끝내고 새로 연다
 * (한 번 더 눌러 확인).
 */
function ShellLocationNotice({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const t = getT(ctx.language ?? "en");
  const key = shellKeyOf(ctx);
  const mount = React.useSyncExternalStore(subscribeShellMount, () => shellMounts.get(key) ?? null, () => null);
  const session = useShellSession(key);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const location = ctx.conversation?.location ?? null;
  if (location === null || mount === null || mount.launchedAt === null || !session?.open) return null;
  if (mount.launchedAt === location.relative) return null;
  const target = location.relative === "" ? { theaterId: location.theaterId } : { theaterId: location.theaterId, path: location.relative };
  const settle = () => {
    const current = shellMounts.get(key);
    if (current) publishShellMount(key, { ...current, launchedAt: location.relative, cwdHint: target });
    setConfirming(false);
  };
  const move = async (restart: boolean) => {
    setBusy(true);
    try {
      const result = await (restart ? requestShellRestartAt(target, { shell: key }) : requestShellOpenAt(target, { shell: key }));
      if (result.ok) settle();
      else if (!restart && (result.reason === "busy" || result.reason === "input_pending")) setConfirming(true);
    } catch {
      // 옮기지 못해도 Shell 은 그대로다. 줄은 남아 다시 누를 수 있다.
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="global-shell-location-notice" role="status">
      <span>{confirming ? t("terminal.shell.locationBusy") : t("terminal.shell.locationChanged")}</span>
      <button type="button" disabled={busy} onClick={() => { void move(confirming); }}>
        {confirming ? t("terminal.shell.locationRestart") : t("terminal.shell.locationOpen")}
      </button>
      {confirming ? <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{t("terminal.shell.locationCancel")}</button> : null}
    </div>
  );
}

/**
 * 콘솔 수명에 붙는 Shell 소유자. 한 Shell 이 처음 열리기 전에는 터미널을 만들지 않고, 한 번 열린 뒤에는 칸이 사라져도
 * (다른 대화로 옮겨 가도) 같은 portal과 TerminalSurface를 주차해 WebSocket·xterm 상태를 보존한다. 대화마다 하나다.
 */
export function PersistentShellHost({ language, theme }: PersistentComponentContext) {
  const mounts = React.useSyncExternalStore(subscribeShellMount, () => shellMounts, () => shellMounts);
  React.useLayoutEffect(() => () => {
    for (const key of [...shellHosts.keys()]) disposeShellHost(key);
    shellMounts = new Map();
  }, []);
  return (
    <>
      {[...mounts.values()].map((mount) => (
        <ShellInstanceHost key={mount.key} mount={mount} language={language} theme={theme} />
      ))}
    </>
  );
}

function ShellInstanceHost({ mount, language, theme }: { readonly mount: ShellMountState; readonly language: PersistentComponentContext["language"]; readonly theme: PersistentComponentContext["theme"] }) {
  const { host } = shellHostFor(mount.key);

  React.useLayoutEffect(() => {
    if (!mount.target || host.parentElement === mount.target) return;
    mount.target.append(host);
  }, [host, mount]);

  // 모바일 Shell 화면(impl-spec S-45: 터미널 + 키 줄, CLI 확인 줄 없음). 표면 컨텍스트에는 모바일 표식이 없어
  // 호스트 계약의 공개 신호(모바일 화면·시트 컨테이너의 data-host-surface)로 가른다. 에이전트 본문과 같은
  // [data-mobile-surface] 범위를 상주 호스트에 달아 터미널 면의 모바일 규칙도 그대로 받는다.
  const mobileShell = mount.target?.closest('[data-host-surface="mobile-screen"], [data-host-surface="mobile-sheet"]') != null;
  React.useLayoutEffect(() => {
    host.toggleAttribute("data-mobile-surface", mobileShell);
  }, [host, mobileShell]);

  // 재시작(restart-at)으로 끝난 PTY 뒤에는 같은 자리에 새 표면을 붙인다 — 새 티켓이 새 PTY를 띄운다.
  const [surfaceKey, setSurfaceKey] = React.useState(0);
  // 재시작으로 갈아 끼운 셸 위에 앞 셸의 흐린 화면과 구분선을 잇는다(K-10). 새 표면이 마운트 때 한 번 쓴다.
  const [carryOver, setCarryOver] = React.useState<TerminalCarryOver | undefined>(undefined);
  React.useEffect(() => {
    if (carryOver) setCarryOver(undefined);
  }, [carryOver]);
  // Shell 링크는 2행 카드(Fleet / 내 브라우저)가 window.confirm을 대신한다.
  const shellLink = useShellLinkChoice(language ?? mount.context.language ?? "en");
  const shellEngine = useBrowserEngine();
  const shellAvailability = React.useMemo(() => ({
    canOffer: shellEngine === null || shellEngine.available,
    isShared: shellEngine !== null && !shellEngine.available && shellEngine.reason === "shared",
  }), [shellEngine]);

  const context = mount.context;
  const key = mount.key;
  const handleExit = (exit: TerminalExitInfo) => {
    const close = shellMounts.get(key)?.context.close;
    // PTY가 끝났다. 사용자가 `exit`로 끝냈으면 서버가 고정을 풀었고(pinned false), 그때는
    // 보존할 세션이 없으니 portal을 내리고 칸도 거둔다. 재시작이 끝낸 것이면 서버가 이미 새 위치를
    // 못 박아 두었으니 칸은 그대로 두고 표면만 새로 붙인다 — 닫았다가 여는 깜빡임도, 열리자마자
    // 옛 종료가 칸을 닫는 경합도 없다.
    void readShellSession(key).then((state) => {
      if (state && !state.open && state.pinned) {
        setCarryOver(exit.transcript ? { transcript: exit.transcript, reason: "replaced", cols: exit.cols } : undefined);
        setSurfaceKey((value) => value + 1);
        return;
      }
      setCarryOver(undefined);
      publishShellMount(key, null);
      disposeShellHost(key);
      close?.();
    });
  };

  const ticketFields = { shell: key, ...(mount.cwdHint ? { cwd: mount.cwdHint } : {}) };
  return createPortal(
    <>
      <TerminalSurface
        key={surfaceKey}
        {...(carryOver ? { carryOver } : {})}
        operationId={key === DEFAULT_SHELL_KEY ? SHELL_SURFACE_ID : `${SHELL_SURFACE_ID}:${key}`}
        ticketPath={SHELL_TICKET_PATH}
        wsPath={SHELL_WS_PATH}
        surface="shell"
        mobile={mobileShell}
        onCellWidth={(width) => context.reportMinPaneWidth?.(Math.ceil(width * 80 + 20))}
        theme={theme ?? context.theme ?? "dark"}
        active={mount.target !== null && context.focused}
        visible={mount.target !== null}
        zoom={1}
        locale={language ?? context.language ?? "en"}
        // 첫 기동에서만 서버가 읽는다 — 이후 cwd는 서버가 못 박아 두므로 대화의 작업 위치가 바뀌어도 셸의 발밑은
        // 움직이지 않는다(바뀌면 칸이 한 줄로 알린다).
        ticketFields={ticketFields}
        onExit={handleExit}
        fileLinks={shellFileLinks(context, key)}
        onOpenLink={(url, at) => {
          // shared 중에는 카드 없이 내 브라우저로 열고 처음 한 번 안내한다.
          if (shellAvailability.isShared) {
            notifySharedFallback();
            openInDefaultOsBrowser(url);
            return true;
          }
          return shellLink.choose(url, at);
        }}
        onOpenLinkDirect={(url, event) => openShellLink(url, gestureFromEvent(event), shellAvailability)}
      />
      {shellLink.card}
    </>,
    host,
  );
}

export const expandedSurfaces = [shellSurface] as const;

/**
 * Shell 출력의 파일 경로 링크. 상대 경로의 기준은 셸이 보고한 cwd(Theater 상대)다. cwd를 보고하지
 * 않는 셸은 spawn 위치에서 이미 떠났을 수 있으므로 상대 경로 링크를 세우지 않고 절대 경로만 남긴다.
 */
function shellFileLinks(context: ExpandedSurfaceContext, key: string): TerminalFileLinks {
  return {
    context: () => {
      const session = getShellSessionSnapshot(key);
      const theaterId = session?.open && session.cwd?.theaterId ? session.cwd.theaterId : null;
      if (!theaterId) return null;
      const cwdRelative = session?.cwdTracked ? session.cwd?.relative ?? null : null;
      return { theaterId, cwdRelative };
    },
    open: (target) => context.navigate.openFile({ ...target, source: "shell" }),
  };
}
