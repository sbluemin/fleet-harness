import type { ConsoleState, NotificationPreferences, OperationNotification } from "./types.js";

export interface NotificationTheaterGroup {
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly notifications: readonly OperationNotification[];
  readonly totalCount: number;
}

export interface VisibilitySplitNotifications {
  readonly hidden: readonly OperationNotification[];
  readonly visible: readonly OperationNotification[];
}

export function computeVisibleOperationIds(consoleSnap: ConsoleState): ReadonlySet<string> {
  // 현재 보고 있는 패널(operations 화면이 떠 있고 active인 패널) 하나만 "보임"으로 간주한다.
  // Theater·최소화·최대화와 무관하게 그 외 모든 패널의 Awaiting/Complete 알림은 ALERTS로 노출하고,
  // 지금 보고 있는 active 패널의 알림만 무시한다.
  if (!consoleSnap.operationsViewActive || !consoleSnap.activeOperationId) return new Set();
  return new Set([consoleSnap.activeOperationId]);
}

export function splitNotificationsByVisibility(
  notifications: readonly OperationNotification[],
  visibleIds: ReadonlySet<string>,
): VisibilitySplitNotifications {
  const hidden: OperationNotification[] = [];
  const visible: OperationNotification[] = [];
  for (const notification of notifications) {
    if (visibleIds.has(notification.operationId)) {
      visible.push(notification);
    } else {
      hidden.push(notification);
    }
  }
  return { hidden, visible };
}

export function groupNotificationsByTheater(notifications: readonly OperationNotification[]): readonly NotificationTheaterGroup[] {
  const groups = new Map<string, { theaterId: string | null; theaterLabel: string; notifications: OperationNotification[]; totalCount: number }>();
  for (const notification of [...notifications].sort((a, b) => b.lastRaisedSeq - a.lastRaisedSeq)) {
    const key = notification.theaterId ?? "__unknown__";
    const group = groups.get(key) ?? {
      theaterId: notification.theaterId,
      theaterLabel: notification.theaterLabel,
      notifications: [],
      totalCount: 0,
    };
    group.notifications.push(notification);
    group.totalCount += notification.count;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const aLatest = a.notifications[0]?.lastRaisedSeq ?? 0;
    const bLatest = b.notifications[0]?.lastRaisedSeq ?? 0;
    return bLatest - aLatest;
  });
}

export function filterByPreferences(
  notifications: readonly OperationNotification[],
  prefs: NotificationPreferences,
): readonly OperationNotification[] {
  if (prefs.globalMute || prefs.dnd) return [];
  return notifications.filter((notification) => !notification.theaterId || prefs.mutedTheaterIds[notification.theaterId] !== true);
}
