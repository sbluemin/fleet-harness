import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useCanvasState } from "../canvas/canvas-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useOperationsMode } from "../operations-mode.js";
import { computeVisibleSessionIds, filterByPreferences, groupNotificationsByTheater, splitNotificationsByVisibility } from "../reduce.js";
import { focusOperation, setDnd, setGlobalMute, toggleTheaterMute } from "../store.js";
import type { NotificationTheaterGroup } from "../reduce.js";
import type { NotificationKind, OperationNotification } from "../types.js";

// kind별 사용자 표기 — 완료(positive)·입력 대기(warn). 색은 CSS가 .is-<kind>로 분기한다.
const KIND_LABEL: Record<NotificationKind, string> = {
  ended: "완료",
  "input-waiting": "입력 대기",
};

// 우상단 고정 알림 계기판. Theater 그룹이 펼침 조작 없이 기본 표시되고(대원수 지시),
// 각 Operation 행은 kind 비콘으로 완료/입력 대기를 구분한다. 클러스터는 보이지 않는 세션만 렌더한다.
export function NotificationClusterHost() {
  const state = useConsoleState();
  const canvas = useCanvasState();
  const mode = useOperationsMode();
  const navigate = useNavigate();
  // collapsed=전체 접기(헤더만). 기본값 false라 Theater 그룹이 곧바로 보인다.
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const notifications = useMemo(
    () => Object.values(state.operationNotifications),
    [state.operationNotifications],
  );
  const visibleIds = computeVisibleSessionIds(mode, state, canvas);
  const eligible = splitNotificationsByVisibility(notifications, visibleIds).hidden;
  const filtered = filterByPreferences(eligible, state.notificationPreferences);
  const groups = groupNotificationsByTheater(filtered);
  // 설정 팝오버용 — preference로 가려진 Theater도 음소거 토글 대상으로 노출해야 하므로 미필터 그룹을 쓴다.
  const settingsGroups = groupNotificationsByTheater(eligible);
  const totalCount = groups.reduce((sum, group) => sum + group.totalCount, 0);
  const waitingCount = countByKind(groups, "input-waiting");
  const endedCount = countByKind(groups, "ended");
  const preferencesActive = preferencesAreActive(state.notificationPreferences);
  const muted = groups.length === 0;

  // 표시할 알림도 없고 활성 preference(음소거/DND/Theater mute)도 없으면 계기판 자체를 숨긴다.
  if (muted && !preferencesActive) return null;

  const handleMove = (notification: OperationNotification) => {
    focusOperation(notification.sessionId);
    navigate("/operations");
  };

  return (
    <aside
      className={`notification-cluster ${collapsed ? "is-collapsed" : "is-open"} ${muted ? "is-muted" : ""}`}
      aria-live="polite"
      aria-label="Operation 알림"
    >
      <header className="notification-cluster-masthead">
        <button
          type="button"
          className="notification-cluster-pennant"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "알림 펼치기" : "알림 접기"}
        >
          <span className="notification-cluster-ensign" data-state={muted ? "muted" : "active"} aria-hidden="true" />
          <span className="notification-cluster-headline">
            <span className="notification-cluster-count">{muted ? "음소거됨" : totalCount}</span>
            <span className="notification-cluster-scope">{muted ? "Muted" : `${groups.length} Theater`}</span>
          </span>
          <ChevronIcon className="notification-cluster-chevron" />
        </button>
        <div className="notification-cluster-controls">
          {!muted ? (
            <span className="notification-cluster-tallies" aria-hidden="true">
              {waitingCount > 0 ? <span className="notification-tally is-input-waiting">{waitingCount}</span> : null}
              {endedCount > 0 ? <span className="notification-tally is-ended">{endedCount}</span> : null}
            </span>
          ) : null}
          <button
            type="button"
            className="notification-cluster-cog"
            onClick={() => setSettingsOpen(!settingsOpen)}
            aria-expanded={settingsOpen}
            aria-label="알림 설정"
            title="알림 설정"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      {settingsOpen ? <NotificationSettings groups={settingsGroups} /> : null}

      {!collapsed && groups.length > 0 ? (
        <div className="notification-cluster-deck">
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
                      aria-label={`${group.theaterLabel} ${notification.operationLabel}로 이동`}
                    >
                      이동
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </aside>
  );
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
    <div className="notification-cluster-settings" role="dialog" aria-label="알림 설정">
      <p className="notification-cluster-settings-eyebrow">표시 제어</p>
      <label className="notification-cluster-setting">
        <input
          type="checkbox"
          checked={state.notificationPreferences.globalMute}
          onChange={(event) => setGlobalMute(event.currentTarget.checked)}
        />
        <span>전체 음소거</span>
      </label>
      <label className="notification-cluster-setting">
        <input
          type="checkbox"
          checked={state.notificationPreferences.dnd}
          onChange={(event) => setDnd(event.currentTarget.checked)}
        />
        <span>방해 금지</span>
      </label>
      {muteableGroups.length > 0 ? <p className="notification-cluster-settings-eyebrow">Theater별</p> : null}
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

function ChevronIcon({ className }: { readonly className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
