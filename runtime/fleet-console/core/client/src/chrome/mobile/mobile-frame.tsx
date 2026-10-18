import { getViewedTheaterId } from "../../integration/viewed-theater.js";
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
import { MobileRequestBanner } from "./mobile-request-banner.js";
import { MobileToastHost } from "./mobile-toast.js";
import { MobileSheetHost } from "./mobile-sheet-host.js";
import { MobileChoicePopup, MobileCoordinateChoice, MobileModelChoice } from "./mobile-choice-popup.js";
import { reportShellChrome } from "./mobile-chrome.js";
import { openMobileChoice, useMobileChoice } from "./mobile-choice-store.js";
import { openMobileInput } from "./mobile-input-sheet.js";
import { openMobileSubScreen } from "./mobile-subscreen-store.js";
import { MobileSettingsHostContext } from "@fleet-console/sdk/settings/browser";
import { useChromeHeightProperty } from "@fleet-console/sdk/react/browser";
import { MobileTopBar } from "./mobile-top-bar.js";
import { installMobileBackBridge } from "./mobile-back.js";
import { closeMobileOperation, readMobileOperationId } from "./mobile-operation-url.js";
import { installMobileHistory } from "./mobile-history.js";
import { getMobileDestination, useMobileBar, useMobileDestination, useMobileSheetStack, registerMobileDestinationEntries, setMobileDestination, syncMobileDestinationUrl, pushMobileSheet, getMobileSheetStack } from "./mobile-store.js";
import "../../styles/mobile.css";

/**
 * 모바일 배치의 틀: 상단 막대 · 화면(라우트) · 하단 시트. 탭 막대와 드로어는 없다 — 홈(대화 목록)이 루트이고, 목적지는 홈의
 * 바로가기 칩이 연다. 「확인 필요」를 여기서 한 번 계산해 홈 맨 위 묶음·전체 화면·요청 배너가 같은 행을 읽게 한다.
 */
