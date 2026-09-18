import type { Story } from '@ladle/react';

import { sampleProfiles } from '../../.ladle/data';
import { NewAgentDialog } from './NewAgentDialog';

const noop = () => undefined;
const resolveCreate = () => Promise.resolve();

export const Open: Story = () => (
  <NewAgentDialog models={sampleProfiles} onCreate={resolveCreate} onClose={noop} onManageModels={noop} />
);

export const NoProfiles: Story = () => (
  <NewAgentDialog models={[]} onCreate={resolveCreate} onClose={noop} onManageModels={noop} />
);
