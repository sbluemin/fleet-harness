import { useEffect, useState } from "react";

import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";

import { useT } from "../../i18n/index.js";
import { pushBackLayer } from "./mobile-back.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMenu } from "./mobile-menu.js";
import { getLiveMobileBar, setMobileBarExtraSlot, setMobileDrawerOpen, useMobileBar, type MobileBarState } from "./mobile-store.js";

const DEFAULT_BAR: MobileBarState = { variant: "centered", title: "", leading: "menu" };

/**
 * 상단 막대 — 높이 56, 면 없이 화면 배경 그대로. 내용은 화면이 올린다(`claimMobileBar`): 왼쪽 ≡ 또는 ‹,
 * 가운데(또는 Operation의 왼쪽) 제목, 오른쪽 문맥 동작과 ⋮. 확인 필요가 있으면 ≡ 위에 점이 선다.
 */
export function MobileTopBar({ attentionDot }: { readonly attentionDot: boolean }) {
  const t = useT();
  const claimed = useMobileBar();
  const bar = claimed ?? DEFAULT_BAR;
  const [menuOpen, setMenuOpen] = useState(false);
  // 열린 ⋮ 메뉴는 뒤로가 가장 먼저 닫는 겹침이다.
  useEffect(() => (menuOpen ? pushBackLayer(() => setMenuOpen(false)) : undefined), [menuOpen]);
  // 화면이 막대를 올리지 않아도 ≡는 늘 서 있어야 한다 — 드로어로 가는 길이 끊기는 화면이 없게.
  if (bar.hidden) return null;

  const back = () => {
    const live = getLiveMobileBar();
    if (live?.onBack) live.onBack();
    else window.history.back();
  };
  const actionsCount = (bar.actions?.length ?? 0) + (bar.menu ? 1 : 0);
  const title = bar.variant === "operation" ? (
    <h1 className="mobile-top-bar-title is-left">
      {bar.glyph ? <span className={statusGlyphClassName(bar.glyph)} aria-hidden="true" /> : null}
      <span className="mobile-top-bar-copy">
        <span className="mobile-top-bar-name">{bar.title}</span>
        {bar.subtitle ? <small>{bar.subtitle}</small> : null}
      </span>
    </h1>
  ) : (
    <h1 className="mobile-top-bar-title">
      <span className="mobile-top-bar-name">{bar.title}</span>
      {bar.subtitle ? <small>{bar.subtitle}</small> : null}
    </h1>
  );

  return (
    <header className="mobile-top-bar">
      <button type="button" className="mobile-bar-button" onClick={bar.leading === "menu" ? () => setMobileDrawerOpen(true) : back} aria-label={bar.leading === "menu" ? t("mobile.bar.openMenu") : t("mobile.bar.back")}>
        <MobileIcon name={bar.leading === "menu" ? "menu" : "back"} />
        {bar.leading === "menu" && attentionDot ? <span className="mobile-attention-dot" aria-label={t("mobile.bar.attentionDot")} /> : null}
      </button>
      {title}
      {bar.variant === "operation" ? <span className="mobile-bar-extra" ref={setMobileBarExtraSlot} /> : null}
      {bar.variant === "centered" && actionsCount === 0 ? <span className="mobile-bar-spacer" aria-hidden="true" /> : null}
      {bar.actions?.map((action) => (
        <button type="button" key={action.id} className="mobile-bar-button" aria-label={action.label} onClick={() => getLiveMobileBar()?.actions?.find((item) => item.id === action.id)?.run()}>
          {action.icon}
        </button>
      ))}
      {bar.menu ? (
        <button type="button" className="mobile-bar-button" aria-label={bar.menu.label} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          <MobileIcon name="kebab" />
        </button>
      ) : null}
      {bar.menu && menuOpen ? (
        <MobileMenu
          label={bar.menu.label}
          caption={bar.menu.caption}
          // 항목 동작도 가장 최근 렌더의 클로저를 쓴다.
          items={bar.menu.items.map((item) => ({ ...item, run: () => getLiveMobileBar()?.menu?.items.find((live) => live.id === item.id)?.run() }))}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
    </header>
  );
}