export function MobileFrame({ state, bands, onDeferredDeletion, children }: { readonly state: ConsoleState; readonly bands: ReactNode; readonly onDeferredDeletion: (deletion: DeferredDeletionReceipt | null) => void; readonly children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const bindings = useRailEntries();
  const locale = useConsoleLocale();
  const { rows } = useMobileAttention(state);
  const destination = useMobileDestination();

  // 목적지로 선언된 레일 엔트리를 스토어에 알린다 — 그 id를 연 요청(플러그인의 rail.open 등)은 시트가 아니라 화면이 된다.
  const shownDestinations = useMobileDestinationBindings(bindings, getViewedTheaterId());
  const destinationIds = useMemo(() => new Set(shownDestinations.map((binding) => binding.entry.id)), [shownDestinations]);
  registerMobileDestinationEntries(destinationIds);
  // 보고 있던 목적지가 `shown`에서 거둬지면(실험 기능을 끔·Theater 전환) 막다른 길이 되지 않게 홈으로 돌려보낸다.
  useEffect(() => {
    if (destination.kind !== "plugin") return;
    const entryId = destination.entryId;
    const binding = bindings.find((candidate) => candidate.entry.id === entryId);
    // 레지스트리에 없는 id(옛 주소·지워진 플러그인)는 빈 화면이 아니라 홈이다 — 레지스트리는 앱이 마운트되기 전에 만들어져 있다.
    if (bindings.length > 0 && binding === undefined) { setMobileDestination({ kind: "home" }); return; }
    const declared = binding?.entry.mobile?.destination?.shown;
    if (declared !== undefined && !destinationIds.has(entryId)) setMobileDestination({ kind: "home" });
  }, [bindings, destination, destinationIds]);

  // 다른 화면에서 /operations로 돌아오는 길이 도구·목적지 상태를 붙들고 있지 않게: 라우트가 홈이 아니면 홈으로 되돌려 둔다.
  const path = location.pathname.replace(/\/+$/, "");
  useEffect(() => { if (path === "/settings") setMobileDestination({ kind: "home" }); }, [path]);
  // 프로필 시트의 행으로 연 설정 상세(`/settings`)를 어떤 뒤로(브라우저·제스처·‹·브리지)로 떠나든 그 시트로 돌아온다 — 행이 시트의 history 항목을
  // 상세로 바꿔 쓰므로(S-51, 항목이 늘지 않는다) 브라우저 뒤로는 시트 없는 홈에 닿는다. ‹·브리지는 이미 시트를 열었으면 다시 열지 않는다.
  const routeRef = useRef({ path, profileDetail: false });
  const profileDetail = path === "/settings" && (location.state as { readonly mobileProfileReturn?: true } | null)?.mobileProfileReturn === true;
  useEffect(() => {
    const previous = routeRef.current;
    routeRef.current = { path, profileDetail };
    if (previous.profileDetail && path === "/operations" && getMobileSheetStack().length === 0) pushMobileSheet({ kind: "profile" });
  }, [path, profileDetail]);
  // 라우트 이동(replace)이 주소의 `?dest=`를 지울 수 있다 — 라우트가 정착한 뒤 목적지를 주소에 다시 적는다(새로고침 복원용).
  useEffect(() => { syncMobileDestinationUrl(); }, [path, destination]);

  // 뒤로가 마지막 가드에 닿으면 — 열린 Operation이나 홈이 아닌 목적지 루트이면 대화 목록(홈)으로 돌아간다(S-51 3).
  // 대화 목록이 루트다(4): 앱이면 false를 돌려 앱 기본(Console 목록)에 맡기고, 브라우저는 가드 두 칸을 넘어 이전 페이지로 간다.
  const backRef = useRef<() => boolean>(() => false);
  backRef.current = () => {
    if (path !== "/operations" || getMobileDestination().kind !== "home") {
      setMobileDestination({ kind: "home" });
      if (path !== "/operations") navigate("/operations", { replace: true });
      return true;
    }
    if (readMobileOperationId() !== null) { closeMobileOperation(); return true; }
    return false;
  };
  // 이전 항목이 없는 새 탭은 [가드][루트] 두 칸뿐이라 go(-2)가 범위를 벗어난다 — 나갈 곳이 없으면 닫기만 시도하고 페이지에 남는다.
  useEffect(() => installMobileHistory(() => { if (backRef.current()) return; if (window.history.length > 2) window.history.go(-2); else window.close(); }), []);
  // 앱의 하드웨어 뒤로: 같은 우선순위를 함수 호출로 받는다(history.back을 따로 쓰지 않는다).
  useEffect(() => installMobileBackBridge(() => backRef.current()), []);

  // 시스템 바 색(S-03): 시트가 열리면 아래가 시트 면. 앱이면 네이티브가 칠하고 브라우저는 무시한다.
  const sheetOpen = useMobileSheetStack().length > 0;
  const t = useT();
  const settingsHost = useMemo(() => ({ moreLabel: t("mobile.settings.more"), openChoice: openMobileChoice, openInput: openMobileInput, openSubScreen: openMobileSubScreen, ModelChoice: MobileModelChoice, CoordinateChoice: MobileCoordinateChoice }), [t]);
  const connection = useConsoleState().connection;
  const choiceOpen = useMobileChoice() !== null;
  const reportChrome = reportShellChrome;
  const reportChromeRef = useRef(reportChrome);
  reportChromeRef.current = reportChrome;
  useEffect(() => { reportChrome(); }, [sheetOpen, choiceOpen]);
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

  // 상단 막대와 연결·상태 띠는 화면 위에 떠 있다 — 본문은 그 뒤로 흐르고, 화면의 스크롤 영역은 이 높이(`--m-chrome-top`)만큼 위를 비운다.
  // 막대 상태도 구독해, 화면이 막대를 올리거나 숨기는 커밋에 이 틀도 서서 그 그림에서 바로 다시 잰다(다음 프레임으로 미루지 않는다).
  useMobileBar();
  const frameRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  useChromeHeightProperty(headRef, frameRef, "--m-chrome-top");

  const openOperation = (operationId: string) => {
    setMobileDestination({ kind: "home" });
    if (path !== "/operations") navigate("/operations");
    focusOperation(operationId);
  };

  return (
    <MobileSettingsHostContext.Provider value={settingsHost}>
    <MobileAttentionProvider rows={rows}>
      <div ref={frameRef} className="mobile-frame" lang={locale}>
        <div ref={headRef} className="mobile-frame-head">
          <MobileTopBar />
          {/* 연결·상태 띠는 상단 막대 바로 아래에 선다(S-34). */}
          {bands}
        </div>
        {children}
        <MobileRequestBanner
          state={state}
          viewingOperationId={path === "/operations" && (destination.kind === "home" || destination.kind === "info") ? state.activeOperationId : null}
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
