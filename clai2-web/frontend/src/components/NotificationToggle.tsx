import { useState } from 'react';

import { disableNotifications, enableNotifications, loadNotificationsEnabled, notificationPermission } from '../notify';

/** Opt-in toggle for browser notifications (an approval request, a goal loop stopping).
 * Renders nothing when the browser has no Notification API at all; a browser-level "denied"
 * still renders, disabled, so the state is legible rather than silently vanishing. */
export function NotificationToggle() {
  const [enabled, setEnabled] = useState(loadNotificationsEnabled);
  const permission = notificationPermission();

  if (permission === 'unsupported') {
    return null;
  }
  if (permission === 'denied') {
    return (
      <button disabled title="Notifications are blocked for this site in your browser">
        Notifications blocked
      </button>
    );
  }

  const toggle = async () => {
    if (enabled) {
      disableNotifications();
      setEnabled(false);
      return;
    }
    setEnabled(await enableNotifications());
  };

  return (
    <button onClick={() => void toggle()} aria-pressed={enabled}>
      {enabled ? 'Notifications on' : 'Enable notifications'}
    </button>
  );
}
