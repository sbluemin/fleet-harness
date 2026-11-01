import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "../../../../workspace/shared/expanded-surface.js";
import type { ClientConsoleStateCapability } from "../../../../workspace/shared/console-state.js";
import type { PersistentComponentContext } from "../../../../workspace/shared/surface-contracts.js";
import type { ShellOpenAtRequest as ShellCwdHint } from "../../../../workspace/shared/navigation.js";
import * as React from "react";
import { createPortal } from "react-dom";

import { getT } from "../../agent/i18n/index.js";
import { openShellLink, useShellLinkChoice } from "../../agent/link-open.js";
import { notifySharedFallback } from "../../../../browser/client/browser-shared-fallback.js";
import { useBrowserEngine } from "../../../../browser/client/browser-panel-store.js";
import { gestureFromEvent, openInDefaultOsBrowser } from "@fleet-console/link/core";
import { TerminalSurface, type TerminalCarryOver, type TerminalExitInfo } from "../shared/index.js";
import type { TerminalFileLinks } from "../shared/terminal-file-links.js";
import { DEFAULT_SHELL_KEY, endShellSession, getShellSessionSnapshot, readShellSession, subscribeShellSnapshots } from "./shell-session-store.js";
import { parseToolShellKey, toolShellKey } from "../../../shared/shell-key.js";
import { registerCommodoreShellStatusProvider, shellBusyForRemoval, stableShellStatus } from "../../../../workspace/client/theater-tools/shell-status.js";
import { useCommodoreToolTheater } from "../../../../workspace/client/theater-tools/store.js";
import { CommodoreToolsEmptyState } from "../../../../workspace/client/theater-tools/empty.js";
import "./shell.css";

/**
 * Shell은 Objective 대화가 아니라 (사령관, Theater)마다 하나씩 사는 Console 표면이다.
 *
 * 그래서 durable state에 남지 않고 캡션도 없다 — 칸 머리가 이름을 말하고 닫기를 준다. 어느 Shell 인지는
 * 패널이 받은 도구 Theater가 정하고(`tool-shell:commodore:<사령관>:theater:<Theater>`), 그 문맥이 없는
 * 자리(문맥 없이 열리는 폰 배치·옛 호출)는 Console 기본 Shell 을 쓴다. PTY 세션 키는 서버가 그 키에서
 * 짓는다 — 키의 앞부분만 입장 허가가 읽는다.
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
  // 사령관 전용 도구 패널은 (사령관, Theater)의 Shell을 쓴다 — Theater를 옮기면 그 Theater의
  // 세션이 보이고, 돌아오면 먼저 쓰던 세션이 그대로 있다. 문맥이 없으면 Console 기본 Shell이다.
  if (typeof context.commodoreId === "string" && context.commodoreId !== "" && typeof context.theaterId === "string" && context.theaterId !== "") {
    return toolShellKey(context.commodoreId, context.theaterId) ?? DEFAULT_SHELL_KEY;
  }
  return context.conversation?.key ?? DEFAULT_SHELL_KEY;
}

/** 헤드 메뉴의 초록 점과 설정의 해제 확인이 읽는 Theater별 Shell 상태 — 미션 4의 틀에 답을 단다. */
registerCommodoreShellStatusProvider({
  query: (commodoreId, theaterId) => {
    const key = toolShellKey(commodoreId, theaterId);
    const state = key === null ? null : getShellSessionSnapshot(key);
    if (!state) return stableShellStatus(false, false);
    // 프롬프트가 아니면(모르면 포함) 실행 중으로 보고 먼저 묻는다.
    return stableShellStatus(state.open, shellBusyForRemoval(state));
  },
  subscribe: subscribeShellSnapshots,
});

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

/** Shell 표면이 서 있는 사령관 — 표면 문맥이 소유권을 말하고, 없으면 착지 params를 본다. 둘 다 모르면 생략한다. */
function surfaceCommodoreId(context: ExpandedSurfaceContext): string | undefined {
  if (typeof context.commodoreId === "string" && context.commodoreId) return context.commodoreId;
  if (typeof context.params.commodoreId === "string" && context.params.commodoreId) return context.params.commodoreId;
  return undefined;
}

/**
 * 이 칸이 처음 Shell 을 세울 자리 — 도구 Shell은 패널의 Theater 루트에서 못 박는다.
 * 대화의 작업 위치(보는 Theater)는 이제 Shell의 자리를 정하지 않는다: Theater를 옮기는 일은
 * 그 Theater의 세션으로 갈아타는 일이지, 살아 있는 Shell을 옮기는 일이 아니다.
 * 대화가 없는 자리는 예전처럼 표면 params·마지막으로 본 Theater의 루트를 쓴다.
 */
