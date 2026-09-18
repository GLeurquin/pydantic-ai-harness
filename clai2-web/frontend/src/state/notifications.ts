/** Transient error notifications, kept pure for testing. */

export interface Notification {
  id: string;
  message: string;
}

export function addNotification(notifications: readonly Notification[], notification: Notification): Notification[] {
  return [...notifications, notification];
}

export function dismissNotification(notifications: readonly Notification[], id: string): Notification[] {
  return notifications.filter((notification) => notification.id !== id);
}
