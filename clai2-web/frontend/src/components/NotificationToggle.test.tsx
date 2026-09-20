import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';

import { NotificationToggle } from './NotificationToggle';

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn<() => Promise<NotificationPermission>>();

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {}
}

describe('NotificationToggle', () => {
  it('renders nothing when the browser has no Notification API', () => {
    const { container } = render(<NotificationToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  describe('with a Notification API', () => {
    beforeEach(() => {
      localStorage.clear();
      MockNotification.permission = 'default';
      MockNotification.requestPermission = vi.fn();
      (globalThis as unknown as { Notification: typeof MockNotification }).Notification = MockNotification;
    });

    afterEach(() => {
      delete (globalThis as { Notification?: unknown }).Notification;
    });

    it('shows Enable notifications by default', () => {
      render(<NotificationToggle />);
      expect(screen.getByRole('button', { name: 'Enable notifications' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('requests permission and flips to on when granted', async () => {
      const user = userEvent.setup();
      MockNotification.requestPermission.mockResolvedValue('granted');
      render(<NotificationToggle />);
      await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
      expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
      expect(await screen.findByRole('button', { name: 'Notifications on' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('stays off when the user refuses the permission prompt', async () => {
      const user = userEvent.setup();
      MockNotification.requestPermission.mockResolvedValue('denied');
      render(<NotificationToggle />);
      await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
      expect(await screen.findByRole('button', { name: 'Enable notifications' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    });

    it('toggles back off without re-requesting permission', async () => {
      const user = userEvent.setup();
      MockNotification.permission = 'granted';
      MockNotification.requestPermission.mockResolvedValue('granted');
      render(<NotificationToggle />);
      await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
      await screen.findByRole('button', { name: 'Notifications on' });

      await user.click(screen.getByRole('button', { name: 'Notifications on' }));
      expect(screen.getByRole('button', { name: 'Enable notifications' })).toHaveAttribute('aria-pressed', 'false');
      expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('renders a disabled, explanatory button when the browser has blocked notifications', () => {
      MockNotification.permission = 'denied';
      render(<NotificationToggle />);
      const button = screen.getByRole('button', { name: 'Notifications blocked' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Notifications are blocked for this site in your browser');
    });
  });
});
