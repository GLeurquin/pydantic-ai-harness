import type { Story } from '@ladle/react';

import { NotificationTray } from './NotificationTray';

const noop = () => undefined;

export const SingleNotification: Story = () => (
  <NotificationTray notifications={[{ id: 'n1', message: 'Failed to send prompt: agent unreachable' }]} onDismiss={noop} />
);

export const MultipleNotifications: Story = () => (
  <NotificationTray
    notifications={[
      { id: 'n1', message: 'Failed to archive agent: connection reset' },
      { id: 'n2', message: 'process exited unexpectedly' },
    ]}
    onDismiss={noop}
  />
);
