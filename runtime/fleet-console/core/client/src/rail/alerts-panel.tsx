import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import "../styles/rail-alerts.css";
import { getT, useT } from "../i18n/index.js";
import { useActiveRailPanelId } from "./rail-store.js";
import { useConsoleState } from "../hooks/use-store.js";
import {
  computeVisibleOperationIds,
  filterByLiveOperations,
  filterByPreferences,
  groupNotificationsByTheater,
  splitNotificationsByVisibility,
} from "../notification-reduce.js";
import { focusOperation, setDnd, setGlobalMute, toggleTheaterMute } from "../store.js";
import type { NotificationTheaterGroup } from "../notification-reduce.js";
import type { NotificationKind, OperationNotification } from "../types.js";

function buildKindLabels(t: ReturnType<typeof getT>): Record<NotificationKind, string> {
  return {
    ended: t("rail.alerts.kindEnded"),
    "input-waiting": t("rail.alerts.kindWaiting"),
  };
}

export const alertsPanel: RailPanelDescriptor = {
  id: "alerts",
  title: (locale: ConsoleLocale) => getT(locale)("rail.alerts.title"),
  icon: () => <AlertsIcon />,
  render: () => <AlertsPanelBody />,
};

export function AlertsPanelBody() {
  const t = useT();
  const kindLabels = buildKindLabels(t);
  const state = useConsoleState();
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const notifications = useMemo(
    () => filterByLiveOperations(Object.values(state.operationNotifications), state.operations),
    [state.operationNotifications, state.operations],
  );
  const visibleIds = computeVisibleOperationIds(state);
  const eligible = splitNotificationsByVisibility(notifications, visibleIds).hidden;
  const filtered = filterByPreferences(eligible, state.notificationPreferences);
  const groups = groupNotificationsByTheater(filtered);
  const settingsGroups = groupNotificationsByTheater(eligible);
  const waitingCount = countByKind(groups, "input-waiting");
  const endedCount = countByKind(groups, "ended");
  const muted = groups.length === 0;

  const handleMove = useCallback(
    (notification: OperationNotification) => {
      // 최대화는 직접 해제하지 않는다 — 이동 경로(operations.tsx의 pendingOperationFocus 소비)가
      // 최대화 중이면 최대화 대상을 목적지 op로 교체해 최대화 뷰를 유지한다.
      focusOperation(notification.operationId);
      navigate("/operations");
      // rail 패널은 닫지 않는다 — 사용자가 명시적으로 닫을 때까지 유지
    },
    [navigate],
  );

  return (
    <div className="alerts-panel-body" aria-live="polite" aria-label={t("rail.alerts.panelAria")}>
      <div className="alerts-panel-toolbar">
        <div className="alerts-panel-tallies" aria-hidden="true">
          {waitingCount > 0 ? (
            <span className="notification-tally is-input-waiting">{waitingCount}</span>
          ) : null}
          {endedCount > 0 ? (
            <span className="notification-tally is-ended">{endedCount}</span>
          ) : null}
          {muted ? <span className="alerts-panel-tally-empty">—</span> : null}
        </div>
        <button
          type="button"
          className={`alerts-panel-settings-btn${settingsOpen ? " is-active" : ""}`}
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-label={t("rail.alerts.settingsAria")}
          title={t("rail.alerts.settingsAria")}
        >
          <SettingsIcon />
        </button>
      </div>

      {settingsOpen ? <NotificationSettings groups={settingsGroups} /> : null}

      {muted ? (
        <p className="notification-dock-empty">{t("rail.alerts.empty")}</p>
      ) : (
        <div className="notification-dock-deck">
          {groups.map((group) => (
            <section
              className="notification-cluster-group"
              key={group.theaterId ?? "__unknown__"}
            >
              <header className="notification-cluster-group-head">
                <span className="notification-cluster-theater">{group.theaterLabel}</span>
                <span className="notification-cluster-group-count">{group.notifications.length}</span>
              </header>
              <ul className="notification-cluster-roster">
                {group.notifications.map((notification) => (
                  <li
                    className={`notification-row is-${notification.kind}`}
                    key={notification.operationId}
                  >
                    <span className="notification-row-beacon" aria-hidden="true" />
                    <span className="notification-row-body">
                      <span className="notification-row-op">{notification.operationLabel}</span>
                      <span className="notification-row-state">
                        {kindLabels[notification.kind]}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="notification-row-move"
                      onClick={() => handleMove(notification)}
                      aria-label={t("rail.alerts.openAria", { theater: group.theaterLabel, operation: notification.operationLabel })}
                    >
                      {t("rail.alerts.open")}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AlertsIcon() {
  const state = useConsoleState();
  const activeId = useActiveRailPanelId();
  const isActive = activeId === "alerts";

  const notifications = useMemo(
    () => filterByLiveOperations(Object.values(state.operationNotifications), state.operations),
    [state.operationNotifications, state.operations],
  );
  const visibleIds = computeVisibleOperationIds(state);
  const eligible = splitNotificationsByVisibility(notifications, visibleIds).hidden;
  const filtered = filterByPreferences(eligible, state.notificationPreferences);
  const groups = groupNotificationsByTheater(filtered);
  const totalCount = groups.reduce((sum, group) => sum + group.notifications.length, 0);
  const waitingCount = countByKind(groups, "input-waiting");

  const signalState = totalCount === 0 ? "muted" : waitingCount > 0 ? "awaiting" : "ended";

  return (
    <span className={`alerts-icon is-${signalState}`} aria-hidden="true">
      <BellIcon />
      {totalCount > 0 ? <span className="alerts-icon-badge">{totalCount}</span> : null}
    </span>
  );
}

function NotificationSettings({
  groups,
}: {
  readonly groups: readonly NotificationTheaterGroup[];
}) {
  const t = useT();
  const state = useConsoleState();
  const muteableGroups = collectMuteableTheaterGroups(
    groups,
    state.notificationPreferences.mutedTheaterIds,
    state.theaters,
  );
  return (
    <div className="notification-cluster-settings" role="dialog" aria-label={t("rail.alerts.settingsAria")}>
      <p className="notification-cluster-settings-eyebrow">{t("rail.alerts.settingsDisplay")}</p>
      <label className="notification-cluster-setting">
        <input
          type="checkbox"
          checked={state.notificationPreferences.globalMute}
          onChange={(event) => setGlobalMute(event.currentTarget.checked)}
        />
        <span>{t("rail.alerts.muteAll")}</span>
      </label>
      <label className="notification-cluster-setting">
        <input
          type="checkbox"
          checked={state.notificationPreferences.dnd}
          onChange={(event) => setDnd(event.currentTarget.checked)}
        />
        <span>{t("rail.alerts.dnd")}</span>
      </label>
      {muteableGroups.length > 0 ? (
        <p className="notification-cluster-settings-eyebrow">{t("rail.alerts.byTheater")}</p>
      ) : null}
      {muteableGroups.map((group) => (
        <label className="notification-cluster-setting" key={group.theaterId}>
          <input
            type="checkbox"
            checked={
              group.theaterId
                ? state.notificationPreferences.mutedTheaterIds[group.theaterId] === true
                : false
            }
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
      theaterLabel:
        theaters.find((theater) => theater.id === theaterId)?.label ?? theaterId,
      notifications: [],
    });
  }
  return [...byId.values()];
}

function countByKind(
  groups: readonly NotificationTheaterGroup[],
  kind: NotificationKind,
): number {
  let total = 0;
  for (const group of groups) {
    for (const notification of group.notifications) {
      if (notification.kind === kind) total += 1;
    }
  }
  return total;
}

function BellIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
      <path
        d="M8 2a4.5 4.5 0 0 0-4.5 4.5v2.25L2 10.5v.75h12v-.75l-1.5-1.75V6.5A4.5 4.5 0 0 0 8 2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 12a1.5 1.5 0 0 0 3 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="15" height="15">
      <path
        d="M8 5.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
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
