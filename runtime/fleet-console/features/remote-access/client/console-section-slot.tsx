import { useEffect, useState } from "react";
import { CONSOLE_DIRECTORY_CAPABILITY, CONSOLE_SECTION_EVENT, consoleSectionCommandUrl, isConsoleSectionState, type ConsoleSectionState, type ConsoleSectionCommand } from "@fleet-console/protocol/desktop/console-section";
import { isDesktopShell, useDesktopHomeOrigin } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleState } from "../../../core/client/src/hooks/use-store.js";
import { subscribeRemoteHostsChanged } from "./remote-hosts.js";
import { ConsoleSectionView } from "./console-section.js";
import "./console-section.css";

/** 로컬·원격 모두 같은 DOM과 최소 상태 경로를 쓴다. 서버에서 목록을 읽지 않는다. */
export function ConsoleSectionSlot({ compact }: { readonly compact: boolean }) {
  const shell = useDesktopHomeOrigin();
  const { consoleName } = useConsoleState();
  const capable = isDesktopShell() && shell.capabilities.includes(CONSOLE_DIRECTORY_CAPABILITY);
  const [state, setState] = useState<ConsoleSectionState | null>(null);
  const command = (value: ConsoleSectionCommand) => location.assign(consoleSectionCommandUrl(location.origin, value));
  useEffect(() => {
    if (!capable) { setState(null); return; }
    const update = (event: Event) => { const value: unknown = (event as CustomEvent).detail; if (isConsoleSectionState(value)) setState(value); };
    window.addEventListener(CONSOLE_SECTION_EVENT, update);
    // 이름·설정 목록이 바뀌어도 표시는 셸이 다시 준 최소 상태만 쓴다.
    const reload = () => command({ request: "state" });
    const unsubscribe = subscribeRemoteHostsChanged(reload);
    reload();
    return () => { unsubscribe(); window.removeEventListener(CONSOLE_SECTION_EVENT, update); };
  }, [capable, consoleName]);
  return <div className="side-bar-shared">{capable && state ? <ConsoleSectionView state={state} command={command} compact={compact} /> : null}</div>;
}
