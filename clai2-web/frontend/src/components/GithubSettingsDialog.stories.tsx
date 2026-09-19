import type { Story } from '@ladle/react';

import { GithubSettingsDialog } from './GithubSettingsDialog';

const noop = () => undefined;
const resolve = () => Promise.resolve();

export const NoToken: Story = () => (
  <GithubSettingsDialog
    settings={{ hasToken: false, pollIntervalSecs: 300 }}
    onSaveToken={resolve}
    onClearToken={resolve}
    onSavePollInterval={resolve}
    onClose={noop}
  />
);

export const TokenConfigured: Story = () => (
  <GithubSettingsDialog
    settings={{ hasToken: true, pollIntervalSecs: 300 }}
    onSaveToken={resolve}
    onClearToken={resolve}
    onSavePollInterval={resolve}
    onClose={noop}
  />
);
