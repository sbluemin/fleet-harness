import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";

import { requestBrowserOpen, useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { notifySharedFallback } from "../../../browser/client/global-browser-store.js";
import {
  LinkOpenCard,
  openInFleetBrowserBackground,
  type LinkOpenAt,
} from "../../../browser/client/link-open-card.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import { httpLinkHref } from "../terminal/shared/terminal-options.js";
import { openBrowserCompanion } from "./browser-companion.js";
import { gestureFromEvent, openInDefaultOsBrowser, type OpenLinkGesture } from "@fleet-console/link/core";

/**
 * 링크 하나, 세 브라우저 — CLI·채팅에서 주소를 누르면 어디서 열지 먼저 묻는다.
 *
 * - Operation 표면: 3행 카드(Fleet 브라우저 / Operation 브라우저 / 내 브라우저).
 * - 전역 Shell: 2행 카드(Fleet 브라우저 / 내 브라우저) — Operation 행이 없다.
 * - 수정키는 카드를 건너뛴다(⌘·가운데=Fleet 뒤 탭, Shift=내 브라우저,
 *   Alt=그 Operation 브라우저, Shell의 Alt는 카드).
 * 묻는 카드가 곧 확인이기도 하다 — 터미널이 띄우던 native confirm이 하던 일을,
 * 갈 곳을 고르는 한 카드가 대신 진다.
 */

export type { LinkOpenAt };

export interface LinkOpenChoice {
  /**
   * CLI·채팅이 부르는 문. 카드를 세웠으면 true — 고를 것이 하나뿐인 화면(브라우저 탭·휴대폰처럼
   * Fleet 브라우저가 설 수 없는 곳)에서는 묻지 않고 false를 돌려주며, 그러면 부른 쪽이 늘 하던 대로 연다.
   */
  readonly choose: (url: string, at: LinkOpenAt) => boolean;
  /** 카드 자체 — 호출한 뷰가 자기 트리에 둔다(포털로 body에 그려진다). */
  readonly card: React.ReactNode;
}

export function useLinkOpenChoice(context: OperationRenderContext): LinkOpenChoice {
  const [pending, setPending] = React.useState<{ readonly url: string; readonly at: LinkOpenAt } | null>(null);
  // 묻는 것은 고를 것이 둘일 때만이다. Fleet 브라우저가 이 화면에 설 수 없으면(브라우저 탭·휴대폰,
  // 또는 다른 화면이 붙어 멈춘 동안) 링크는 예전처럼 곧장 열린다 — 답이 하나인 물음은 묻지 않는다.
  const engine = useBrowserEngine();
  // 아직 물어보지 못한 동안(null)은 닫힌 것으로 보지 않는다 — 캡션의 지구본과 같은 판정이다.
  const canOfferRef = React.useRef(true);
  canOfferRef.current = engine === null || engine.available;
  const choose = React.useCallback((url: string, at: LinkOpenAt) => {
    // 셸 문서가 아니면(웹 탭) 묻지 않는다 — 엔진 null을 가용으로 오독하지 않게 문서로 먼저 가른다.
    if (!isDesktopShell() || !canOfferRef.current) return false;
    setPending({ url, at });
    return true;
  }, []);
  const close = React.useCallback(() => setPending(null), []);
  const card = pending === null ? null : (
    <LinkOpenCard
      language={context.language}
      url={pending.url}
      at={pending.at}
      onClose={close}
      companion={{
        // 주소를 먼저 놓고 문을 연다 — 패널은 마운트하는 순간 그 요청을 집어 든다.
        open: () => {
          requestBrowserOpen(context.operationId, pending.url);
          openBrowserCompanion(context);
        },
      }}
    />
  );
  return { choose, card };
}

/** 전역 Shell의 2행 카드(Fleet / 내 브라우저) — Operation 행이 없다. */
export function useShellLinkChoice(language: OperationRenderContext["language"]): LinkOpenChoice {
  const [pending, setPending] = React.useState<{ readonly url: string; readonly at: LinkOpenAt } | null>(null);
  const engine = useBrowserEngine();
  const canOfferRef = React.useRef(true);
  canOfferRef.current = engine === null || engine.available;
  const choose = React.useCallback((url: string, at: LinkOpenAt) => {
    if (!isDesktopShell() || !canOfferRef.current) return false;
    setPending({ url, at });
    return true;
  }, []);
  const close = React.useCallback(() => setPending(null), []);
  const card = pending === null ? null : (
    <LinkOpenCard language={language} url={pending.url} at={pending.at} onClose={close} />
  );
  return { choose, card };
}

/** 브라우저 가용성 스냅샷 — 카드를 건너뛰는 손짓이 직접 열 수 있는지, shared 폴백인지를 가른다. */
export interface LinkAvailability {
  /** Fleet 브라우저를 열 수 있는가(카드·뒤 탭·시트). */
  readonly canOffer: boolean;
  /** Desktop shared인가 — 이때는 내 브라우저로 열고 처음 한 번 안내한다. */
  readonly isShared: boolean;
}

/**
 * 수정키 손짓의 직접 열기. 카드를 세우지 않고 true를 돌리면 부른 쪽은 맡긴 것으로 보고
 * confirm·앵커 기본 동작으로 떨어지지 않는다. click 손짓과 쓸 수 없을 때는 false다.
 */
export function openOperationLink(
  url: string,
  gesture: OpenLinkGesture,
  target: { readonly operationId: string; readonly openCompanion: () => void },
  availability: LinkAvailability,
): boolean {
  if (!isDesktopShell()) return false;
  if (!availability.canOffer) {
    if (!availability.isShared) return false;
    notifySharedFallback();
    openInDefaultOsBrowser(url);
    return true;
  }
  if (gesture === "click") return false;
  if (gesture === "background") {
    // 뒤 탭 — 시트를 띄우지 않고 탭만 열고, 칸에 수를 남긴다. 실패하면 OS로 떨어진다.
    openInFleetBrowserBackground(url);
    return true;
  }
  if (gesture === "external") {
    openInDefaultOsBrowser(url);
    return true;
  }
  requestBrowserOpen(target.operationId, url);
  target.openCompanion();
  return true;
}

/** 전역 Shell의 직접 열기 — companion이 없어 Alt는 카드로 돌려보낸다. */
export function openShellLink(url: string, gesture: OpenLinkGesture, availability: LinkAvailability): boolean {
  if (!isDesktopShell()) return false;
  if (!availability.canOffer) {
    if (!availability.isShared) return false;
    notifySharedFallback();
    openInDefaultOsBrowser(url);
    return true;
  }
  if (gesture === "click" || gesture === "companion") return false;
  if (gesture === "background") {
    openInFleetBrowserBackground(url);
    return true;
  }
  openInDefaultOsBrowser(url);
  return true;
}

/**
 * 채팅 본문의 링크 클릭을 가로채는 손잡이 — 마크다운이 심은 앵커가 여기서 카드·직접 열기로 바뀐다.
 *
 * 수식 없는 왼클릭은 카드로 묻고, 수정키·중간 클릭은 카드를 건너뛰어 곧장 연다.
 * 직접 열기에 실패하면(false) 앵커의 기본 동작을 그대로 둔다.
 */
export function createChatLinkInterceptor(
  choose: LinkOpenChoice["choose"],
  openDirect: (url: string, event: { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean }) => boolean,
) {
  return (event: React.MouseEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]") ?? null;
    if (!anchor) return;
    const href = httpLinkHref(anchor.href);
    if (href === null) return;
    const gesture = gestureFromEvent(event);
    // 카드가 서지 않으면 앵커의 기본 동작을 그대로 둔다 — 브라우저로 연 Console에서는 여느 링크와 같다.
    if (gesture === "click") {
      if (event.button !== 0) return;
      if (!choose(href, { x: event.clientX, y: event.clientY })) return;
      event.preventDefault();
      return;
    }
    if (!openDirect(href, event)) return;
    event.preventDefault();
  };
}
