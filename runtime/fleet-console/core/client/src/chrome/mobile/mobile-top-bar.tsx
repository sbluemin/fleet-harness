import { useEffect, useState } from "react";

import { useT } from "../../i18n/index.js";
import { pushBackLayer } from "./mobile-back.js";
import { MobileIcon } from "./mobile-icons.js";
import { MobileMenu } from "./mobile-menu.js";
import { getLiveMobileBar, useMobileBar, type MobileBarState } from "./mobile-store.js";
import { PillTakeoverLayer, usePillTakeoverPhase } from "../../../../../features/workspace/client/conversation/pill-takeover.js";

const DEFAULT_BAR: MobileBarState = { variant: "centered", title: "", leading: "back" };

/**
 * 상단 막대 — 최소 높이 56(큰 글자 배율에서는 자란다), 면 없이 화면 배경 그대로. 내용은 화면이 올린다(`claimMobileBar`): 왼쪽 ≡ 또는 ‹,
 * 가운데(또는 Operation의 왼쪽) 제목, 오른쪽 문맥 동작과 ⋮.
 */
export function MobileTopBar() {
  const t = useT();
  const claimed = useMobileBar();
  const bar = claimed ?? DEFAULT_BAR;
  const [menuOpen, setMenuOpen] = useState(false);
  // 열린 ⋮ 메뉴는 뒤로가 가장 먼저 닫는 겹침이다.
  useEffect(() => (menuOpen ? pushBackLayer(() => setMenuOpen(false)) : undefined), [menuOpen]);
  // 본문이 잠깐 바꾼 pill 내용 — 그동안(되돌아가는 크로스페이드까지) pill 은 단추가 아니라 그 내용을 담는 틀이다(단추 안에 단추를 두지 않는다).
  const takeover = usePillTakeoverPhase(bar.variant === "conversation" ? bar.pill?.takeover ?? null : null);
  if (bar.hidden) return null;

  const back = () => {
    const live = getLiveMobileBar();
    if (live?.onBack) live.onBack();
    else window.history.back();
  };
  const actionsCount = (bar.actions?.length ?? 0) + (bar.menu ? 1 : 0);
  const title = bar.variant === "conversation" && bar.pill ? takeover.shown ? (
    <div className={`mobile-conv-pill is-takeover is-${takeover.phase}`}>
      <span className="mobile-conv-pill-was" aria-hidden={takeover.phase === "in" || undefined} inert={takeover.phase === "in" || undefined}>{bar.pill.node}</span>
      <PillTakeoverLayer {...takeover} />
    </div>
  ) : (
    <button type="button" className="mobile-conv-pill" aria-label={bar.pill.label} onClick={() => getLiveMobileBar()?.pill?.onPress()}>{bar.pill.node}</button>
  ) : (
    <h1 className="mobile-top-bar-title">
      <span className="mobile-top-bar-name">{bar.title}</span>
      {bar.subtitle ? <small>{bar.subtitle}</small> : null}
    </h1>
  );

  return (
    <header className={`mobile-top-bar${bar.variant === "conversation" ? " is-conversation" : ""}`}>
      <button type="button" className="mobile-bar-button" onClick={back} aria-label={t("mobile.bar.back")}>
        <MobileIcon name="back" />
      </button>
      {title}
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
