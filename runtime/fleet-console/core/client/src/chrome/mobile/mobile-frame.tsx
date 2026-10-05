import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import type { DeferredDeletionReceipt } from "../../integration/api.js";

import { useConsoleState } from "../../hooks/use-store.js";
import { forgetReportedMobileChrome } from "../../integration/mobile-appearance-store.js";
import { useConsoleLocale, useT } from "../../i18n/index.js";
import { focusOperation } from "../../integration/store.js";
import type { ConsoleState } from "../../integration/types.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { MobileAttentionProvider } from "./mobile-attention-context.js";
import { useMobileAttention, useMobileDestinationBindings } from "./mobile-destinations.js";
import { MobileDrawer } from "./mobile-drawer.js";
import { MobileRequestBanner } from "./mobile-request-banner.js";
import { MobileToastHost } from "./mobile-toast.js";
import { MobileSheetHost } from "./mobile-sheet-host.js";
import { MobileChoicePopup, MobileCoordinateChoice, MobileModelChoice } from "./mobile-choice-popup.js";
import { reportShellChrome } from "./mobile-chrome.js";
import { openMobileChoice, useMobileChoice } from "./mobile-choice-store.js";
import { openMobileInput } from "./mobile-input-sheet.js";
import { openMobileSubScreen } from "./mobile-subscreen-store.js";
import { MobileSettingsHostContext } from "@fleet-console/sdk/settings/browser";
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
  const shownDestinations = useMobileDestinationBindings(bindings, state.activeTheaterId);
  const destinationIds = useMemo(() => new Set(shownDestinations.map((binding) => binding.entry.id)), [shownDestinations]);
  registerMobileDestinationEntries(destinationIds);
  // 보고 있던 목적지가 `shown`에서 거둬지면(실험 기능을 끔·Theater 전환) 막다른 길이 되지 않게 홈으로 돌려보낸다.
  useEffect(() => {
    if (destination.kind !== "plugin") return;
    const entryId = destination.entryId;
    const declared = bindings.find((binding) => binding.entry.id === entryId)?.entry.mobile?.destination?.shown;
    if (declared !== undefined && !destinationIds.has(entryId)) setMobileDestination({ kind: "home" });
  }, [bindings, destination, destinationIds]);

  // 다른 화면에서 /operations로 돌아오는 길이 도구·목적지 상태를 붙들고 있지 않게: 라우트가 홈이 아니면 홈으로 되돌려 둔다.
  const path = location.pathname.replace(/\/+$/, "");
  useEffect(() => { if (path === "/settings") setMobileDestination({ kind: "home" }); }, [path]);
  // 라우트 이동(replace)이 주소의 `?dest=`를 지울 수 있다 — 라우트가 정착한 뒤 목적지를 주소에 다시 적는다(새로고침 복원용).
  useEffect(() => { syncMobileDestinationUrl(); }, [path, destination]);

  // 뒤로가 마지막 가드에 닿으면 — 목적지 루트이면 홈으로, 홈이면 드로어를 연다(S-51 3·4).
  const pathRef = useRef(path);
  pathRef.current = path;
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
  useEffect(() => installMobileBackBridge(() => homeRef.current(), () => pathRef.current === "/operations" && getMobileDestination().kind === "home"), []);

  // 시스템 바 색(S-03): 드로어가 열리면 위·아래가 드로어 면, 시트가 열리면 아래가 시트 면. 앱이면 네이티브가 칠하고 브라우저는 무시한다.
  const drawerOpen = useMobileDrawerOpen();
  const sheetOpen = useMobileSheetStack().length > 0;
  const t = useT();
  const settingsHost = useMemo(() => ({ moreLabel: t("mobile.settings.more"), openChoice: openMobileChoice, openInput: openMobileInput, openSubScreen: openMobileSubScreen, ModelChoice: MobileModelChoice, CoordinateChoice: MobileCoordinateChoice }), [t]);
  const connection = useConsoleState().connection;
  const choiceOpen = useMobileChoice() !== null;
  const reportChrome = reportShellChrome;
  const reportChromeRef = useRef(reportChrome);
  reportChromeRef.current = reportChrome;
  useEffect(() => { reportChrome(); }, [drawerOpen, sheetOpen, choiceOpen]);
  // 재연결·페이지 복귀 뒤에는 지금 겹침 상태를 앱에 다시 알린다(NV-7) — 앱이 상태 바를 되돌려 놓았을 수 있다.
  useEffect(() => {
    if (connection !== "live") return;
    forgetReportedMobileChrome();
    reportChromeRef.current();
  }, [connection]);
  useEffect(() => {
    const resend = () => { if (document.visibilityState === "hidden") return; forgetReportedMobileChrome(); reportChromeRef.current(); };
    window.addEventListener("pageshow", resend);
    document.addEventListener("visibilitychange", resend);
    return () => { window.removeEventListener("pageshow", resend); document.removeEventListener("visibilitychange", resend); };
  }, []);

  const openOperation = (operationId: string) => {
    setMobileDestination({ kind: "home" });
    if (path !== "/operations") navigate("/operations");
    focusOperation(operationId);
  };

  return (
    <MobileSettingsHostContext.Provider value={settingsHost}>
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
        <MobileChoicePopup />
        <MobileToastHost />
      </div>
    </MobileAttentionProvider>
    </MobileSettingsHostContext.Provider>
  );
}
