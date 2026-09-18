import type { Story } from '@ladle/react';

import { NameDialog } from './NameDialog';

const noop = () => undefined;
const resolveSubmit = () => Promise.resolve();

export const ForkAgent: Story = () => (
  <NameDialog
    title="Fork agent"
    placeholder="fix-auth-bug-2"
    submitLabel="Fork"
    onSubmit={resolveSubmit}
    onClose={noop}
  />
);

export const SideConversation: Story = () => (
  <NameDialog
    title="Side conversation"
    placeholder="quick-question"
    submitLabel="Open"
    onSubmit={resolveSubmit}
    onClose={noop}
  />
);
