import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";
import { createPortal } from "react-dom";

import { isDesktopShell } from "../../../core/client/src/integration/desktop-shell.js";
import { useBrowserEngine } from "./browser-panel-store.js";
import { FleetBrowserGlyph } from "./global-browser-entry.js";
import { closeBrowserChooser, openGlobalBrowser, useBrowserChooserRequest, type BrowserChooserRequest } from "./global-browser-store.js";
import { getT } from "./i18n.js";
import "./link-open-card.css";

/**
 * 어느 브라우저로 열까 — 대화 중심 화면의 브라우저 단추가 세우는 두 행 카드(Fleet 브라우저 / Session 브라우저).
 *
 * 링크 카드(link-open-card.tsx)와 같은 몸이다: 같은 층·면·행 문법(.link-open-*)과 R1 이름을 쓰고, 주소 줄과 「내 브라우저」
 * 행만 없다 — 열 주소가 없는 단추에서 묻는 것은 「어디에 펼칠까」뿐이다. 카드는 누른 단추 아래에서 펼쳐진다.
 */
export function BrowserChooserHost({ language }: { readonly language: ConsoleLocale | undefined }) {
  const request = useBrowserChooserRequest();
  if (request === null || typeof document === "undefined") return null;
  return <BrowserChooserCard key={requestKey(request)} language={language} request={request} />;
}

let requestSerial = 0;
const requestKeys = new WeakMap<BrowserChooserRequest, number>();
function requestKey(request: BrowserChooserRequest): number {
  let key = requestKeys.get(request);
  if (key === undefined) { key = ++requestSerial; requestKeys.set(request, key); }
  return key;
}

const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;

function BrowserChooserCard({ language, request }: { readonly language: ConsoleLocale | undefined; readonly request: BrowserChooserRequest }) {
  const t = getT(language);
  const engine = useBrowserEngine();
  // 아직 물어보지 못한 동안(null)은 문을 닫지 않는다 — 링크 카드·캡션 지구본과 같은 판정이다.
  // 웹 탭·휴대폰에는 Fleet 브라우저를 그릴 셸이 없다 — 그 행은 닫힌 채 이유를 말한다(Session 행은 칸에서 같은 문을 보인다).
  const fleetMissing = !isDesktopShell();
  const engineMissing = engine !== null && !engine.available;
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const fleetRef = React.useRef<HTMLButtonElement | null>(null);
  const operationRef = React.useRef<HTMLButtonElement | null>(null);
  const [keyboard, setKeyboard] = React.useState(false);
  const operationMissing = request.operation === null;

  // 자리는 단추의 실측으로 정한다 — 단추 아래, 왼쪽 끝을 맞춘다. 화면 아래가 모자라면 위로 뒤집는다.
  React.useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const anchor = request.anchor.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - width - VIEWPORT_MARGIN));
    const below = anchor.bottom + CARD_GAP;
    const above = anchor.top - CARD_GAP - height;
    const top = below + height + VIEWPORT_MARGIN <= window.innerHeight ? below : Math.max(VIEWPORT_MARGIN, above);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = "visible";
    (engineMissing || fleetMissing ? operationRef.current : fleetRef.current)?.focus();
  }, [request, engineMissing, fleetMissing]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
    };
  }, []);

  function close() {
    closeBrowserChooser();
    // 고르지 않고 닫았으면 누른 단추로 손을 돌려준다.
    if (request.anchor.isConnected && (document.activeElement === document.body || cardRef.current?.contains(document.activeElement))) {
      request.anchor.focus({ preventScroll: true });
    }
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    setKeyboard(true);
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [fleetRef.current, operationRef.current].filter((item): item is HTMLButtonElement => item !== null && !item.disabled);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    items[(next + items.length) % items.length]!.focus();
  };

  const openFleet = () => {
    closeBrowserChooser();
    openGlobalBrowser(request.anchor);
  };
  const openOperation = () => {
    closeBrowserChooser();
    request.operation?.open();
  };
  const unavailableHelp = engineMissing ? t(engine?.reason === "shared" ? "terminal.browser.shared" : "terminal.globalBrowser.desktopOnly") : null;
  const fleetHelp = fleetMissing ? t("terminal.globalBrowser.desktopOnly") : unavailableHelp ?? t("terminal.chooser.fleetHelp");

  return createPortal(
    <div className="link-open-overlay" data-keep-operation-active role="presentation" onPointerDown={close}>
      <div
        className="link-open-card browser-chooser-card"
        {...(keyboard ? {} : { "data-quiet-focus": "true" })}
        ref={cardRef}
        style={{ visibility: "hidden" }}
        role="menu"
        aria-label={t("terminal.chooser.aria")}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={onMenuKeyDown}
      >
        <button type="button" role="menuitem" className="link-open-choice" ref={fleetRef} disabled={engineMissing || fleetMissing} onClick={openFleet}>
          <FleetBrowserGlyph />
          <span className="link-open-choice-text">
            <strong>{t("terminal.globalBrowser.title")}</strong>
            <span>{fleetHelp}</span>
          </span>
        </button>
        <button type="button" role="menuitem" className="link-open-choice" ref={operationRef} disabled={engineMissing || operationMissing} onClick={openOperation}>
          <OperationBrowserGlyph />
          <span className="link-open-choice-text">
            <strong>{t("terminal.chooser.operationBrowser")}</strong>
            <span>{unavailableHelp ?? (operationMissing ? t(request.sessionNotStarted ? "terminal.chooser.sessionNotStarted" : "terminal.chooser.noOperation") : t("terminal.chooser.operationHelp"))}</span>
          </span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

function OperationBrowserGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.4 8h11.2M8 2.4c2 2 2 9.2 0 11.2M8 2.4c-2 2-2 9.2 0 11.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
