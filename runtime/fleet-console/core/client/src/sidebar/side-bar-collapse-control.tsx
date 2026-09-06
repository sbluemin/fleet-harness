import { useT } from "../i18n/index.js";
import { sideBarShortcutLabel, sideBarStatusViewShortcutLabel } from "../shortcuts.js";
import { setSideBarCollapsed, toggleSideBarStatusAxis, useSideBarState } from "./operations-side-bar-store.js";

// 접기는 패널 자신의 동사다(Periscope 문법 — 밴드 토글 퇴역). 도킹 중에는 접기 셰브런이,
// 엣지 독이 되부른 픽(오버레이) 중에는 같은 자리가 "열어 두기"(고정)로 바뀐다 — 픽에서
// 접기는 무의미하고(이미 접혀 있다) 남는 결정은 고정뿐이라, 한 자리가 두 낱말을 나눠 쓴다.
// Map 사이드바와 War Room 선별 사이드바가 같은 접힘 상태를 쓰므로 컨트롤도 한 벌이다.
export function SideBarCollapseControl() {
  const t = useT();
  const { collapsed, peeking } = useSideBarState();
  // 접힌 채 픽도 아니면 카드 자체가 없다 — 컨트롤의 문은 엣지 독이 진다.
  if (collapsed && !peeking) return null;
  const pinning = collapsed && peeking;
  const shortcut = sideBarShortcutLabel();
  const label = t(pinning ? "sidebar.chrome.keepOpen" : "sidebar.chrome.collapse", { shortcut });
  return (
    <button
      type="button"
      className="side-bar-collapse"
      aria-label={label}
      title={label}
      onClick={() => setSideBarCollapsed(!pinning)}
    >
      {pinning ? <KeepOpenIcon /> : <CollapseIcon />}
    </button>
  );
}

// 접기 방향(좌측 엣지)을 가리키는 단일 셰브런 — 엣지 독 트리거의 펼침 셰브런과 한 쌍이다.
function CollapseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.6 5.4 8l4.4 4.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function KeepOpenIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.2 2.5h5.6M6.4 2.5v3.1L4.6 7.7v1h6.8v-1L9.6 5.6V2.5M8 8.7v4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// 상태별 보기 토글 — 목록을 Theater 묶음에서 대기·실행 중·유휴의 평면 목록으로 뒤집는 하나짜리
// 세션 스위치다. 눌림(aria-pressed)은 레일 아이콘의 켜짐과 같은 문법(brass 잉크·어두운 면)으로
// "지금 이 보기"를 말한다. 축은 의도적으로 세션 메모리에만 산다(operations-side-bar-store).
export function SideBarStatusViewToggle({ active }: { readonly active: boolean }) {
  const t = useT();
  const label = t("sidebar.view.byStatus", { shortcut: sideBarStatusViewShortcutLabel() });
  return (
    <button
      type="button"
      className="side-bar-status-view-toggle"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={() => toggleSideBarStatusAxis()}
    >
      <StatusViewIcon />
    </button>
  );
}

function StatusViewIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2.6v10.8M5 13.4 2.8 11.2M5 13.4l2.2-2.2M11 13.4V2.6M11 2.6 8.8 4.8M11 2.6l2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// 레일로 좁히기 / 목록으로 펼치기 — 카드 폭을 64px 레일과 사용자 폭 사이에서 뒤집는다. Cruise/Tactical은
// 이 선택을 기억하고(localStorage), War Room은 레일이 기본이라 세션 안에서만 펼친 채 둔다.
export function SideBarNarrowToggle({ narrow, onToggle }: { readonly narrow: boolean; readonly onToggle: () => void }) {
  const t = useT();
  const label = t(narrow ? "sidebar.view.widen" : "sidebar.view.narrow");
  return (
    <button
      type="button"
      className="side-bar-status-view-toggle side-bar-narrow-toggle"
      aria-pressed={narrow}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      {narrow
        ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 3.6 10.6 8l-4.4 4.4M3.5 3.6v8.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.8 3.6 5.4 8l4.4 4.4M12.5 3.6v8.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </button>
  );
}
