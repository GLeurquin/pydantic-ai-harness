import type { Story } from '@ladle/react';

import { NewAgentDialog } from './NewAgentDialog';

const noop = () => undefined;
const resolveCreate = () => Promise.resolve();

export const Open: Story = () => <NewAgentDialog onCreate={resolveCreate} onClose={noop} />;
