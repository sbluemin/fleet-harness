import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { shortcutCommandLabel, useShortcutOverrides } from "../../../../core/client/src/integration/shortcut-bindings.js";
import { requestCommodoreCreate } from "../commodore-create-modal.js";
import { CommodoreIcon, TaskforceIcon } from "../../../workspace/client/sidebar/sidebar-menu-icons.js";
import { requestTaskforceCreate } from "./taskforce.js";
import { taskforceT } from "./i18n.js";

export function TaskforceCreateMenu({ children, taskforce = true, extra, extraCount = 1 }: {
  readonly children: ReactNode;
  /** 태스크포스 실험이 켜져 있을 때만 '새 태스크포스'를 둔다. */
  readonly taskforce?: boolean;
  /** 기존 항목 아래 구분선 다음에 붙는 항목. 메뉴를 닫는 함수와 '+' 트리거 조회 함수를 받는다. */
  readonly extra?: (close: () => void, trigger: () => HTMLElement | null) => ReactNode;
  /** extra 안의 menuitem 수. 높이 예약이 항목 수와 맞는다. 키보드 이동은 그린 단추를 센다. */
  readonly extraCount?: number;
}) {
  const language = useConsoleLocale(); const t = taskforceT(language);
  useShortcutOverrides();
  const shortcut = shortcutCommandLabel("console.new-taskforce");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const close = () => { setAnchor(null); button.current?.focus(); };
  useEffect(() => {
    if (!anchor) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = () => setAnchor(null);
    window.addEventListener("resize", dismiss); window.addEventListener("blur", dismiss);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("blur", dismiss); };
  }, [anchor]);
  const trailing = extra ? Math.max(1, extraCount) : 0;
  const rows = 1 + (taskforce ? 1 : 0) + trailing;
  const reserve = 48 + rows * 36 + (trailing > 0 ? 12 : 0);
  return <><button ref={button} type="button" className="conversation-round" aria-label={t("taskforce.createMenu")} title={t("taskforce.createMenu")} aria-haspopup="menu" aria-expanded={anchor !== null} data-create-menu="sidebar" onClick={() => setAnchor(anchor ? null : button.current?.getBoundingClientRect() ?? null)}>{children}</button>
    {anchor ? createPortal(<div className="group-context-menu-overlay" data-native-browser-transparent role="presentation" onPointerDown={() => setAnchor(null)}><div ref={menu} className="theater-menu taskforce-create-menu" role="menu" aria-label={t("taskforce.createMenu")} style={{ position: "fixed", left: Math.max(8, Math.min(anchor.right - 220, window.innerWidth - 228)), top: Math.min(anchor.bottom + 6, window.innerHeight - reserve), minWidth: 220 }} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]; const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
    }}>
      <button type="button" role="menuitem" className="theater-menu-item" onClick={() => { close(); requestCommodoreCreate(); }}><span className="theater-menu-check" aria-hidden="true"><CommodoreIcon /></span><span className="theater-menu-label">{t("taskforce.newCommodore")}</span></button>
      {taskforce ? <button type="button" role="menuitem" className="theater-menu-item" onClick={() => { close(); requestTaskforceCreate(); }}><span className="theater-menu-check" aria-hidden="true"><TaskforceIcon /></span><span className="theater-menu-label">{t("taskforce.new")}</span>{shortcut ? <kbd className="taskforce-menu-shortcut">{shortcut}</kbd> : null}</button> : null}
      {extra ? <><div className="theater-menu-divider" role="separator" />{extra(close, () => button.current)}</> : null}
    </div></div>, document.body) : null}</>;
}
