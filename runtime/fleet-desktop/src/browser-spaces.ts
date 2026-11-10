import { DESKTOP_BROWSER_DEFAULT_SPACE_ID, type DesktopBrowserChrome } from "@fleet-console/protocol/desktop";

/** 표시 스페이스를 맞추려고 셸이 Console 에 보내는 요청 — 그 탭을 띄워 달라, 또는 표시 탭을 내려 달라. */
export type BrowserSpaceRequest = { readonly kind: "select"; readonly tabId: string } | { readonly kind: "deselect" };

/** 탭 id 가 될 수 없는 값 — 「표시 탭을 내려 달라」고 이미 보냈다는 표시. */
const DESELECT = "";

export interface BrowserSpaceView {
  /** 지금 화면에 띄운 스페이스. */
  current(): string;
  /** 사람이 스페이스를 골랐다. 그 스페이스를 띄우고, 화면을 맞추려면 Console 에 보낼 요청을 돌려준다. 모르는 스페이스면 아무 일도 없다. */
  choose(spaceId: string, chrome: DesktopBrowserChrome | null): BrowserSpaceRequest | null;
  /** Console 상태가 바뀌었다(또는 표면이 닫혀 `null`). 표시 스페이스를 맞추고, 필요하면 Console 에 보낼 요청을 돌려준다. */
  observe(chrome: DesktopBrowserChrome | null): BrowserSpaceRequest | null;
}

/**
 * 플릿 브라우저가 어느 스페이스를 보여 주는가 — 셸이 정하고 기억한다. Console 은 탭의 소속과 표시 탭 하나만 알고, 스페이스 사이를
 * 오가는 일은 여기서 판단해 「이 탭을 띄워 달라」는 요청으로 바꾼다.
 *
 * - 사람이 고른 스페이스가 곧 표시 스페이스다. 그 스페이스에서 마지막으로 띄운 탭(없으면 가장 나중에 연 탭)을 띄우고, 탭이 없으면 표시 탭을 내린다.
 * - 표시 탭이 **바뀌어** 다른 스페이스의 탭이 되면 그 스페이스로 따라간다 — 에이전트의 `tabs_select(show:true)` 와 채팅 링크 열기가 이 길이다.
 *   바뀌지 않은 표시 탭은 따라가지 않는다: 사람이 방금 다른 스페이스를 골랐고 Console 이 아직 그 요청을 반영하지 않았을 뿐이다.
 * - 보고 있는 스페이스에 탭이 있는데 표시 탭이 없으면 같은 규칙으로 탭 하나를 띄운다 — 빈 화면을 보던 사람에게 그 스페이스의 에이전트가 방금 연 탭이 보이게.
 * - 보고 있던 스페이스가 사라지면(사령관 삭제) 디폴트로 돌아간다.
 */
export function createBrowserSpaceView(): BrowserSpaceView {
  let spaceId: string = DESKTOP_BROWSER_DEFAULT_SPACE_ID;
  /** 스페이스 → 거기서 마지막으로 띄운 탭. */
  const front = new Map<string, string>();
  /** 마지막으로 본 표시 탭 — 「바뀌었다」를 가린다. */
  let lastActive: string | null = null;
  /** 이미 보낸 요청 — 띄워 달라고 한 탭, 또는 내려 달라는 요청(`DESELECT`). 같은 요청을 스냅샷마다 되풀이하지 않는다. */
  let asked: string | null = null;

  const pick = (chrome: DesktopBrowserChrome): BrowserSpaceRequest | null => {
    const tabs = chrome.tabs.filter((tab) => tab.spaceId === spaceId);
    const target = tabs.find((tab) => tab.id === front.get(spaceId)) ?? tabs.at(-1) ?? null;
    if (!target) {
      if (chrome.activeTabId === null || asked === DESELECT) return null;
      asked = DESELECT;
      return { kind: "deselect" };
    }
    if (target.id === chrome.activeTabId || target.id === asked) return null;
    asked = target.id;
    return { kind: "select", tabId: target.id };
  };

  return {
    current: () => spaceId,
    choose(next, chrome) {
      if (!chrome || !chrome.spaces.some((space) => space.id === next)) return null;
      spaceId = next;
      asked = null;
      return pick(chrome);
    },
    observe(chrome) {
      if (!chrome) { lastActive = null; asked = null; return null; }
      const tabIds = new Set(chrome.tabs.map((tab) => tab.id));
      for (const [space, tabId] of [...front]) if (!tabIds.has(tabId)) front.delete(space);
      if (asked !== null && asked !== DESELECT && !tabIds.has(asked)) asked = null;
      const active = chrome.tabs.find((tab) => tab.id === chrome.activeTabId) ?? null;
      const changed = chrome.activeTabId !== lastActive;
      lastActive = chrome.activeTabId;
      if (active) {
        front.set(active.spaceId, active.id);
        if (changed) { spaceId = active.spaceId; asked = null; }
      }
      if (!chrome.spaces.some((space) => space.id === spaceId)) { spaceId = active?.spaceId ?? DESKTOP_BROWSER_DEFAULT_SPACE_ID; asked = null; }
      // 표시 탭이 보고 있는 스페이스의 것이면 맞다. 아니면 그 스페이스의 탭을 띄우거나(없으면 내리거나) 이미 보낸 요청을 기다린다.
      return active?.spaceId === spaceId ? null : pick(chrome);
    },
  };
}
