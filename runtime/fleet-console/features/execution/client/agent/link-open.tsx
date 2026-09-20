import type { OperationRenderContext } from "@fleet-console/sdk/plugin";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";

import { requestBrowserOpen, useBrowserEngine } from "../../../browser/client/browser-panel-store.js";
import { httpLinkHref } from "../terminal/shared/terminal-options.js";
import { openBrowserCompanion } from "./browser-companion.js";
import { getT } from "./i18n/index.js";

/**
 * 링크 하나, 두 브라우저 — CLI·채팅에서 주소를 누르면 어디서 열지 먼저 묻는다.
 *
 * Fleet 브라우저는 이 Operation의 companion 패널이다(에이전트와 같은 탭을 본다). 내 브라우저는
 * 이 컴퓨터의 기본 브라우저다. 묻는 카드가 곧 확인이기도 하다 — 터미널이 띄우던 native confirm이
 * 하던 일을, 갈 곳을 고르는 한 카드가 대신 진다.
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
    if (!canOfferRef.current) return false;
    setPending({ url, at });
    return true;
  }, []);
  const close = React.useCallback(() => setPending(null), []);
  const card = pending === null ? null : (
    <LinkOpenCard context={context} url={pending.url} at={pending.at} onClose={close} />
  );
  return { choose, card };
}

/**
 * 채팅 본문의 링크 클릭을 가로채는 손잡이 — 마크다운이 심은 앵커가 여기서 카드로 바뀐다.
 *
 * 수식 키를 누른 클릭과 가운데 클릭은 그대로 둔다: 그 제스처는 이미 「새 탭에서」라는 뜻이고,
 * 앵커의 기본 동작이 그 뜻을 지킨다.
 */
export function createChatLinkInterceptor(choose: LinkOpenChoice["choose"]) {
  return (event: React.MouseEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]") ?? null;
    if (!anchor) return;
    const href = httpLinkHref(anchor.href);
    if (href === null) return;
    // 카드가 서지 않으면 앵커의 기본 동작을 그대로 둔다 — 브라우저로 연 Console에서는 여느 링크와 같다.
    if (!choose(href, { x: event.clientX, y: event.clientY })) return;
    event.preventDefault();
  };
}

/** 이 컴퓨터의 기본 브라우저로 — Desktop 셸에서는 창 정책이 이 요청을 OS 브라우저로 넘긴다. */
export function openLinkInWebBrowser(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function LinkOpenCard({ context, url, at, onClose }: {
  readonly context: OperationRenderContext;
  readonly url: string;
  readonly at: LinkOpenAt;
  readonly onClose: () => void;
}) {
  const t = getT(context.language ?? "en");
  const engine = useBrowserEngine();
  // 아직 물어보지 못한 동안(null)은 문을 닫지 않는다 — 캡션의 지구본과 같은 판정이다.
  const engineMissing = engine !== null && !engine.available;
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const fleetRef = React.useRef<HTMLButtonElement | null>(null);
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
    // 기본값은 Fleet 브라우저다 — 그 문이 닫혀 있으면 내 브라우저가 첫 손잡이가 된다.
    // 누르던 링크가 포커스를 쥐고 있으므로, 카드가 서는 그 자리에서 가져온다.
    (engineMissing ? webRef : fleetRef).current?.focus();
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
    const items = [fleetRef.current, webRef.current].filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]!.focus();
  };

  const openInFleetBrowser = () => {
    onClose();
    // 주소를 먼저 놓고 문을 연다 — 패널은 마운트하는 순간 그 요청을 집어 든다.
    requestBrowserOpen(context.operationId, url);
    openBrowserCompanion(context);
  };
  const openInWebBrowser = () => {
    onClose();
    openLinkInWebBrowser(url);
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
        <button type="button" role="menuitem" className="link-open-choice" ref={fleetRef} disabled={engineMissing} onClick={openInFleetBrowser}>
          <GlobeGlyph />
          <span className="link-open-choice-text">
            <strong>{t("terminal.link.fleetBrowser")}</strong>
            <span>{unavailableHelp ?? t("terminal.link.fleetBrowserHelp")}</span>
          </span>
        </button>
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
