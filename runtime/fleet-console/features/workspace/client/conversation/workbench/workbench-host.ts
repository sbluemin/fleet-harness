import { useEffect, useLayoutEffect } from "react";

import {
  announceExpandedSurfacesClosed,
  bindExpandedSurfaceHost,
  takeUnhostedExpandedSurfaces,
  type ExpandedSurfaceHost,
} from "../../../../../core/client/src/chrome/expanded-surface/store.js";
import { adoptRailToolPanel, bindRailToolHost, type RailToolHost } from "../../../../../core/client/src/chrome/rail/rail-store.js";
import { closePane, getPaneStoreSnapshot, openPane } from "../../../../../core/client/src/chrome/pane/pane-store.js";
import { setActiveShellKey } from "../../../../execution/client/terminal/shell/shell-session-store.js";
import {
  bindWorkbenchSurfaceCloseNotifier,
  closeAllWorkbenchSurfaces,
  closeWorkbenchEntry,
  closeWorkbenchSurfacesOf,
  closeWorkbenchTile,
  flushWorkbenchSaves,
  focusWorkbenchTile,
  getWorkbenchKey,
  getWorkbenchSurfaceSnapshot,
  isWorkbenchEntryShown,
  isWorkbenchSurfaceShown,
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
  isShown: isWorkbenchSurfaceShown,
  subscribe: subscribeWorkbench,
  open: openWorkbenchSurface,
  // 표면이 스스로 부르는 닫기(`ctx.close()`·셸 종료)는 묻지 않는다. 사람이 닫는 길은 칸의 단추·도구 아이콘이다.
  close: (instanceId) => closeWorkbenchTile(instanceId, { confirmed: true }),
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
  isOpen: isWorkbenchEntryShown,
};

/**
 * 대화마다 열어 둔 문서(파일·Codex 의 문서 칸 같은 페인 인스턴스) — 페인 상태는 한 벌이라, 대화를 떠날 때 보이던 페인을
 * 적어 두고 돌아올 때 다시 세운다. 떠나는 칸이 자기 문서를 닫는 정리(레일 표면의 departing sweep)가 끝난 뒤에 세운다.
 * 화면 수명 동안만 기억한다.
 */
const panesByConversation = new Map<string, readonly { readonly paneId: string; readonly params: Readonly<Record<string, string>> }[]>();

export function useConversationWorkbenchHost(conversationKey: string | null, toolEntryIds: readonly string[]): void {
  // 대화가 바뀌면 그 대화의 배치가 선다 — 칠하기 전에 바꿔 앞 대화의 칸이 한 프레임도 남지 않게 한다.
  useLayoutEffect(() => {
    const leaving = getWorkbenchKey();
    if (leaving !== (conversationKey ?? "console")) {
      const visible = getPaneStoreSnapshot().rail.filter((pane) => pane.visible);
      panesByConversation.set(leaving, visible.map((pane) => ({ paneId: pane.paneId, params: pane.params })));
      // 떠나는 대화의 칸은 주차한다 — keepAlive 문서처럼 칸이 사라져도 남는 페인이 도착하는 대화에 그대로 뜨지 않게. 닫힘 통보는 보내지
      // 않는다(플러그인이 그 대화의 문서를 잊으면 돌아왔을 때 되살릴 수 없다). 도착하는 대화에는 아래에서 그 대화의 세트만 다시 세운다.
      for (const pane of visible) closePane(pane.paneId, { keepAlive: true });
    }
    setActiveShellKey(conversationKey);
    setWorkbenchConversation(conversationKey);
  }, [conversationKey]);
  useEffect(() => {
    const saved = panesByConversation.get(conversationKey ?? "console");
    for (const pane of saved ?? []) openPane({ paneId: pane.paneId, params: pane.params, focus: false });
  }, [conversationKey]);

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
