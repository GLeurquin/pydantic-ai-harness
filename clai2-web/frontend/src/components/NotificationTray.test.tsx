import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import type { Notification } from '../state/notifications';
import { NotificationTray } from './NotificationTray';

describe('NotificationTray', () => {
  it('renders nothing when there are no notifications', () => {
    const { container } = render(<NotificationTray notifications={[]} onDismiss={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one alert per notification, in order', () => {
    const notifications: Notification[] = [
      { id: 'n1', message: 'first failure' },
      { id: 'n2', message: 'second failure' },
    ];
    render(<NotificationTray notifications={notifications} onDismiss={vi.fn()} />);
    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual(['first failure×', 'second failure×']);
  });

  it('fires onDismiss with the right id when its button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const notifications: Notification[] = [
      { id: 'n1', message: 'first' },
      { id: 'n2', message: 'second' },
    ];
    render(<NotificationTray notifications={notifications} onDismiss={onDismiss} />);
    await user.click(screen.getAllByLabelText('Dismiss')[1] as HTMLElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('n2');
  });

  it('auto-dismisses after the configured delay', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <NotificationTray
        notifications={[{ id: 'n1', message: 'will expire' }]}
        onDismiss={onDismiss}
        autoDismissMs={1000}
      />,
    );
    vi.advanceTimersByTime(999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('n1');
    vi.useRealTimers();
  });

  it('does not fire a dismissed notification\'s stale timer', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <NotificationTray notifications={[{ id: 'n1', message: 'gone' }]} onDismiss={onDismiss} autoDismissMs={1000} />,
    );
    rerender(<NotificationTray notifications={[]} onDismiss={onDismiss} autoDismissMs={1000} />);
    vi.advanceTimersByTime(1000);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("gives each notification its own timer, so a new one does not reset an older one's countdown", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <NotificationTray notifications={[{ id: 'n1', message: 'first' }]} onDismiss={onDismiss} autoDismissMs={1000} />,
    );
    vi.advanceTimersByTime(700);
    rerender(
      <NotificationTray
        notifications={[
          { id: 'n1', message: 'first' },
          { id: 'n2', message: 'second' },
        ]}
        onDismiss={onDismiss}
        autoDismissMs={1000}
      />,
    );
    vi.advanceTimersByTime(300);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith('n1');
    vi.useRealTimers();
  });
});
