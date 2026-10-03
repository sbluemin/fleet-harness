import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";

import { requestBrowserOpen, useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { isDesktopShell } from "../../../../core/client/src/integration/desktop-shell.js";
import {
  focusOrCreateGlobalTab,
  noteBackgroundTab,
  notifySharedFallback,
  openGlobalBrowser,
} from "../../../browser/client/global-browser-store.js";
import { httpLinkHref } from "../terminal/shared/terminal-options.js";
import { openBrowserCompanion } from "./browser-companion.js";
import { getT } from "./i18n/index.js";
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

/** 누른 자리. 카드는 그 점에서 펼쳐진다 — 커서 앵커 메뉴와 같은 문법이다. */
export interface LinkOpenAt { readonly x: number; readonly y: number }

export interface LinkOpenChoice {
  /**
   * CLI·채팅이 부르는 문. 카드를 세웠으면 true — 고를 것이 하나뿐인 화면(브라우저 탭·휴대폰처럼
   * Fleet 브라우저가 설 수 없는 곳)에서는 묻지 않고 false를 돌려주며, 그러면 부른 쪽이 늘 하던 대로 연다.
   */
  readonly choose: (url: string, at: LinkOpenAt) => boolean;
  /** 카드 자체 — 호출한 뷰가 자기 트리에 둔다(포털로 body에 그려진다). */
  readonly card: React.ReactNode;
}

const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;

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
    <LinkOpenCard context={context} kind="operation" url={pending.url} at={pending.at} onClose={close} />
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
    <LinkOpenCard language={language} kind="shell" url={pending.url} at={pending.at} onClose={close} />
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
    void focusOrCreateGlobalTab(url, { activate: false }).then((ok) => {
      if (ok) noteBackgroundTab();
      else openInDefaultOsBrowser(url);
    }).catch(() => openInDefaultOsBrowser(url));
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
    void focusOrCreateGlobalTab(url, { activate: false }).then((ok) => {
      if (ok) noteBackgroundTab();
      else openInDefaultOsBrowser(url);
    }).catch(() => openInDefaultOsBrowser(url));
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

function LinkOpenCard({ context, language, kind, url, at, onClose }: {
  readonly context?: OperationRenderContext;
  readonly language?: OperationRenderContext["language"];
  readonly kind: "operation" | "shell";
  readonly url: string;
  readonly at: LinkOpenAt;
  readonly onClose: () => void;
}) {
  const t = getT(context?.language ?? language ?? "en");
  const engine = useBrowserEngine();
  // 아직 물어보지 못한 동안(null)은 문을 닫지 않는다 — 캡션의 지구본과 같은 판정이다.
  const engineMissing = engine !== null && !engine.available;
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  // 첫 행(Fleet 브라우저)이 기본 포커스다. 문이 닫혀 있으면 내 브라우저가 첫 손잡이가 된다.
  const globalRef = React.useRef<HTMLButtonElement | null>(null);
  const companionRef = React.useRef<HTMLButtonElement | null>(null);
  const webRef = React.useRef<HTMLButtonElement | null>(null);
  // 카드는 포커스를 쥐고 서지만(Enter 한 번이면 열린다) 그 사실을 링으로 말하지는 않는다 — 마우스로 연
  // 사람에게는 고르지 않은 것이 이미 골라진 것처럼 보인다. 키를 한 번 쓰는 순간부터 링이 선다.
  const [keyboard, setKeyboard] = React.useState(false);

  // 자리는 실측으로 정한다 — 추정 높이로 뒤집기를 판정하면 화면 아래에서 조용히 잘린다. 잰 값은 상태가
  // 아니라 노드에 바로 쓴다: 상태로 돌리면 자리를 잡는 렌더가 한 번 더 돌고, 그동안 카드는 숨어 있어
  // 아래의 포커스가 보이지 않는 요소를 향한다(포커스는 조용히 실패한다). 레이아웃 effect는 그리기 전에
  // 돌므로 깜빡임도 없다.
  React.useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(at.x, window.innerWidth - width - VIEWPORT_MARGIN));
    const below = at.y + CARD_GAP;
    const above = at.y - CARD_GAP - height;
    const top = below + height + VIEWPORT_MARGIN <= window.innerHeight
      ? below
      : above >= VIEWPORT_MARGIN
        ? above
        : Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = "visible";
    // 누르던 링크가 포커스를 쥐고 있으므로, 카드가 서는 그 자리에서 가져온다.
    (engineMissing ? webRef : globalRef).current?.focus();
  }, [at.x, at.y, engineMissing]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onClose);
    // 뒤에서 본문이 흐르면 카드가 짚던 자리는 더는 그 링크가 아니다.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    setKeyboard(true);
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [globalRef.current, ...(kind === "operation" ? [companionRef.current] : []), webRef.current].filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]!.focus();
  };

  const openInGlobalFleet = () => {
    onClose();
    // 같은 주소의 탭이 있으면 그 탭으로 가고, 없으면 새 탭을 연 뒤 시트를 띄운다.
    // 실패하면 OS로 떨어진다 — 누른 링크는 반드시 어딘가 열린다.
    void focusOrCreateGlobalTab(url).then((ok) => {
      if (ok) openGlobalBrowser();
      else openInDefaultOsBrowser(url);
    }).catch(() => openInDefaultOsBrowser(url));
  };
  const openInCompanionBrowser = () => {
    onClose();
    if (!context) return;
    // 주소를 먼저 놓고 문을 연다 — 패널은 마운트하는 순간 그 요청을 집어 든다.
    requestBrowserOpen(context.operationId, url);
    openBrowserCompanion(context);
  };
  const openInWebBrowser = () => {
    onClose();
    openInDefaultOsBrowser(url);
  };

  const unavailableHelp = engine !== null && !engine.available
    ? t(engine.reason === "shared" ? "terminal.browser.shared" : "terminal.browser.desktopOnly")
    : null;

  return createPortal(
    // 포털은 Operation 본문 밖에 그려지므로 활성 Operation 표식을 스스로 진다 — 없으면 고르는 그 클릭이
    // 방금까지 보던 Operation의 활성을 풀어 버린다(패널 포털 메뉴들과 같은 계약).
    <div className="link-open-overlay" data-keep-operation-active role="presentation" onPointerDown={onClose}>
      <div
        className="link-open-card"
        {...(keyboard ? {} : { "data-quiet-focus": "true" })}
        ref={cardRef}
        /* 자리를 재기 전 한 프레임은 숨는다 — 위 레이아웃 effect가 그리기 전에 값을 넣고 드러낸다. */
        style={{ visibility: "hidden" }}
        role="menu"
        aria-label={t("terminal.link.cardAria")}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onMenuKeyDown}
      >
        <p className="link-open-url" title={url}><LinkParts url={url} /></p>
        <button type="button" role="menuitem" className="link-open-choice" ref={globalRef} disabled={engineMissing} onClick={openInGlobalFleet}>
          <GlobeGlyph />
          <span className="link-open-choice-text">
            <strong>{t("terminal.link.fleetBrowser")}</strong>
            <span>{unavailableHelp ?? t("terminal.link.fleetBrowserHelp")}</span>
          </span>
        </button>
        {kind === "operation" ? (
          <button type="button" role="menuitem" className="link-open-choice" ref={companionRef} disabled={engineMissing} onClick={openInCompanionBrowser}>
            <GlobeGlyph />
            <span className="link-open-choice-text">
              <strong>{t("terminal.link.operationBrowser")}</strong>
              <span>{unavailableHelp ?? t("terminal.link.operationBrowserHelp")}</span>
            </span>
          </button>
        ) : null}
        <button type="button" role="menuitem" className="link-open-choice" ref={webRef} onClick={openInWebBrowser}>
          <ExternalGlyph />
          <span className="link-open-choice-text">
            <strong>{t("terminal.link.webBrowser")}</strong>
            <span>{t("terminal.link.webBrowserHelp")}</span>
          </span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** 주소는 호스트가 먼저 읽히게 나눈다 — 어디로 가는지가 경로보다 먼저 와야 확인이 된다. */
function LinkParts({ url }: { readonly url: string }) {
  let host = url;
  let rest = "";
  try {
    const parsed = new URL(url);
    host = parsed.host;
    rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch { /* 여기 오는 주소는 이미 검증된 http(s)다 */ }
  return <>
    <strong>{host}</strong>
    {rest ? <span>{rest}</span> : null}
  </>;
}

function GlobeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ExternalGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M6.5 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V9.5M9.5 2.5H13.5V6.5M13.5 2.5 7.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
