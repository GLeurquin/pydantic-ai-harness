import { addNotification, dismissNotification, type Notification } from './notifications';

describe('addNotification', () => {
  it('appends to an empty list', () => {
    expect(addNotification([], { id: 'n1', message: 'failed' })).toEqual([{ id: 'n1', message: 'failed' }]);
  });

  it('appends after existing notifications, preserving order', () => {
    const existing: Notification[] = [{ id: 'n1', message: 'first' }];
    expect(addNotification(existing, { id: 'n2', message: 'second' })).toEqual([
      { id: 'n1', message: 'first' },
      { id: 'n2', message: 'second' },
    ]);
  });

  it('does not mutate the input array', () => {
    const existing: Notification[] = [{ id: 'n1', message: 'first' }];
    addNotification(existing, { id: 'n2', message: 'second' });
    expect(existing).toEqual([{ id: 'n1', message: 'first' }]);
  });
});

describe('dismissNotification', () => {
  it('removes the matching notification', () => {
    const notifications: Notification[] = [
      { id: 'n1', message: 'first' },
      { id: 'n2', message: 'second' },
    ];
    expect(dismissNotification(notifications, 'n1')).toEqual([{ id: 'n2', message: 'second' }]);
  });

  it('is a no-op for an unknown id', () => {
    const notifications: Notification[] = [{ id: 'n1', message: 'first' }];
    expect(dismissNotification(notifications, 'ghost')).toEqual(notifications);
  });

  it('returns an empty array when the last notification is dismissed', () => {
    expect(dismissNotification([{ id: 'n1', message: 'first' }], 'n1')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const notifications: Notification[] = [{ id: 'n1', message: 'first' }];
    dismissNotification(notifications, 'n1');
    expect(notifications).toEqual([{ id: 'n1', message: 'first' }]);
  });
});
