import { useEffect, useMemo, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useConsoleLocale } from "../../i18n/index.js";
import { focusOperation } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { MobileAttentionProvider } from "./mobile-attention-context.js";
import { mobileDestinationBindings, useMobileAttention } from "./mobile-destinations.js";
import { MobileDrawer } from "./mobile-drawer.js";
import { MobileSheetHost } from "./mobile-sheet-host.js";
import { MobileTopBar } from "./mobile-top-bar.js";
import { registerMobileDestinationEntries, setMobileDestination } from "./mobile-store.js";
import "../../styles/mobile.css";

/**
 * 모바일 배치의 틀: 상단 막대 · 화면(라우트) · 드로어 · 하단 시트. 탭 막대는 없다 — 목적지는 모두 드로어가 연다.
 * 「확인 필요」를 여기서 한 번 계산해 ≡ 점·드로어 구역·전체 화면이 같은 행을 읽게 한다.
 */
export function MobileFrame({ state, children }: { readonly state: ConsoleState; readonly children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const bindings = useRailEntries();
  const locale = useConsoleLocale();
  const { rows } = useMobileAttention(state);

  // 목적지로 선언된 레일 엔트리를 스토어에 알린다 — 그 id를 연 요청(플러그인의 rail.open 등)은 시트가 아니라 화면이 된다.
  const destinationIds = useMemo(() => new Set(mobileDestinationBindings(bindings).map((binding) => binding.entry.id)), [bindings]);
  registerMobileDestinationEntries(destinationIds);

  // 다른 화면에서 /operations로 돌아오는 길이 도구·목적지 상태를 붙들고 있지 않게: 라우트가 홈이 아니면 홈으로 되돌려 둔다.
  const path = location.pathname.replace(/\/+$/, "");
  useEffect(() => { if (path === "/theaters" || path === "/settings") setMobileDestination({ kind: "home" }); }, [path]);

  const openOperation = (operationId: string) => {
    setMobileDestination({ kind: "home" });
    if (path !== "/operations") navigate("/operations");
    focusOperation(operationId);
  };

  return (
    <MobileAttentionProvider rows={rows}>
      <div className="mobile-frame" lang={locale}>
        <MobileTopBar attentionDot={rows.length > 0} />
        {children}
        <MobileDrawer state={state} attention={rows} activeOperationId={state.activeOperationId} onOpenOperation={openOperation} />
        <MobileSheetHost state={state} />
      </div>
    </MobileAttentionProvider>
  );
}
