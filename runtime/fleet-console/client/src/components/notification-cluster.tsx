import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useConsoleState } from "../hooks/use-store.js";
import { computeVisibleSessionIds, filterByPreferences, groupNotificationsByTheater, splitNotificationsByVisibility } from "../reduce.js";
import { focusOperation, setDnd, setGlobalMute, toggleTheaterMute } from "../store.js";
import type { NotificationTheaterGroup } from "../reduce.js";
import type { NotificationKind, OperationNotification } from "../types.js";

// kind별 사용자 표기 — 함대 메타포 영문 라벨. 완료=Stood down, 입력 대기=Awaiting orders.
const KIND_LABEL: Record<NotificationKind, string> = {
  ended: "Stood down",
  "input-waiting": "Awaiting orders",
};

// 도킹 패널 열림/닫힘 상태 persistence — Codex Side와 같은 우현 도킹 토글.
const DOCK_OPEN_STORAGE_KEY = "fleet-console.notificationsDockOpen";
const DEFAULT_DOCK_OPEN = false;

// 우현 도킹 알림 패널. Codex Side처럼 우측 가장자리에 붙어 엣지 핸들로 언제든 열고 닫는다.
// 닫힘=엣지 핸들(신호+카운트), 열림=도킹 패널(Theater 그룹). 클러스터는 보이지 않는 세션만 렌더한다.
export function NotificationClusterHost() {
  const state = useConsoleState();
  const navigate = useNavigate();
  const [open, setOpen] = useState(readDockOpen);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const dockRef = useRef<HTMLElement | null>(null);

  const notifications = useMemo(
    () => Object.values(state.operationNotifications),
    [state.operationNotifications],
  );
  const visibleIds = computeVisibleSessionIds(state);
  const eligible = splitNotificationsByVisibility(notifications, visibleIds).hidden;
  const filtered = filterByPreferences(eligible, state.notificationPreferences);
  const groups = groupNotificationsByTheater(filtered);
  // 설정 팝오버용 — preference로 가려진 Theater도 음소거 토글 대상으로 노출하므로 미필터 그룹을 쓴다.
  const settingsGroups = groupNotificationsByTheater(eligible);
  const totalCount = groups.reduce((sum, group) => sum + group.totalCount, 0);
  const waitingCount = countByKind(groups, "input-waiting");
  const endedCount = countByKind(groups, "ended");
  const preferencesActive = preferencesAreActive(state.notificationPreferences);
  const muted = groups.length === 0;
  // 신호 상태 — 입력 대기가 있으면 awaiting(warn·perimeter wake), 완료만이면 ended(positive), 없으면 muted.
  const signalState = muted ? "muted" : waitingCount > 0 ? "awaiting" : "ended";

  // ── 접힘 상태 새 알림 외곽 펄스 ──
  // filtered(음소거 제외) 알림의 최대 시퀀스를 watermark로 추적한다. lastRaisedSeq는 새 알림이
  // 생성될 때만 단조 증가하므로, 증가分이 곧 "방금 도착한 새 알림"이다.
  const latestSeq = useMemo(
    () => filtered.reduce((max, notification) => Math.max(max, notification.lastRaisedSeq), 0),
    [filtered],
  );
  const seenSeqRef = useRef(latestSeq);
  const [pulseKey, setPulseKey] = useState(0);

  const setDockOpen = useCallback((next: boolean) => {
    setOpen(next);
    writeDockOpen(next);
  }, []);

  useEffect(() => {
    // 접힘 상태에서 시퀀스가 증가하면 외곽 펄스를 1회 재생한다. 펼침 상태에서 도착한 알림은
    // 닫을 때 펄스가 몰아치지 않도록 watermark만 끌어올리고 트리거하지 않는다.
    if (latestSeq > seenSeqRef.current && !open) {
      setPulseKey((key) => key + 1);
    }
    seenSeqRef.current = latestSeq;
  }, [latestSeq, open]);

  // dock이 열린 동안에만 바깥 클릭/Escape 닫기 리스너를 붙인다.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        setDockOpen(false);
        return;
      }
      if (dockRef.current?.contains(target) || handleRef.current?.contains(target)) return;
      setDockOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDockOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, setDockOpen]);

  // 알림 사이드바는 알림 유무와 무관하게 항상 노출한다(대원수 지시) — 빈 상태도 핸들/패널을 유지한다.

  const handleMove = (notification: OperationNotification) => {
    focusOperation(notification.sessionId);
    navigate("/operations");
    setDockOpen(false);
  };

  // ── 닫힘: 우현 엣지 핸들 ──
  if (!open) {
    return (
      <button
        ref={handleRef}
        type="button"
        className={`notification-handle is-${signalState} ${signalState === "awaiting" ? "has-awaiting" : ""}`}
        onClick={() => setDockOpen(true)}
        aria-label={`Open notifications (${totalCount})`}
      >
        <span className="notification-handle-count">{muted ? 0 : totalCount}</span>
        <span className="notification-handle-label">Alerts</span>
        <ChevronIcon className="notification-handle-chevron" />
        {pulseKey > 0 ? <span key={pulseKey} className="notification-handle-pulse" aria-hidden="true" /> : null}
      </button>
    );
  }

  // ── 열림: 우현 도킹 패널 ──
  return (
    <div className="notification-dock-layer">
      <aside
        ref={dockRef}
        className={`notification-dock ${signalState === "awaiting" ? "has-awaiting" : ""}`}
        aria-live="polite"
        aria-label="Operation notifications"
      >
        <header className="notification-dock-head">
          <span className="notification-dock-eyebrow">Notifications</span>
          {!muted ? (
            <span className="notification-dock-tallies" aria-hidden="true">
              {waitingCount > 0 ? <span className="notification-tally is-input-waiting">{waitingCount}</span> : null}
              {endedCount > 0 ? <span className="notification-tally is-ended">{endedCount}</span> : null}
            </span>
          ) : null}
          <button
            type="button"
            className="notification-dock-icon"
            onClick={() => setSettingsOpen(!settingsOpen)}
            aria-expanded={settingsOpen}
            aria-label="Notification settings"
            title="Notification settings"
          >
            <SettingsIcon />
          </button>
          <button
            type="button"
            className="notification-dock-icon"
            onClick={() => setDockOpen(false)}
            aria-label="Close notifications"
            title="Close"
          >
            <CloseIcon />
          </button>
        </header>

        {settingsOpen ? <NotificationSettings groups={settingsGroups} /> : null}

        {muted ? (
          <p className="notification-dock-empty">No active alerts</p>
        ) : (
          <div className="notification-dock-deck">
            {groups.map((group) => (
              <section className="notification-cluster-group" key={group.theaterId ?? "__unknown__"}>
                <header className="notification-cluster-group-head">
                  <span className="notification-cluster-theater">{group.theaterLabel}</span>
                  <span className="notification-cluster-group-count">{group.totalCount}</span>
                </header>
                <ul className="notification-cluster-roster">
                  {group.notifications.map((notification) => (
                    <li className={`notification-row is-${notification.kind}`} key={notification.sessionId}>
                      <span className="notification-row-beacon" aria-hidden="true" />
                      <span className="notification-row-body">
                        <span className="notification-row-op">{notification.operationLabel}</span>
                        <span className="notification-row-state">{KIND_LABEL[notification.kind]}</span>
                      </span>
                      {notification.count > 1 ? <span className="notification-row-count">{notification.count}</span> : null}
                      <button
                        type="button"
                        className="notification-row-move"
                        onClick={() => handleMove(notification)}
                        aria-label={`Open ${group.theaterLabel} ${notification.operationLabel}`}
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

function readDockOpen(): boolean {
  if (typeof window === "undefined") return DEFAULT_DOCK_OPEN;
  try {
    const stored = window.localStorage.getItem(DOCK_OPEN_STORAGE_KEY);
    return stored === null ? DEFAULT_DOCK_OPEN : stored === "true";
  } catch {
    return DEFAULT_DOCK_OPEN;
  }
}

function writeDockOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DOCK_OPEN_STORAGE_KEY, String(open));
  } catch {
    // 저장소가 막힌 환경에서는 현재 세션 상태만 유지한다.
  }
}

function preferencesAreActive(prefs: {
  readonly globalMute: boolean;
  readonly dnd: boolean;
  readonly mutedTheaterIds: Readonly<Record<string, true>>;
}): boolean {
  return prefs.globalMute || prefs.dnd || Object.keys(prefs.mutedTheaterIds).length > 0;
}

function countByKind(groups: readonly NotificationTheaterGroup[], kind: NotificationKind): number {
  let total = 0;
  for (const group of groups) {
    for (const notification of group.notifications) {
      if (notification.kind === kind) total += notification.count;
    }
  }
  return total;
}

function NotificationSettings({ groups }: { readonly groups: readonly NotificationTheaterGroup[] }) {
  const state = useConsoleState();
  const muteableGroups = collectMuteableTheaterGroups(groups, state.notificationPreferences.mutedTheaterIds, state.theaters);
  return (
    <div className="notification-cluster-settings" role="dialog" aria-label="Notification settings">
      <p className="notification-cluster-settings-eyebrow">Display</p>
      <label className="notification-cluster-setting">
        <input
          type="checkbox"
          checked={state.notificationPreferences.globalMute}
          onChange={(event) => setGlobalMute(event.currentTarget.checked)}
        />
        <span>Mute all</span>
      </label>
      <label className="notification-cluster-setting">
        <input
          type="checkbox"
          checked={state.notificationPreferences.dnd}
          onChange={(event) => setDnd(event.currentTarget.checked)}
        />
        <span>Do not disturb</span>
      </label>
      {muteableGroups.length > 0 ? <p className="notification-cluster-settings-eyebrow">By Theater</p> : null}
      {muteableGroups.map((group) => (
        <label className="notification-cluster-setting" key={group.theaterId}>
          <input
            type="checkbox"
            checked={group.theaterId ? state.notificationPreferences.mutedTheaterIds[group.theaterId] === true : false}
            onChange={() => {
              if (group.theaterId) toggleTheaterMute(group.theaterId);
            }}
          />
          <span>{group.theaterLabel}</span>
        </label>
      ))}
    </div>
  );
}

function collectMuteableTheaterGroups(
  groups: readonly NotificationTheaterGroup[],
  mutedTheaterIds: Readonly<Record<string, true>>,
  theaters: readonly { readonly id: string; readonly label: string }[],
): readonly NotificationTheaterGroup[] {
  const byId = new Map<string, NotificationTheaterGroup>();
  for (const group of groups) {
    if (group.theaterId) byId.set(group.theaterId, group);
  }
  for (const theaterId of Object.keys(mutedTheaterIds)) {
    if (byId.has(theaterId)) continue;
    byId.set(theaterId, {
      theaterId,
      theaterLabel: theaters.find((theater) => theater.id === theaterId)?.label ?? theaterId,
      notifications: [],
      totalCount: 0,
    });
  }
  return [...byId.values()];
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 5.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M8 2.2v1.6M8 12.2v1.6M3.9 3.9 5 5M11 11l1.1 1.1M2.2 8h1.6M12.2 8h1.6M3.9 12.1 5 11M11 5l1.1-1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ className }: { readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
