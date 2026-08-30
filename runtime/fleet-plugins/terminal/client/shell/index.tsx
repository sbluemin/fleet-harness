import type { ExpandedSurfaceContext, ExpandedSurfaceDescriptor } from "@fleet-console/sdk/expanded-surface";
import type { PersistentComponentContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";

import { getT } from "../i18n/index.js";
import { TerminalSurface } from "../shared/index.js";
import "./shell.css";

/**
 * Shell은 Operation이 아니라 콘솔 전역 표면이다.
 *
 * 그래서 Theater마다 하나씩 생기지 않고, durable state에 남지 않으며, 캡션도 없다 —
 * 페인 머리가 이름을 말하고 닫기를 준다. PTY 세션 키는 서버가 가진 상수 하나뿐이라
 * 클라이언트는 식별자를 지어내지 않는다.
 */
const SHELL_SURFACE_ID = "shell";
const SHELL_TICKET_PATH = "/plugins/terminal/shell/ticket";
const SHELL_WS_PATH = "/plugins/terminal/ws";
/** 80열이 서지 않는 폭에서는 셸이 셸 노릇을 못 한다. */
const SHELL_MIN_PANE_WIDTH = 360;

interface ShellMountState {
  readonly activated: boolean;
  readonly target: HTMLElement | null;
  readonly context: ExpandedSurfaceContext | null;
}

const EMPTY_SHELL_MOUNT: ShellMountState = { activated: false, target: null, context: null };
let shellMountState = EMPTY_SHELL_MOUNT;
let shellPersistentHost: HTMLDivElement | null = null;
let shellParkingNode: HTMLDivElement | null = null;
const shellMountListeners = new Set<() => void>();

function publishShellMount(next: ShellMountState): void {
  if (shellMountState === next) return;
  shellMountState = next;
  for (const listener of shellMountListeners) listener();
}

function subscribeShellMount(listener: () => void): () => void {
  shellMountListeners.add(listener);
  return () => shellMountListeners.delete(listener);
}

function attachShellMount(target: HTMLElement, context: ExpandedSurfaceContext): void {
  if (
    shellMountState.target
    && shellMountState.target !== target
    && shellMountState.context?.instanceId !== context.instanceId
  ) {
    // Shell은 콘솔 전체에 하나뿐이다. 범용 표면 API의 split 요청으로 둘째 페인이 들어와도
    // 기존 터미널을 빼앗지 않고 새 인스턴스만 즉시 거둔다.
    context.close();
    return;
  }
  // 같은 인스턴스의 새 target layout effect가 이전 target cleanup보다 먼저 올 수 있다. 이 시점에
  // DOM을 바로 옮겨 두면 뒤늦은 cleanup은 target 불일치로 무시되고 0×0 주차장을 거치지 않는다.
  if (shellPersistentHost && shellPersistentHost.parentElement !== target) target.append(shellPersistentHost);
  publishShellMount({ activated: true, target, context });
}

function updateShellMount(target: HTMLElement, context: ExpandedSurfaceContext): void {
  if (shellMountState.target !== target) return;
  publishShellMount({ activated: true, target, context });
}

function detachShellMount(target: HTMLElement): void {
  if (shellMountState.target !== target) return;
  // 닫기는 터미널을 끝내는 것이 아니다. 마지막 가시 크기를 주차장에 보존하고 DOM을 지금
  // 옮긴다 — target이 React 커밋에서 제거된 뒤 effect가 돌면 host도 함께 detached되어
  // ResizeObserver와 포커스 의미가 흔들린다.
  if (shellPersistentHost && shellParkingNode) {
    const rect = shellPersistentHost.getBoundingClientRect();
    if (rect.width > 0) shellParkingNode.style.width = `${rect.width}px`;
    if (rect.height > 0) shellParkingNode.style.height = `${rect.height}px`;
    shellParkingNode.append(shellPersistentHost);
  }
  publishShellMount({ ...shellMountState, target: null });
}

/**
 * 페인을 닫는 것은 셸을 **치우는** 것이지 끝내는 것이 아니다. PTY는 서버에 살아 있고
 * 못 박아 둔 cwd도 그대로라, 다시 열면 하던 자리로 돌아온다 — 레일 아이콘 토글이
 * 곧 이 숨김이다.
 *
 * 셸을 실제로 끝내는 것은 사용자가 셸 안에서 `exit`을 치는 일이고, 그때 PTY가 죽으면
 * 서버가 스스로 고정을 푼다(server/shell.ts의 onExit). 닫기가 세션을 죽이면 잠깐
 * 치워 두는 것과 끝내는 것을 구별할 수 없게 된다.
 */
export const shellSurface: ExpandedSurfaceDescriptor = {
  id: SHELL_SURFACE_ID,
  title: (ctx) => getT(ctx.language ?? "en")("terminal.kind.shell"),
  minPaneWidth: SHELL_MIN_PANE_WIDTH,
  render: (ctx) => React.createElement(ShellSurfaceBody, { ctx }),
};

/**
 * Shell 본문은 터미널을 직접 소유하지 않고 상주 호스트가 들어설 자리만 내준다.
 * 페인이 사라져도 상주 호스트의 portal container는 주차장으로 이동할 뿐 unmount되지 않는다.
 */
function ShellSurfaceBody({ ctx }: { readonly ctx: ExpandedSurfaceContext }) {
  const targetRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    attachShellMount(target, ctx);
    return () => detachShellMount(target);
    // target DOM의 수명만 소유한다. ctx 갱신은 아래 effect가 같은 target에 따로 흘린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useLayoutEffect(() => {
    const target = targetRef.current;
    if (target) updateShellMount(target, ctx);
  }, [ctx]);

  return <div ref={targetRef} className="global-shell-mount" />;
}