function launchHintOf(context: ExpandedSurfaceContext): ShellCwdHint | undefined {
  const tool = parseToolShellKey(shellKeyOf(context));
  if (tool) return { theaterId: tool.theaterId, commodoreId: tool.commodoreId };
  const ownerId = surfaceCommodoreId(context);
  const owner = ownerId ? { commodoreId: ownerId } : {};
  const location = context.conversation?.location;
  if (location) return location.relative === "" ? { theaterId: location.theaterId, ...owner } : { theaterId: location.theaterId, path: location.relative, ...owner };
  const theaterId = context.params.cwdTheaterId ?? lastViewedTheaterId;
  return theaterId ? { theaterId, ...owner } : undefined;
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
    target,
    context,
  });
}

/**
 * 해제된 Theater의 상주를 거둔다 — 아직 보이는 칸이면 건드리지 않는다. 해제 확인 뒤
 * 서버 세션을 끝낸 호출자가 함께 부른다. 주차된 상주라 다시 열 때 새로 만든다.
 */
export function dropEndedShellMount(key: string): void {
  const mount = shellMounts.get(key);
  if (!mount || mount.target !== null) return;
  publishShellMount(key, null);
  disposeShellHost(key);
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
  render: (ctx) => React.createElement(ShellSurfaceWithTheater, { ctx }),
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
 * 사령관 전용 도구는 (사령관, 도구)의 Theater를 따로 가진다 — 어느 호스트(칸·전체 표면)에서
 * 열어도 타일 머리의 선택기와 같은 값을 읽는다. 세션 키·시작 위치를 Theater마다 갖는 일은
 * 미션 8이 맡고, 여기서는 본문이 보는 Theater와 빈 상태만 맞춘다.
 */
function ShellSurfaceWithTheater({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const toolTheater = useCommodoreToolTheater(ctx.commodoreId ?? null, "global-shell");
  const theaterId = toolTheater.active && toolTheater.resolution !== null && toolTheater.resolution.kind !== "none"
    ? toolTheater.resolution.theaterId
    : ctx.theaterId;
  const bodyCtx = React.useMemo(() => (theaterId === ctx.theaterId ? ctx : { ...ctx, theaterId }), [ctx, theaterId]);
  if (toolTheater.active && toolTheater.resolution?.kind === "none" && ctx.commodoreId) {
    return (
      <div className="global-shell-surface">
        <CommodoreToolsEmptyState commodoreId={ctx.commodoreId} />
      </div>
    );
  }
  return React.createElement(ShellSurfaceBody, { ctx: bodyCtx });
}

/**
 * Shell 본문은 터미널을 직접 소유하지 않고 상주 호스트가 들어설 자리만 내준다.
 * 칸이 사라져도 상주 호스트의 portal container는 주차장으로 이동할 뿐 unmount되지 않는다.
 * 패널의 Theater가 바뀌면 키가 바뀌어 그 Theater의 상주로 갈아탄다 — 먼저 쓰던 상주는
 * 주차장에 남아 돌아오면 이어서 보인다.
 */
function ShellSurfaceBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const targetRef = React.useRef<HTMLDivElement>(null);
  // 이 칸의 Shell 은 처음 선 Theater의 것이다 — 주차·되돌림은 늘 그 키로 한다(문맥이 먼저 바뀌는 렌더에서 새지 않게).
  // Theater가 바뀌면 키가 바뀌므로 아래 effect가 옛 상주를 주차하고 새 상주를 붙인다.
  const mountedCtxRef = React.useRef(ctx);
  const latestCtxRef = React.useRef(ctx);
  latestCtxRef.current = ctx;
  const shellKey = shellKeyOf(ctx);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    attachShellMount(target, latestCtxRef.current);
    mountedCtxRef.current = latestCtxRef.current;
    return () => detachShellMount(target, mountedCtxRef.current);
    // target DOM과 키의 수명만 소유한다. 같은 키의 ctx 갱신은 아래 effect가 같은 target에 따로 흘린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellKey]);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target || shellKeyOf(ctx) !== shellKeyOf(mountedCtxRef.current)) return;
    mountedCtxRef.current = ctx;
    updateShellMount(target, ctx);
  }, [ctx]);

  return (
    <div className="global-shell-surface">
      <div ref={targetRef} className="global-shell-mount" />
    </div>
  );
}

/**
 * 콘솔 수명에 붙는 Shell 소유자. 한 Shell 이 처음 열리기 전에는 터미널을 만들지 않고, 한 번 열린 뒤에는 칸이 사라져도
 * (다른 사령관으로 옮겨 가도) 같은 portal과 TerminalSurface를 주차해 WebSocket·xterm 상태를 보존한다. 도구 키마다 하나다.
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
        objectiveId={key === DEFAULT_SHELL_KEY ? SHELL_SURFACE_ID : `${SHELL_SURFACE_ID}:${key}`}
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
  const commodoreId = surfaceCommodoreId(context);
  return {
    context: () => {
      const session = getShellSessionSnapshot(key);
      const theaterId = session?.open && session.cwd?.theaterId ? session.cwd.theaterId : null;
      if (!theaterId) return null;
      const cwdRelative = session?.cwdTracked ? session.cwd?.relative ?? null : null;
      return { theaterId, ...(commodoreId ? { commodoreId } : {}), cwdRelative };
    },
    open: (target) => context.navigate.openFile({ ...target, source: "shell" }),
  };
}
