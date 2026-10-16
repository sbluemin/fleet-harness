import { gestureFromEvent, openInDefaultOsBrowser } from "@fleet-console/link/core";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { ClientNavigateCapability } from "@fleet-console/sdk/navigation";
import { React } from "@fleet-console/sdk/plugin/browser";

import { useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { notifySharedFallback } from "../../../browser/client/browser-shared-fallback.js";
import { createChatFileLinkPorts } from "./chat-file-links.js";
import { createChatLinkInterceptor, openOperationLink, useLinkOpenChoice, type LinkOpenAt } from "./link-open.js";

/** 링크를 연 Operation — 카드의 「Operation 브라우저」 행과 수정키 손짓이 이 Operation 의 브라우저로 간다. */
export interface OperationLinkTarget {
  readonly operationId: string;
  readonly theaterId: string;
  readonly language: ConsoleLocale | undefined;
  readonly navigate: ClientNavigateCapability;
  /** 이 Operation 의 브라우저를 연다(여는 일만). 브라우저를 내주지 않는 호스트면 아무 일도 하지 않는다. */
  readonly openCompanion: () => void;
}

type LinkGestureEvent = { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean };

export interface OperationLinks {
  /** 수식 없는 왼클릭 — 카드를 세웠거나(shared 면 내 브라우저로 열었으면) true. */
  readonly choose: (url: string, at: LinkOpenAt) => boolean;
  /** 수정키·가운데 클릭 — 카드를 건너뛰고 곧장 연다. 맡았으면 true. */
  readonly openDirect: (url: string, event: LinkGestureEvent) => boolean;
  /** 채팅 링크 경계의 click·auxclick 손잡이 — 마크다운 앵커를 카드·직접 열기로 바꾼다. */
  readonly onLinkClick: (event: React.MouseEvent<HTMLElement>) => void;
  /** 채팅 링크 경계의 파일 링크 포트(분류·열기). */
  readonly fileLinks: ReturnType<typeof createChatFileLinkPorts>;
  /** 파일 링크를 열지 못한 사유 — 다음 열기 시도가 걷는다. */
  readonly fileLinkFailure: "unsupported" | "failed" | null;
  /** 어디서 열지 묻는 카드 — 부른 뷰가 제 트리에 둔다. */
  readonly card: React.ReactNode;
}

/**
 * 한 Operation 의 링크 길 — 채팅(마크다운 앵커)과 CLI(터미널이 찾은 링크)가 같은 카드·손짓·파일 열기를 쓴다.
 * Operation 본문과, 그 본문 대신 가운데 칸에 서는 그룹 대화가 같은 길을 쓰도록 한곳에 둔다.
 * 수식 없는 왼클릭은 Session 브라우저와 내 브라우저 카드, 수정키·중간 클릭은 카드를 건너뛰어 곧장 연다. shared 중에는 카드 없이 내 브라우저로 열고 처음 한 번 안내한다.
 */
export function useOperationLinks(target: OperationLinkTarget): OperationLinks {
  const linkOpen = useLinkOpenChoice(target);
  const engine = useBrowserEngine();
  const availability = React.useMemo(() => ({
    canOffer: engine === null || engine.available,
    isShared: engine !== null && !engine.available && engine.reason === "shared",
  }), [engine]);
  const { operationId, openCompanion, theaterId, navigate } = target;
  const openDirect = React.useCallback((url: string, event: LinkGestureEvent) => openOperationLink(
    url,
    gestureFromEvent(event),
    { operationId, openCompanion },
    availability,
  ), [operationId, openCompanion, availability]);
  const choose = React.useCallback((url: string, at: LinkOpenAt) => {
    if (availability.isShared) {
      notifySharedFallback();
      openInDefaultOsBrowser(url);
      return true;
    }
    return linkOpen.choose(url, at);
  }, [availability, linkOpen.choose]);
  const onLinkClick = React.useMemo(() => createChatLinkInterceptor(choose, openDirect), [choose, openDirect]);
  const [fileLinkFailure, setFileLinkFailure] = React.useState<"unsupported" | "failed" | null>(null);
  const fileLinks = React.useMemo(() => createChatFileLinkPorts(theaterId, navigate, setFileLinkFailure), [theaterId, navigate]);
  return { choose, openDirect, onLinkClick, fileLinks, fileLinkFailure, card: linkOpen.card };
}
