import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { DeferredDeletionReceipt } from "../../integration/api.js";

import { reportMobileChrome } from "../../integration/mobile-appearance-store.js";
import { useConsoleLocale } from "../../i18n/index.js";
import { focusOperation } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { MobileAttentionProvider } from "./mobile-attention-context.js";
import { mobileDestinationBindings, useMobileAttention } from "./mobile-destinations.js";
import { MobileDrawer } from "./mobile-drawer.js";
import { MobileRequestBanner } from "./mobile-request-banner.js";
import { MobileToastHost } from "./mobile-toast.js";
import { MobileSheetHost } from "./mobile-sheet-host.js";
import { MobileTopBar } from "./mobile-top-bar.js";
import { installMobileBackBridge } from "./mobile-back.js";
import { installMobileHistory } from "./mobile-history.js";
import { getMobileDrawerOpen, getMobileDestination, useMobileDestination, useMobileDrawerOpen, useMobileSheetStack, registerMobileDestinationEntries, setMobileDestination, syncMobileDestinationUrl, setMobileDrawerOpen } from "./mobile-store.js";
import "../../styles/mobile.css";

/**
 * 모바일 배치의 틀: 상단 막대 · 화면(라우트) · 드로어 · 하단 시트. 탭 막대는 없다 — 목적지는 모두 드로어가 연다.
 * 「확인 필요」를 여기서 한 번 계산해 ≡ 점·드로어 구역·전체 화면이 같은 행을 읽게 한다.
 */
export function MobileFrame({ state, bands, onDeferredDeletion, children }: { readonly state: ConsoleState; readonly bands: ReactNode; readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void; readonly children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const bindings = useRailEntries();
  const locale = useConsoleLocale();
  const { rows } = useMobileAttention(state);
  const destination = useMobileDestination();

  // 목적지로 선언된 레일 엔트리를 스토어에 알린다 — 그 id를 연 요청(플러그인의 rail.open 등)은 시트가 아니라 화면이 된다.
  const destinationIds = useMemo(() => new Set(mobileDestinationBindings(bindings).map((binding) => binding.entry.id)), [bindings]);
  registerMobileDestinationEntries(destinationIds);

  // 다른 화면에서 /operations로 돌아오는 길이 도구·목적지 상태를 붙들고 있지 않게: 라우트가 홈이 아니면 홈으로 되돌려 둔다.
  const path = location.pathname.replace(/\/+$/, "");
  useEffect(() => { if (path === "/theaters" || path === "/settings") setMobileDestination({ kind: "home" }); }, [path]);
  // 라우트 이동(replace)이 주소의 `?dest=`를 지울 수 있다 — 라우트가 정착한 뒤 목적지를 주소에 다시 적는다(새로고침 복원용).
  useEffect(() => { syncMobileDestinationUrl(); }, [path, destination]);

  // 뒤로가 마지막 가드에 닿으면 — 목적지 루트이면 홈으로, 홈이면 드로어를 연다(S-51 3·4).
  const homeRef = useRef<() => void>(() => undefined);
  homeRef.current = () => {
    if (getMobileDrawerOpen()) return;
    if (path !== "/operations" || getMobileDestination().kind !== "home") {
      setMobileDestination({ kind: "home" });
      if (path !== "/operations") navigate("/operations", { replace: true });
      return;
    }
    setMobileDrawerOpen(true);
  };
  useEffect(() => installMobileHistory(() => homeRef.current()), []);
  // 앱의 하드웨어 뒤로: 같은 우선순위를 함수 호출로 받는다(history.back을 따로 쓰지 않는다).
  useEffect(() => installMobileBackBridge(() => homeRef.current()), []);

  // 시스템 바 색(S-03): 드로어가 열리면 위·아래가 드로어 면, 시트가 열리면 아래가 시트 면. 앱이면 네이티브가 칠하고 브라우저는 무시한다.
  const drawerOpen = useMobileDrawerOpen();
  const sheetOpen = useMobileSheetStack().length > 0;
  useEffect(() => {
    reportMobileChrome(drawerOpen ? "bg-deep" : "bg", sheetOpen ? "surface" : drawerOpen ? "bg-deep" : "bg");
  }, [drawerOpen, sheetOpen]);

  const openOperation = (operationId: string) => {
    setMobileDestination({ kind: "home" });
    if (path !== "/operations") navigate("/operations");
    focusOperation(operationId);
  };

  return (
    <MobileAttentionProvider rows={rows}>
      <div className="mobile-frame" lang={locale}>
        <div className="mobile-frame-head">
          <MobileTopBar attentionDot={rows.length > 0} />
          {/* 연결·상태 띠는 상단 막대 바로 아래에 선다(S-34). */}
          {bands}
        </div>
        {children}
        <MobileDrawer state={state} attention={rows} activeOperationId={state.activeOperationId} onOpenOperation={openOperation} />
        <MobileRequestBanner
          state={state}
          viewingOperationId={path === "/operations" && destination.kind === "home" ? state.activeOperationId : null}
          onOpen={openOperation}
        />
        <MobileSheetHost state={state} onDeferredDeletion={onDeferredDeletion} />
        <MobileToastHost />
      </div>
    </MobileAttentionProvider>
  );
}
