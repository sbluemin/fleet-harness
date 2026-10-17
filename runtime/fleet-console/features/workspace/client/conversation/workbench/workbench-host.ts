import { useEffect, useLayoutEffect } from "react";

import {
  announceExpandedSurfacesClosed,
  bindExpandedSurfaceHost,
  takeUnhostedExpandedSurfaces,
  type ExpandedSurfaceHost,
} from "../../../../../core/client/src/chrome/expanded-surface/store.js";
import { adoptRailToolPanel, bindRailToolHost, type RailToolHost } from "../../../../../core/client/src/chrome/rail/rail-store.js";
import {
  bindWorkbenchSurfaceCloseNotifier,
  closeAllWorkbenchSurfaces,
  closeWorkbenchEntry,
  closeWorkbenchSurfacesOf,
  closeWorkbenchTile,
  flushWorkbenchSaves,
  focusWorkbenchTile,
  getWorkbenchSurfaceSnapshot,
  isWorkbenchEntryOpen,
  loadWorkbenchLayouts,
  openWorkbenchEntry,
  openWorkbenchSurface,
  ownsWorkbenchEntry,
  replaceWorkbenchTileParams,
  revealWorkbenchConversation,
  setWorkbenchConversation,
  setWorkbenchToolEntries,
  subscribeWorkbench,
  toggleWorkbenchEntry,
} from "./workbench-store.js";

/**
 * 대화 칸이 서 있는 동안 작업대를 Console 의 두 입구에 묶는다.
 *
 * - 확대 표면(`surfaces.open` 등 공개 능력, 팔레트, 저장소·Shell 아이콘): 가운데 덮개 대신 지금 대화의 도구 칸으로 선다.
 * - 레일 도구(`rail.open`·단축키·팔레트의 「패널 열기」·파일 착지): 오른쪽 사이드바 슬롯 대신 도구 칸으로 선다. 오른쪽 사이드바의 탭
 *   (대상의 탭·목표·설정)은 도구 목록에 없으므로 그대로 슬롯의 것이다.
 *
 * 묶기 전에 다른 자리(폰 배치·다른 화면·첫 로드의 기억)에 서 있던 표면과 도구는 지금 대화로 넘겨받는다.
 */
const SURFACE_HOST: ExpandedSurfaceHost = {
  state: getWorkbenchSurfaceSnapshot,
  subscribe: subscribeWorkbench,
  open: openWorkbenchSurface,
  close: closeWorkbenchTile,
  closeOf: closeWorkbenchSurfacesOf,
  closeAll: closeAllWorkbenchSurfaces,
  focus: focusWorkbenchTile,
  replaceParams: replaceWorkbenchTileParams,
  reveal: revealWorkbenchConversation,
};

const TOOL_HOST: RailToolHost = {
  owns: ownsWorkbenchEntry,
  open: openWorkbenchEntry,
  toggle: toggleWorkbenchEntry,
  close: closeWorkbenchEntry,
  isOpen: isWorkbenchEntryOpen,
};

export function useConversationWorkbenchHost(conversationKey: string | null, toolEntryIds: readonly string[]): void {
  // 대화가 바뀌면 그 대화의 배치가 선다 — 칠하기 전에 바꿔 앞 대화의 칸이 한 프레임도 남지 않게 한다.
  useLayoutEffect(() => { setWorkbenchConversation(conversationKey); }, [conversationKey]);

  const toolKey = toolEntryIds.join("\n");
  useLayoutEffect(() => {
    setWorkbenchToolEntries(toolEntryIds);
    adoptRailToolPanel();
    // 목록의 내용이 같으면 다시 돌지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolKey]);

  useEffect(() => {
    loadWorkbenchLayouts();
    const releaseClose = bindWorkbenchSurfaceCloseNotifier(announceExpandedSurfacesClosed);
    for (const instance of takeUnhostedExpandedSurfaces()) {
      openWorkbenchSurface({ surfaceId: instance.surfaceId, params: instance.params });
    }
    const releaseSurfaces = bindExpandedSurfaceHost(SURFACE_HOST);
    const releaseTools = bindRailToolHost(TOOL_HOST);
    adoptRailToolPanel();
    const flush = () => flushWorkbenchSaves();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flushWorkbenchSaves();
      releaseTools();
      releaseSurfaces();
      releaseClose();
    };
  }, []);
}
