import type { ConsoleLocale } from "@fleet-console/i18n";
import * as React from "react";
import { createPortal } from "react-dom";
import { openInDefaultOsBrowser } from "@fleet-console/link/core";

import { useBrowserEngine } from "./browser-panel-store.js";
import { getLinkOpenT } from "./link-open-i18n.js";
import "./link-open-card.css";

/**
 * 링크 하나, 어디서 열까 — 주소를 누르면 서는 한 장의 카드.
 *
 * Session 이 있는 표면(채팅·CLI): 2행(Session 브라우저 / 내 브라우저).
 * Session 이 없는 표면은 카드를 세우지 않고 내 브라우저로 바로 연다.
 * 카드는 브라우저 기능이 소유한다 — Session 행은 부른 쪽이 `companion`으로 넘길 때만 선다.
 */

/** 누른 자리. 카드는 그 점에서 펼쳐진다 — 커서 앵커 메뉴와 같은 문법이다. */
export interface LinkOpenAt { readonly x: number; readonly y: number }

const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;

export function LinkOpenCard({ language, url, at, onClose, companion }: {
  readonly language: ConsoleLocale | undefined;
  readonly url: string;
  readonly at: LinkOpenAt;
  readonly onClose: () => void;
  /** Objective 브라우저 행 — 넘기지 않으면 2행 카드다. */
  readonly companion?: { readonly open: () => void };
}) {
  const t = getLinkOpenT(language);
  const engine = useBrowserEngine();
  // 아직 물어보지 못한 동안(null)은 문을 닫지 않는다 — 캡션의 지구본과 같은 판정이다.
  const engineMissing = engine !== null && !engine.available;
  const hasCompanion = companion !== undefined;
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  // Session 행이 기본 포커스다. 문이 닫혀 있거나 Session 이 없으면 내 브라우저가 첫 손잡이가 된다.
  const companionRef = React.useRef<HTMLButtonElement | null>(null);
  const webRef = React.useRef<HTMLButtonElement | null>(null);
  // 카드는 포커스를 쥐고 서지만(Enter 한 번이면 열린다) 그 사실을 링으로 말하지는 않는다 — 마우스로 연
  // 사람에게는 고르지 않은 것이 이미 골라진 것처럼 보인다. 키를 한 번 쓰는 순간부터 링이 선다.
  const [keyboard, setKeyboard] = React.useState(false);
  // 카드를 연 출발점(누른 링크) — 행을 고르거나 Esc로 닫으면 여기로 돌려준다.
  // 위치를 재는 뒤 layout effect가 포커스를 행으로 가져가기 전에, 선언 순서대로 먼저 기억한다.
  const triggerRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const trigger = triggerRef.current;
      triggerRef.current = null;
      if (!trigger || !trigger.isConnected) return;
      const active = document.activeElement;
      // 카드 안에서 닫혔을 때만 돌려준다 — 그사이 다른 곳을 누른 사람의 손을 빼앗지 않는다.
      if (active === document.body || (active instanceof HTMLElement && cardRef.current?.contains(active))) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

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
    // companion 객체는 부모가 렌더마다 새로 만들 수 있다. 행이 있는지만 본다.
    (engineMissing || !hasCompanion ? webRef : companionRef).current?.focus();
  }, [at.x, at.y, engineMissing, hasCompanion]);

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
    const items = [companionRef.current, webRef.current].filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]!.focus();
  };

  const openInCompanionBrowser = () => {
    onClose();
    companion?.open();
  };
  const openInWebBrowser = () => {
    onClose();
    openInDefaultOsBrowser(url);
  };

  const unavailableHelp = engine !== null && !engine.available
    ? t(engine.reason === "shared" ? "terminal.browser.shared" : "terminal.browser.desktopOnly")
    : null;

  return createPortal(
    // 포털은 Objective 본문 밖에 그려지므로 활성 Objective 표식을 스스로 진다 — 없으면 고르는 그 클릭이
    // 방금까지 보던 Objective의 활성을 풀어 버린다(패널 포털 메뉴들과 같은 계약).
    <div className="link-open-overlay" data-keep-objective-active role="presentation" onPointerDown={onClose}>
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
        {companion ? (
          <button type="button" role="menuitem" className="link-open-choice" ref={companionRef} disabled={engineMissing} onClick={openInCompanionBrowser}>
            <GlobeGlyph />
            <span className="link-open-choice-text">
              <strong>{t("terminal.link.objectiveRecordBrowser")}</strong>
              <span>{unavailableHelp ?? t("terminal.link.objectiveRecordBrowserHelp")}</span>
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
