import { afterEach, beforeEach, vi } from 'vitest';

import {
  disableNotifications,
  enableNotifications,
  loadNotificationsEnabled,
  notificationPermission,
  notify,
} from './notify';

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  static instances: MockNotification[] = [];

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

describe('notify (unsupported browser)', () => {
  it('reports unsupported and never enables when there is no Notification API', async () => {
    expect(notificationPermission()).toBe('unsupported');
    expect(loadNotificationsEnabled()).toBe(false);
    expect(await enableNotifications()).toBe(false);
  });
});

describe('notify (with a Notification API)', () => {
  beforeEach(() => {
    localStorage.clear();
    MockNotification.permission = 'default';
    MockNotification.instances = [];
    MockNotification.requestPermission = vi.fn();
    (globalThis as unknown as { Notification: typeof MockNotification }).Notification = MockNotification;
    setHidden(true);
  });

  afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
    setHidden(false);
  });

  it('reports the browser permission when supported', () => {
    MockNotification.permission = 'default';
    expect(notificationPermission()).toBe('default');
  });

  it('defaults to disabled and persists across loads', () => {
    expect(loadNotificationsEnabled()).toBe(false);
    localStorage.setItem('clai2:notifications-enabled', 'true');
    expect(loadNotificationsEnabled()).toBe(true);
  });

  it('requests permission, persists, and reports enabled on success', async () => {
    MockNotification.requestPermission.mockResolvedValue('granted');
    expect(await enableNotifications()).toBe(true);
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(loadNotificationsEnabled()).toBe(true);
  });

  it('does not re-request permission that is already granted', async () => {
    MockNotification.permission = 'granted';
    expect(await enableNotifications()).toBe(true);
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('persists disabled and reports false when the user refuses', async () => {
    MockNotification.requestPermission.mockResolvedValue('denied');
    expect(await enableNotifications()).toBe(false);
    expect(loadNotificationsEnabled()).toBe(false);
  });

  it('disableNotifications turns the opt-in back off', async () => {
    MockNotification.requestPermission.mockResolvedValue('granted');
    await enableNotifications();
    expect(loadNotificationsEnabled()).toBe(true);
    disableNotifications();
    expect(loadNotificationsEnabled()).toBe(false);
  });

  it('fires a real Notification only when hidden, granted, and opted in', async () => {
    MockNotification.permission = 'granted';
    await enableNotifications();
    notify('Approval needed', 'agent-1 is waiting');
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]).toMatchObject({ title: 'Approval needed', options: { body: 'agent-1 is waiting' } });
  });

  it('omits options when no body is given', async () => {
    MockNotification.permission = 'granted';
    await enableNotifications();
    notify('Goal finished');
    expect(MockNotification.instances[0]).toMatchObject({ title: 'Goal finished', options: undefined });
  });

  it('stays quiet while the tab is visible', async () => {
    MockNotification.permission = 'granted';
    await enableNotifications();
    setHidden(false);
    notify('Approval needed');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('stays quiet when permission was never granted', () => {
    MockNotification.permission = 'default';
    notify('Approval needed');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('stays quiet when the user has not opted in, even with permission granted', () => {
    MockNotification.permission = 'granted';
    notify('Approval needed');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not crash and treats notifications as disabled when localStorage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadNotificationsEnabled()).toBe(false);
    getItem.mockRestore();
  });

  it('does not crash when localStorage.setItem throws while enabling', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    MockNotification.requestPermission.mockResolvedValue('granted');
    await expect(enableNotifications()).resolves.toBe(true);
    setItem.mockRestore();
  });
});
