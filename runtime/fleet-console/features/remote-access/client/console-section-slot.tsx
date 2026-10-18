import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONSOLE_DIRECTORY_CAPABILITY, CONSOLE_SECTION_EVENT, consoleSectionCommandUrl, isConsoleSectionState, type ConsoleSectionState, type ConsoleSectionCommand } from "@fleet-console/protocol/desktop/console-section";
import { isDesktopShell, useDesktopHomeOrigin } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { subscribeRemoteHostsChanged } from "./remote-hosts.js";
import { RemoteConsoleButton } from "./remote-console-button.js";

/** 로컬·원격 모두 같은 단추와 최소 상태 경로를 쓴다. 서버에서 목록을 읽지 않는다. */
export function ConsoleSectionSlot({ compact }: { readonly compact: boolean }) {
  const shell = useDesktopHomeOrigin();
  const { consoleName } = useConsoleState();
  const capable = isDesktopShell() && shell.capabilities.includes(CONSOLE_DIRECTORY_CAPABILITY);
  const [state, setState] = useState<ConsoleSectionState | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Element | null>(null);
  const command = (value: ConsoleSectionCommand) => location.assign(consoleSectionCommandUrl(location.origin, value));
  useLayoutEffect(() => {
    setAnchor(root.current?.closest(".operations-side-bar")?.querySelector("[data-remote-console-anchor]") ?? null);
  }, [compact]);
  useEffect(() => {
    if (!capable) { setState(null); return; }
    const update = (event: Event) => { const value: unknown = (event as CustomEvent).detail; if (isConsoleSectionState(value)) setState(value); };
    window.addEventListener(CONSOLE_SECTION_EVENT, update);
    // 이름·설정 목록이 바뀌어도 표시는 셸이 다시 준 최소 상태만 쓴다.
    const reload = () => command({ request: "state" });
    const unsubscribe = subscribeRemoteHostsChanged(reload);
    window.addEventListener("focus", reload);
    reload();
    return () => { unsubscribe(); window.removeEventListener("focus", reload); window.removeEventListener(CONSOLE_SECTION_EVENT, update); };
  }, [capable, consoleName]);
  const button = capable && state ? <RemoteConsoleButton key={compact ? "compact" : "wide"} state={state} command={command} compact={compact} /> : null;
  return <div ref={root} className={compact && button ? "remote-console-compact-slot" : undefined}>{compact ? button : anchor ? createPortal(button, anchor) : null}</div>;
}
