import { useEffect } from 'react';

import type { Notification } from '../state/notifications';

export interface NotificationTrayProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  /** Auto-dismiss delay in milliseconds. */
  autoDismissMs?: number;
}

const DEFAULT_AUTO_DISMISS_MS = 6000;

/** One notification with its own auto-dismiss timer, independent of its
 * siblings so a new notification never resets an older one's countdown. */
function NotificationItem({
  notification,
  onDismiss,
  autoDismissMs,
}: {
  notification: Notification;
  onDismiss: (id: string) => void;
  autoDismissMs: number;
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(notification.id), autoDismissMs);
    return () => clearTimeout(timer);
  }, [notification.id, onDismiss, autoDismissMs]);

  return (
    <div className="notification" role="alert">
      <span>{notification.message}</span>
      <button aria-label="Dismiss" onClick={() => onDismiss(notification.id)}>
        ×
      </button>
    </div>
  );
}

export function NotificationTray({ notifications, onDismiss, autoDismissMs = DEFAULT_AUTO_DISMISS_MS }: NotificationTrayProps) {
  if (notifications.length === 0) {
    return null;
  }
  return (
    <div className="notification-tray" aria-label="Notifications">
      {notifications.map((notification) => (
        <NotificationItem
          key={notification.id}
          notification={notification}
          onDismiss={onDismiss}
          autoDismissMs={autoDismissMs}
        />
      ))}
    </div>
  );
}