/**
 * 콘솔 수명에 붙는 Shell 소유자. 첫 열기 전에는 터미널을 만들지 않고, 한 번 열린 뒤에는
 * 페인을 닫아도 같은 portal과 TerminalSurface를 주차해 WebSocket·xterm 상태를 보존한다.
 */
export function PersistentShellHost({ language, theme }: PersistentComponentContext) {
  const mount = React.useSyncExternalStore(subscribeShellMount, () => shellMountState, () => EMPTY_SHELL_MOUNT);
  const [host] = React.useState(() => {
    const node = document.createElement("div");
    node.className = "global-shell-persistent-host";
    return node;
  });
  const [parking] = React.useState(() => {
    const node = document.createElement("div");
    node.className = "global-shell-parking";
    node.setAttribute("aria-hidden", "true");
    node.inert = true;
    return node;
  });

  React.useLayoutEffect(() => {
    shellPersistentHost = host;
    shellParkingNode = parking;
    document.body.append(parking);
    if (shellMountState.target) shellMountState.target.append(host);
    return () => {
      if (shellPersistentHost === host) shellPersistentHost = null;
      if (shellParkingNode === parking) shellParkingNode = null;
      host.remove();
      parking.remove();
      shellMountState = EMPTY_SHELL_MOUNT;
    };
  }, [host, parking]);

  React.useLayoutEffect(() => {
    if (!mount.activated || !mount.target || host.parentElement === mount.target) return;
    mount.target.append(host);
  }, [host, mount]);

  if (!mount.activated || !mount.context) return null;
  const context = mount.context;
  const handleExit = () => {
    const close = shellMountState.context?.close;
    // PTY가 실제로 끝난 경우에는 보존할 세션이 없다. portal을 내려 다음 열기가 새
    // TerminalSurface와 새 PTY를 만들게 하고, 아직 보이는 페인도 함께 거둔다.
    publishShellMount(EMPTY_SHELL_MOUNT);
    close?.();
  };

  return createPortal(
    <TerminalSurface
      operationId={SHELL_SURFACE_ID}
      ticketPath={SHELL_TICKET_PATH}
      wsPath={SHELL_WS_PATH}
      surface="shell"
      theme={theme ?? context.theme ?? "instrument"}
      active={mount.target !== null && context.focused}
      zoom={1}
      locale={language ?? context.language ?? "en"}
      // 첫 기동에서만 서버가 읽는다 — 이후 cwd는 서버가 못 박아 두므로 Theater를
      // 옮겨 다녀도 셸의 발밑은 움직이지 않는다.
      ticketFields={context.theaterId ? { theaterId: context.theaterId } : undefined}
      onExit={handleExit}
    />,
    host,
  );
}

export const expandedSurfaces = [shellSurface] as const;
