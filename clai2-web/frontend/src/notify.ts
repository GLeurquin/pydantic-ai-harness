/** Browser notifications for events worth interrupting for: an approval request, or an
 * autonomous goal loop stopping. Opt-in (nothing fires until `enableNotifications` succeeds)
 * and gated on the tab being hidden, so a user actively watching the page -- including the
 * moment they click something themselves, like Stop on a goal -- never gets pinged about
 * their own action; that gate is what makes a separate "was this caused by me" check
 * unnecessary. */

const STORAGE_KEY = 'clai2:notifications-enabled';

function supported(): boolean {
  return typeof Notification !== 'undefined';
}

/** `'unsupported'` when this browser has no Notification API at all (some older or
 * privacy-hardened browsers, or a non-browser test environment) -- distinct from `'denied'`,
 * which means the user or browser refused it and no toggle can undo that from script. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

export function loadNotificationsEnabled(): boolean {
  if (!supported()) {
    return false;
  }
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Best-effort: the toggle still reflects `enabled` for the rest of this session.
  }
}

/** Requests permission if not already decided, and persists the opt-in on success.
 * Returns whether notifications actually ended up enabled. */
export async function enableNotifications(): Promise<boolean> {
  if (!supported()) {
    return false;
  }
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  const enabled = permission === 'granted';
  saveNotificationsEnabled(enabled);
  return enabled;
}

/** Turns the opt-in back off. Cannot revoke the browser's own permission grant -- there is no
 * API for that -- only whether this app uses it. */
export function disableNotifications(): void {
  saveNotificationsEnabled(false);
}

export function notify(title: string, body?: string): void {
  if (!supported() || !document.hidden || Notification.permission !== 'granted' || !loadNotificationsEnabled()) {
    return;
  }
  new Notification(title, body ? { body } : undefined);
}
