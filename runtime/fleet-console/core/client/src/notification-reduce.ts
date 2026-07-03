import type { ConsoleState, NotificationPreferences, OperationNotification } from "./types.js";

export interface NotificationTheaterGroup {
  readonly theaterId: string | null;
  readonly theaterLabel: string;
  readonly notifications: readonly OperationNotification[];
}

export interface VisibilitySplitNotifications {
  readonly hidden: readonly OperationNotification[];
  readonly visible: readonly OperationNotification[];
}

export function computeVisibleOperationIds(consoleSnap: ConsoleState): ReadonlySet<string> {
  // 현재 보고 있는 패널(operations 화면이 떠 있고, 현재 Theater에 실재하는 active 패널) 하나만 "보임"으로 간주한다.
  // Theater·최소화·최대화와 무관하게 그 외 모든 패널의 Awaiting/Complete 알림은 ALERTS로 노출하고,
  // 지금 보고 있는 active 패널의 알림만 무시한다. Theater 전환 등으로 stale해진 activeOperationId
  // (다른 Theater를 가리키거나 이미 닫힌 패널)는 "보임"에서 제외해 그 알림이 계속 노출되게 한다.
  if (!consoleSnap.operationsViewActive || !consoleSnap.activeOperationId) return new Set();
  const active = consoleSnap.operations.find((operation) => operation.id === consoleSnap.activeOperationId);
  if (!active || active.theaterId !== consoleSnap.activeTheaterId) return new Set();
  return new Set([active.id]);
}

// 이미 닫힌(operations에 더는 존재하지 않는) 패널의 잔존 알림을 ALERTS 대상에서 제외하는 폴백.
// 활성 패널이 awaiting/complete로 전이된 뒤 닫히면 알림만 남을 수 있고, 그 알림은 이동해도 대상 패널이
// 없어 아무 반응이 없으므로 표시 자체를 막는다.
export function filterByLiveOperations(
  notifications: readonly OperationNotification[],
  operations: readonly { readonly id: string }[],
): readonly OperationNotification[] {
  const live = new Set(operations.map((operation) => operation.id));
  return notifications.filter((notification) => live.has(notification.operationId));
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
  const groups = new Map<string, { theaterId: string | null; theaterLabel: string; notifications: OperationNotification[] }>();
  for (const notification of [...notifications].sort((a, b) => b.lastRaisedSeq - a.lastRaisedSeq)) {
    const key = notification.theaterId ?? "__unknown__";
    const group = groups.get(key) ?? {
      theaterId: notification.theaterId,
      theaterLabel: notification.theaterLabel,
      notifications: [],
    };
    group.notifications.push(notification);
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
